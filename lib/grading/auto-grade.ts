import { matchingRightId } from "@/lib/exam-session"
import type { QuestionType } from "@/lib/validators/question"
import type {
  QuestionConfig,
  MatchingConfig,
  TrueFalseConfig,
  ShortAnswerConfig,
  OrderingConfig,
} from "@/lib/types/questions"
import type { AnswerContentInput } from "@/lib/validators/answer"

export interface AutoGradeResult {
  points: number
  autoGraded: true
}

/**
 * Grades objectively gradable question types. Returns null for types that
 * need manual grading (FREE_TEXT, FILE_UPLOAD, CODE) or on type mismatch.
 *
 * - MULTIPLE_CHOICE: all-or-nothing on the exact set of correct options
 * - FILL_IN_THE_BLANK: proportional per correct blank
 * - MATCHING: proportional per correct pair
 * - TRUE_FALSE: all-or-nothing on the selected boolean
 * - SHORT_ANSWER: all-or-nothing on exact (trimmed, optionally
 *   case-insensitive) match against any accepted answer
 * - ORDERING: proportional per correctly-placed item
 */
export function autoGrade(
  type: QuestionType,
  config: unknown,
  content: AnswerContentInput | null,
  maxPoints: number,
  opts?: { matchingSeed?: string }
): AutoGradeResult | null {
  // The config column is validated on write, so it is trusted here; this
  // pairs it with its type so each case below gets the right config shape.
  const q = { type, config } as QuestionConfig
  switch (q.type) {
    case "MULTIPLE_CHOICE": {
      const c = q.config
      if (content !== null && content.type !== "MULTIPLE_CHOICE") return null
      const selected = new Set(content?.selectedOptionIds ?? [])
      const correct = new Set(
        c.options.filter((o) => o.isCorrect).map((o) => o.id)
      )
      const exact =
        selected.size === correct.size &&
        [...correct].every((id) => selected.has(id))
      return { points: exact ? maxPoints : 0, autoGraded: true }
    }
    case "FILL_IN_THE_BLANK": {
      const c = q.config
      if (content !== null && content.type !== "FILL_IN_THE_BLANK") return null
      const given = new Map((content?.blanks ?? []).map((b) => [b.id, b.value]))
      let correctCount = 0
      for (const blank of c.blanks) {
        // NFC-normalize both sides: a decomposed "Zürich" (u + combining
        // umlaut, which macOS/iOS keyboards emit) must match a composed
        // accepted answer, otherwise correct answers silently score 0.
        const value = (given.get(blank.id) ?? "").normalize("NFC").trim()
        const accepted = blank.acceptedAnswers.map((a) =>
          a.normalize("NFC").trim()
        )
        const hit = blank.caseSensitive
          ? accepted.includes(value)
          : accepted.some((a) => a.toLowerCase() === value.toLowerCase())
        if (hit) correctCount++
      }
      const fraction = c.blanks.length > 0 ? correctCount / c.blanks.length : 0
      return {
        points: proportionalPoints(maxPoints, fraction),
        autoGraded: true,
      }
    }
    case "MATCHING": {
      const c: MatchingConfig | null = q.config
      if (content !== null && content.type !== "MATCHING") return null
      // Without the seed the submitted (opaque) right ids can't be verified;
      // a malformed config can't be graded either.
      if (!opts?.matchingSeed || !c || !Array.isArray(c.pairs)) return null
      const seed = opts.matchingSeed
      const pairIds = new Set(c.pairs.map((p) => p.id))
      // Count each config pair at most once and ignore fabricated ids, so
      // duplicated/forged matches can never push the score past maxPoints.
      const graded = new Set<string>()
      let correctCount = 0
      for (const m of content?.matches ?? []) {
        if (!pairIds.has(m.leftId) || graded.has(m.leftId)) continue
        graded.add(m.leftId)
        if (m.rightId === matchingRightId(seed, m.leftId)) correctCount++
      }
      const fraction = c.pairs.length > 0 ? correctCount / c.pairs.length : 0
      return {
        points: proportionalPoints(maxPoints, fraction),
        autoGraded: true,
      }
    }
    case "TRUE_FALSE": {
      const c: TrueFalseConfig | null = q.config
      if (content !== null && content.type !== "TRUE_FALSE") return null
      if (!c || typeof c.isCorrect !== "boolean") return null
      // Missing answer is graded as 0 (no selection can't be correct).
      const selected = content?.selected
      if (selected === undefined) return { points: 0, autoGraded: true }
      return {
        points: selected === c.isCorrect ? maxPoints : 0,
        autoGraded: true,
      }
    }
    case "SHORT_ANSWER": {
      const c: ShortAnswerConfig | null = q.config
      if (content !== null && content.type !== "SHORT_ANSWER") return null
      if (
        !c ||
        !Array.isArray(c.acceptedAnswers) ||
        !c.acceptedAnswers.every((a) => typeof a === "string")
      )
        return null
      const value = (content?.text ?? "").normalize("NFC").trim()
      if (!value) return { points: 0, autoGraded: true }
      // NFC-normalize both sides so a decomposed submission matches a composed
      // accepted answer (see the FILL_IN_THE_BLANK note above).
      const accepted = c.acceptedAnswers.map((a) => a.normalize("NFC").trim())
      const hit = c.caseSensitive
        ? accepted.includes(value)
        : accepted.some((a) => a.toLowerCase() === value.toLowerCase())
      return { points: hit ? maxPoints : 0, autoGraded: true }
    }
    case "ORDERING": {
      const c: OrderingConfig | null = q.config
      if (content !== null && content.type !== "ORDERING") return null
      if (!c || !Array.isArray(c.items)) return null
      const orderedIds = content?.orderedIds ?? []
      // Only count positions that hold the correct item id. Extra submitted
      // ids beyond the configured length are ignored; missing ids are
      // simply not correct.
      let correctCount = 0
      for (let i = 0; i < c.items.length && i < orderedIds.length; i++) {
        if (orderedIds[i] === c.items[i].id) correctCount++
      }
      const fraction = c.items.length > 0 ? correctCount / c.items.length : 0
      return {
        points: proportionalPoints(maxPoints, fraction),
        autoGraded: true,
      }
    }
    default:
      return null
  }
}

/** Preserve full credit and bound half-point rounding by the actual maximum. */
function proportionalPoints(maxPoints: number, fraction: number): number {
  if (fraction >= 1) return maxPoints
  return Math.min(
    maxPoints,
    Math.max(0, Math.round(maxPoints * fraction * 2) / 2)
  )
}
