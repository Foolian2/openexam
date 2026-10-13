import { gradeWithRetry } from "@/lib/grading/grade-with-retry"
import { prisma } from "@/lib/prisma"
import { createAuditLog } from "@/lib/audit"
import { redis } from "@/lib/redis"
import { logError } from "@/lib/logger"
import { wsAnswersHashKey } from "@/lib/ws-answer-buffer"
import { Prisma } from "@/generated/prisma/client"

export interface ControlMessage {
  type: "SESSION_SUBMITTED" | "EXAM_CLOSED" | string // keep it string-typed; the hub parses type/sessionId/effectiveEndTime/timeExtensionMin
  sessionId?: string
}

export interface FinalizeAudit {
  action: string
  entityType: string
  entityId: string
  examId?: string
  userId: string
  metadata?: Prisma.InputJsonValue
  ipAddress?: string
}

export interface FinalizeSessionInput {
  examId: string
  sessionIds: string[]
  control: ControlMessage
  audit: FinalizeAudit
  /**
   * Stable identity of this finalization event. A re-run with the same key
   * (crash recovery, submit replay) writes no second audit row and skips a
   * control message that was already published.
   */
  dedupeKey?: string
  gradingBatchSize?: number // default 5 (matches the close route's GRADING_BATCH_SIZE)
}

/**
 * Grades every session in batches of `batchSize`, never throwing.
 *
 * gradeWithRetry is contractually never-throwing, so this is defense in
 * depth. It matters because a plain `Promise.all` per batch would let one
 * rejection abort the whole loop via the caller's try/catch, silently
 * skipping every session in later batches — `Promise.allSettled` keeps each
 * session (and each batch) independent instead.
 */
async function gradeInBatches(
  sessionIds: string[],
  batchSize: number,
  logLabel: string
): Promise<void> {
  const size = Math.max(1, batchSize)
  for (let i = 0; i < sessionIds.length; i += size) {
    const batch = sessionIds.slice(i, i + size)
    const results = await Promise.allSettled(
      batch.map((sessionId) => gradeWithRetry(sessionId))
    )
    for (const result of results) {
      if (result.status === "rejected") {
        logError(`${logLabel} grading failed`, {
          reason:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        })
      }
    }
  }
}

/**
 * Post-commit finalization: grade (with retry, never throws) → publish the
 * control message to Redis (swallow failures — WS server may not be running)
 * → write the audit log (never throws). Ordering is load-bearing: grading
 * first so the review route and monitors see grades as soon as possible.
 */
export async function finalizeSession(
  input: FinalizeSessionInput
): Promise<void> {
  // Ordering is load-bearing: the WebSocket backend only flips its
  // per-session answer:save gate when it processes the control message, so
  // the gate must be armed (commit-time Redis flag + control publish) and
  // the answer buffer drained BEFORE grading reads the answers. Publishing
  // after grading lets a student push answer:save frames in the gap between
  // the submit commit and the room processing SESSION_SUBMITTED, have them
  // force-flushed into Postgres, and then change their own auto-grade by
  // replaying the idempotent submit (which regrades).
  try {
    await Promise.all(
      input.sessionIds.map((sessionId) =>
        redis.set(`ws:submitted:${sessionId}`, "1", "EX", 3600)
      )
    )
  } catch {
    // Non-fatal: the in-memory room gate still flips on the control message.
  }
  await publishControlOnce(input)
  await waitForAnswerBufferDrain(input.examId, input.sessionIds)
  await gradeInBatches(
    input.sessionIds,
    input.gradingBatchSize ?? 5,
    "session finalization"
  )
  await createAuditLog({
    action: input.audit.action,
    entityType: input.audit.entityType,
    entityId: input.audit.entityId,
    examId: input.audit.examId,
    userId: input.audit.userId,
    metadata: input.audit.metadata,
    ipAddress: input.audit.ipAddress,
    idempotencyKey: input.dedupeKey,
  })
}

/**
 * Publishes the control message, skipping it when a previous run with the same
 * dedupeKey already published. The marker is written only after a successful
 * publish, so a crash before publishing still lets the retry deliver it; the
 * remaining duplicate window is a crash between publish and marker write.
 */
async function publishControlOnce(input: FinalizeSessionInput): Promise<void> {
  const marker = input.dedupeKey
    ? `finalize:published:${input.dedupeKey}`
    : undefined
  try {
    if (marker && (await redis.exists(marker)) === 1) return
    await redis.publish(
      `exam:${input.examId}:control`,
      JSON.stringify(input.control)
    )
    if (marker) await redis.set(marker, "1", "EX", 86_400, "NX")
  } catch {
    // Non-fatal: WebSocket server may not be running in dev
  }
}

/**
 * Waits (bounded) until the WS answer buffer no longer holds entries for the
 * given sessions — i.e. the force-flush triggered by the control message has
 * landed in Postgres — so grading reads the final answers. Never throws: on
 * timeout or Redis failure grading proceeds anyway (gradeWithRetry and the
 * review route's safety net keep the session recoverable).
 */
async function waitForAnswerBufferDrain(
  examId: string,
  sessionIds: string[],
  timeoutMs = 8000
): Promise<void> {
  const hashKey = wsAnswersHashKey(examId)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let fields: string[]
    try {
      fields = await redis.hkeys(hashKey)
    } catch {
      return
    }
    const pending = fields.filter((f) =>
      sessionIds.some((s) => f.startsWith(`${s}:`))
    )
    if (pending.length === 0) return
    await new Promise((r) => setTimeout(r, 200))
  }
}

/**
 * Grade-only variant for the safety net (POST /api/exams/[id]/ensure-graded),
 * which backfills submitted sessions a crash left without grades.
 */
export async function gradeSessions(
  sessionIds: string[],
  batchSize = 5
): Promise<void> {
  await gradeInBatches(sessionIds, batchSize, "safety-net session")
}

/**
 * Regrades the matching sessions whose grades predate a late-flushed answer
 * (`needsRegrade`, set by the ws-backend flusher). Every page, print, export
 * and publish step that shows grades calls this first, so stale points never
 * leave the server just because nobody opened a review view.
 */
export async function regradeFlaggedSessions(
  where: Prisma.ExamSessionWhereInput
): Promise<void> {
  const flagged = await prisma.examSession.findMany({
    where: { ...where, needsRegrade: true },
    select: { id: true },
  })
  if (flagged.length > 0) await gradeSessions(flagged.map((s) => s.id))
}
