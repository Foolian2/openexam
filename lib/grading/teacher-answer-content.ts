import { matchingRightId } from "@/lib/exam-session"
import { asTypedQuestion, type MatchingConfig } from "@/lib/types/questions"

/**
 * Stored MATCHING answers reference opaque per-session right ids. Translate
 * them back to pair ids so the teacher UI (which works with the raw config)
 * can render the student's ordering. No-op for every other question type.
 */
export function toTeacherAnswerContent(
  content: unknown,
  question: { id: string; type: string; config: unknown } | undefined,
  sessionId: string
): unknown {
  if (!question) return content
  const q = asTypedQuestion(question)
  if (q.type !== "MATCHING") return content
  const c: MatchingConfig | null = q.config
  if (!c || !Array.isArray(c.pairs)) return content
  const seed = `${sessionId}:${question.id}`
  const pairIdByRightId = new Map(
    c.pairs.map((p) => [matchingRightId(seed, p.id), p.id])
  )
  const matches =
    (content as { matches?: { leftId: string; rightId: string }[] })?.matches ??
    []
  return {
    type: "MATCHING",
    matches: matches.map((m) => ({
      leftId: m.leftId,
      rightId: pairIdByRightId.get(m.rightId) ?? m.rightId,
    })),
  }
}
