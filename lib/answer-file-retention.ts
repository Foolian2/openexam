import { randomUUID } from "node:crypto"
import { prisma } from "@/lib/prisma"
import { Prisma } from "@/generated/prisma/client"
import { redis } from "@/lib/redis"
import { logError } from "@/lib/logger"
import { SUBMITTED_STATUSES } from "@/lib/session-state"
import { answerFileBytesPruned, answerFilesPruned } from "@/lib/metrics"

/**
 * Retention for superseded attachments (PRODUCT-RISK-DECISIONS R2).
 *
 * Upload only stages bytes; the REST autosave or the WS buffer commits the
 * answer's fileKey separately, so a replaced or abandoned upload stays behind
 * as an AnswerFile row that no answer points at. Deleting one while the
 * student can still write would reopen a data-loss bug (a
 * replacement whose pointer never landed), so a row is deleted only when ALL
 * of these hold:
 *
 * - its session is submitted (terminal): REST and WS refuse further saves;
 * - the session has no pending finalization (deadlineFinalizationPending);
 * - it was submitted more than SETTLE_MS ago, far beyond finalization's 8 s
 *   buffer drain;
 * - the exam's Redis answer buffer holds nothing for that session (a stalled
 *   WS flusher could still land a pre-submit save); if Redis can't be read,
 *   the run is skipped;
 * - no Answer row of that session and question has content.fileKey = key.
 *
 * The last three are re-checked inside the DELETE itself. In-progress and
 * LOCKED sessions are never touched.
 */
export const RETENTION_SETTLE_MS = 15 * 60_000
const BATCH_SIZE = 200
const MAX_BATCHES_PER_RUN = 10
const LOCK_KEY = "answer-file-retention:lock"
const LOCK_TTL_SECONDS = 300
const RELEASE_LOCK = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`

type Candidate = { key: string; sessionId: string; examId: string }

function eligible(cutoff: Date): Prisma.Sql {
  return Prisma.sql`
    s."status"::text IN (${Prisma.join(SUBMITTED_STATUSES)})
    AND s."deadlineFinalizationPending" = false
    AND s."submittedAt" IS NOT NULL
    AND s."submittedAt" < ${cutoff}
    AND NOT EXISTS (
      SELECT 1 FROM "Answer" a
      WHERE a."sessionId" = f."sessionId"
        AND a."questionId" = f."questionId"
        AND a."content"->>'fileKey' = f."key"
    )`
}

/** Sessions that still have answers waiting in the WS Redis buffer. */
async function sessionsWithBufferedAnswers(
  candidates: Candidate[]
): Promise<Set<string>> {
  const busy = new Set<string>()
  const examIds = [...new Set(candidates.map((c) => c.examId))]
  for (const examId of examIds) {
    // Fields are "<sessionId>:<questionId>" (see finalize-session.ts drain).
    const fields = await redis.hkeys(`exam:${examId}:answers`)
    for (const field of fields) {
      const sep = field.indexOf(":")
      busy.add(sep === -1 ? field : field.slice(0, sep))
    }
  }
  return busy
}

async function pruneBatch(
  now: Date,
  skipSessions: Set<string>
): Promise<{ files: number; bytes: number; scanned: number }> {
  const cutoff = new Date(now.getTime() - RETENTION_SETTLE_MS)
  // Sessions found busy earlier in this run are excluded, so their rows can't
  // fill every batch and starve the eligible files behind them.
  const skip =
    skipSessions.size > 0
      ? Prisma.sql`AND f."sessionId" NOT IN (${Prisma.join([...skipSessions])})`
      : Prisma.empty
  const candidates = await prisma.$queryRaw<Candidate[]>(Prisma.sql`
    SELECT f."key", f."sessionId", s."examId"
    FROM "AnswerFile" f
    JOIN "ExamSession" s ON s."id" = f."sessionId"
    WHERE ${eligible(cutoff)}
    ${skip}
    ORDER BY f."createdAt"
    LIMIT ${BATCH_SIZE}
  `)
  if (candidates.length === 0) return { files: 0, bytes: 0, scanned: 0 }

  const busy = await sessionsWithBufferedAnswers(candidates)
  for (const sessionId of busy) skipSessions.add(sessionId)
  const keys = candidates
    .filter((c) => !busy.has(c.sessionId))
    .map((c) => c.key)
  if (keys.length === 0) {
    return { files: 0, bytes: 0, scanned: candidates.length }
  }

  const deleted = await prisma.$queryRaw<{ sizeBytes: number }[]>(Prisma.sql`
    DELETE FROM "AnswerFile" f
    USING "ExamSession" s
    WHERE s."id" = f."sessionId"
      AND f."key" IN (${Prisma.join(keys)})
      AND ${eligible(cutoff)}
    RETURNING f."sizeBytes"
  `)
  return {
    files: deleted.length,
    bytes: deleted.reduce((sum, r) => sum + r.sizeBytes, 0),
    scanned: candidates.length,
  }
}

/**
 * One bounded retention run. Returns the number of files deleted. Holds a
 * token-owned Redis lease so only one replica prunes at a time.
 */
export async function sweepSupersededAnswerFiles(
  now = new Date()
): Promise<number> {
  const token = randomUUID()
  const lease = await redis.set(LOCK_KEY, token, "EX", LOCK_TTL_SECONDS, "NX")
  if (lease !== "OK") return 0
  let total = 0
  const skipSessions = new Set<string>()
  try {
    for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
      const { files, bytes, scanned } = await pruneBatch(now, skipSessions)
      total += files
      answerFilesPruned.inc(files)
      answerFileBytesPruned.inc(bytes)
      // A short batch means the eligible rows are exhausted. A full batch,
      // even one that deleted nothing (all busy), continues past the skipped
      // sessions.
      if (scanned < BATCH_SIZE) break
    }
    return total
  } finally {
    await redis.eval(RELEASE_LOCK, 1, LOCK_KEY, token)
  }
}

const runtime = globalThis as typeof globalThis & {
  answerFileRetentionTimer?: ReturnType<typeof setInterval>
}

/** Persistent Node runtime only; an unref'ed timer cannot hold shutdown open. */
export function startAnswerFileRetention(): void {
  if (
    process.env.ANSWER_FILE_RETENTION_ENABLED === "false" ||
    runtime.answerFileRetentionTimer
  )
    return
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      await sweepSupersededAnswerFiles()
    } catch (err) {
      // A Redis or database error skips this run; nothing is deleted on a
      // partial view.
      logError("answer file retention: run failed", { err })
    } finally {
      running = false
    }
  }
  runtime.answerFileRetentionTimer = setInterval(() => {
    void tick()
  }, 10 * 60_000)
  runtime.answerFileRetentionTimer.unref()
}
