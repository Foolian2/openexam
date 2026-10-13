import { redis } from "@/lib/redis"
import { prisma } from "@/lib/prisma"
import { logError } from "@/lib/logger"
import { answerContentSchema } from "@/lib/validators/answer"
import type { AnswerContentInput } from "@/lib/validators/answer"

/**
 * Next.js side of ws-backend's write-behind answer buffer
 * (ws-backend/internal/store/buffer.go). An answer saved over the WebSocket is
 * acked once it is in this Redis hash and only reaches Postgres on the next
 * flush (FLUSH_INTERVAL, 5s by default). Key and field formats must match
 * answersHashKey and fieldKey there.
 */
export function wsAnswersHashKey(examId: string): string {
  return `exam:${examId}:answers`
}

export function wsAnswerField(sessionId: string, questionId: string): string {
  return `${sessionId}:${questionId}`
}

export interface BufferedAnswer {
  questionId: string
  content: AnswerContentInput
  clientSeq: number | null
}

/**
 * Reads the session's answers that are acked but not yet flushed. Fails open:
 * a Redis error returns no entries, and the caller serves Postgres alone, as
 * it did before this existed.
 */
export async function readBufferedAnswers(
  examId: string,
  sessionId: string,
  questionIds: string[]
): Promise<BufferedAnswer[]> {
  if (questionIds.length === 0) return []
  let raw: (string | null)[]
  try {
    raw = await redis.hmget(
      wsAnswersHashKey(examId),
      ...questionIds.map((q) => wsAnswerField(sessionId, q))
    )
  } catch (err) {
    logError("ws answer buffer read failed", {
      err: err instanceof Error ? err.message : String(err),
    })
    return []
  }

  const out: BufferedAnswer[] = []
  raw.forEach((value, i) => {
    if (!value) return
    try {
      const entry = JSON.parse(value) as {
        content?: unknown
        clientSeq?: unknown
      }
      const content = answerContentSchema.safeParse(entry.content)
      if (!content.success) return
      out.push({
        questionId: questionIds[i]!,
        content: content.data,
        clientSeq: typeof entry.clientSeq === "number" ? entry.clientSeq : null,
      })
    } catch {
      // A malformed entry is the flusher's problem; serve Postgres for it.
    }
  })
  return out
}

/**
 * Overlays buffered answers on the Postgres rows with the flusher's own
 * predicate (flushAnswerSQL): the buffered value wins when either side has no
 * clientSeq or Postgres holds an older one. Without this, a reload within the
 * flush window shows an acked answer as missing — or an older answer than the
 * one that will be graded.
 */
export function overlayBufferedAnswers<
  T extends { questionId: string; content: unknown; clientSeq: number | null },
>(stored: T[], buffered: BufferedAnswer[]): (T | BufferedAnswer)[] {
  const byQuestion = new Map<string, T | BufferedAnswer>(
    stored.map((a) => [a.questionId, a])
  )
  for (const b of buffered) {
    const current = byQuestion.get(b.questionId)
    if (
      !current ||
      b.clientSeq === null ||
      current.clientSeq === null ||
      current.clientSeq < b.clientSeq
    ) {
      byQuestion.set(b.questionId, { ...current, ...b })
    }
  }
  return [...byQuestion.values()]
}

/**
 * A session's saved answers for the exam-taking client: Postgres rows with
 * acked-but-unflushed buffer entries overlaid.
 *
 * Redis is read BEFORE Postgres on purpose. The flusher deletes a buffer
 * field only after its Postgres commit (and only if unchanged), so an entry
 * missing from the buffer at read time is already committed and visible to
 * the read that follows. In the other order a flush landing between the two
 * reads served the pre-flush row with an empty buffer: the stale answer this
 * overlay exists to prevent.
 */
export async function loadSessionAnswers({
  examId,
  sessionId,
  questionIds,
  live,
}: {
  examId: string
  sessionId: string
  questionIds: string[]
  /** Only a live session can still have unflushed saves. */
  live: boolean
}) {
  const buffered = live
    ? await readBufferedAnswers(examId, sessionId, questionIds)
    : []
  const stored = await prisma.answer.findMany({
    where: { sessionId },
    select: {
      questionId: true,
      content: true,
      version: true,
      clientSeq: true,
      updatedAt: true,
    },
  })
  return overlayBufferedAnswers(stored, buffered)
}
