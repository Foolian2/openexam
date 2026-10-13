import { randomUUID } from "node:crypto"
import { prisma } from "@/lib/prisma"
import { redis } from "@/lib/redis"
import { finalizeSession } from "@/lib/finalize-session"
import { logError } from "@/lib/logger"
import { ACTIVE_STATUSES } from "@/lib/session-state"

// Recovery grace exceeds the REST/WS submit grace: terminalize five minutes
// after the deadline. This does NOT extend the answer-saving window. The
// per-session effective deadline already incorporates extensions and NAM.
export const DEADLINE_RECOVERY_GRACE_MS = 5 * 60_000
const LOCK_KEY = "deadline-sweeper:lock"
const SESSION_LOCK_PREFIX = "deadline-sweeper:session:"
const LOCK_TTL_SECONDS = 60
const LOCK_TTL_MS = LOCK_TTL_SECONDS * 1_000
const HEARTBEAT_INTERVAL_MS = 20_000
const RELEASE_LOCK = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`
const RENEW_LOCK = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0
`

async function renewLease(key: string, token: string): Promise<boolean> {
  try {
    return (await redis.eval(RENEW_LOCK, 1, key, token, LOCK_TTL_MS)) === 1
  } catch (err) {
    logError("deadline sweeper: lease renewal failed", { key, err })
    return false
  }
}

/** One bounded sweep. The durable row claim and marker own correctness. */
export async function sweepExpiredSessions(now = new Date()): Promise<number> {
  const token = randomUUID()
  const lease = await redis.set(LOCK_KEY, token, "EX", LOCK_TTL_SECONDS, "NX")
  if (lease !== "OK") return 0
  let count = 0
  let leaseLost = false
  let activeSessionLock: { key: string; token: string } | undefined
  let renewalInFlight: Promise<void> | undefined
  const heartbeat = setInterval(() => {
    if (renewalInFlight) return
    renewalInFlight = (async () => {
      if (!leaseLost) {
        if (!(await renewLease(LOCK_KEY, token))) {
          leaseLost = true
          logError("deadline sweeper: global lease lost", { key: LOCK_KEY })
        }
      }
      // If global ownership was lost during a finalizer, keep its session
      // claim alive until that in-flight finalizer returns. A successor may
      // work other sessions, but cannot finalize this same pending session.
      const sessionLock = activeSessionLock
      if (sessionLock) {
        if (!(await renewLease(sessionLock.key, sessionLock.token))) {
          leaseLost = true
          logError("deadline sweeper: session lease lost", {
            key: sessionLock.key,
          })
        }
      }
    })().finally(() => {
      renewalInFlight = undefined
    })
  }, HEARTBEAT_INTERVAL_MS)
  heartbeat.unref()
  try {
    const cutoff = new Date(now.getTime() - DEADLINE_RECOVERY_GRACE_MS)
    const candidates = await prisma.examSession.findMany({
      where: {
        OR: [
          {
            status: { in: ACTIVE_STATUSES },
            effectiveEndTime: { lte: cutoff },
          },
          {
            // The grace keeps the sweeper off rows whose claimer (a close
            // request or an earlier sweep) may still be finalizing them.
            deadlineFinalizationPending: true,
            status: { in: ["SUBMITTED", "AUTO_SUBMITTED"] },
            submittedAt: { lte: cutoff },
          },
        ],
      },
      orderBy: [{ effectiveEndTime: "asc" }, { id: "asc" }],
      take: 25,
      select: {
        id: true,
        examId: true,
        userId: true,
        submissionType: true,
        deadlineFinalizationPending: true,
      },
    })
    for (const candidate of candidates) {
      if (leaseLost) break
      // Recheck ownership at each boundary as well as on the heartbeat. This
      // avoids starting another candidate after a lease loss between ticks.
      if (!(await renewLease(LOCK_KEY, token))) {
        leaseLost = true
        logError("deadline sweeper: global lease lost", { key: LOCK_KEY })
        break
      }

      const sessionLock = {
        key: `${SESSION_LOCK_PREFIX}${candidate.id}`,
        token: randomUUID(),
      }
      let sessionLease: string | null
      try {
        sessionLease = await redis.set(
          sessionLock.key,
          sessionLock.token,
          "EX",
          LOCK_TTL_SECONDS,
          "NX"
        )
      } catch (err) {
        leaseLost = true
        logError("deadline sweeper: session lease acquisition failed", {
          sessionId: candidate.id,
          err,
        })
        break
      }
      if (sessionLease !== "OK") continue
      activeSessionLock = sessionLock

      try {
        if (leaseLost) break

        // Recheck deadline AND status at the write: a concurrent extension or
        // student/teacher submission must win without being overwritten.
        const claimed = candidate.deadlineFinalizationPending
          ? { count: 0 }
          : await prisma.examSession.updateMany({
              where: {
                id: candidate.id,
                status: { in: ACTIVE_STATUSES },
                effectiveEndTime: { lte: cutoff },
              },
              data: {
                status: "AUTO_SUBMITTED",
                submissionType: "AUTO_TIME",
                submittedAt: now,
                // Durable recovery marker if the process dies after this commit.
                needsRegrade: true,
                deadlineFinalizationPending: true,
              },
            })
        if (claimed.count === 0 && !candidate.deadlineFinalizationPending)
          continue
        count += claimed.count
        // A lost global lease after the DB claim leaves the durable marker
        // intact for the next owner instead of starting new finalization.
        if (leaseLost) continue
        try {
          await finalizeSession({
            examId: candidate.examId,
            sessionIds: [candidate.id],
            control: { type: "SESSION_SUBMITTED", sessionId: candidate.id },
            dedupeKey: `SESSION_SUBMITTED:${candidate.id}`,
            audit: {
              action: "SESSION_SUBMITTED",
              entityType: "ExamSession",
              entityId: candidate.id,
              examId: candidate.examId,
              userId: candidate.userId,
              metadata: candidate.deadlineFinalizationPending
                ? {
                    // A retried claim keeps the submission type its
                    // claimer recorded (AUTO_TIME or TEACHER_FORCED).
                    submissionType: candidate.submissionType ?? "AUTO_TIME",
                    source: "finalization-recovery",
                  }
                : { submissionType: "AUTO_TIME", source: "deadline-sweeper" },
            },
          })
          await prisma.examSession.updateMany({
            where: { id: candidate.id, deadlineFinalizationPending: true },
            data: { deadlineFinalizationPending: false },
          })
        } catch (err) {
          // Keep pending so a later sweep retries finalization after this failure.
          logError("deadline sweeper: finalization failed", {
            sessionId: candidate.id,
            err,
          })
        }
      } finally {
        // Do not race a heartbeat PEXPIRE against releasing this session key.
        if (renewalInFlight) await renewalInFlight
        activeSessionLock = undefined
        try {
          await redis.eval(RELEASE_LOCK, 1, sessionLock.key, sessionLock.token)
        } catch (err) {
          logError("deadline sweeper: session lease release failed", {
            sessionId: candidate.id,
            err,
          })
        }
      }
    }
    return count
  } finally {
    clearInterval(heartbeat)
    if (renewalInFlight) await renewalInFlight
    // Never delete another replica's lease if our sweep outlived its TTL.
    await redis.eval(RELEASE_LOCK, 1, LOCK_KEY, token)
  }
}

const runtime = globalThis as typeof globalThis & {
  deadlineSweeperTimer?: ReturnType<typeof setInterval>
}

/** Persistent Node runtime only; an unref'ed timer cannot hold shutdown open. */
export function startDeadlineSweeper(): void {
  if (
    process.env.DEADLINE_SWEEPER_ENABLED === "false" ||
    runtime.deadlineSweeperTimer
  )
    return
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      await sweepExpiredSessions()
    } catch (err) {
      logError("deadline sweeper: sweep failed", { err })
    } finally {
      running = false
    }
  }
  runtime.deadlineSweeperTimer = setInterval(() => {
    void tick()
  }, 30_000)
  runtime.deadlineSweeperTimer.unref()
  void tick()
}
