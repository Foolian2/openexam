/**
 * Determines whether a persisted answer counts as "given" for progress
 * tracking (navigator, answered counter, required-question gate).
 *
 * The runner currently marks a question as answered whenever an answer
 * object exists in state, but several viewers can persist empty answers:
 * text fields that were typed and then cleared, MC selections that were
 * fully unchecked, or an upload that was replaced. Those should not count
 * as answered.
 *
 * `content` is the flat answer payload (`{ text: string }`, etc.) as used
 * by the exam runner and persisted to the server — not the `AnswerContent`
 * wrapper from lib/types/answers.ts.
 */
export function isAnswerEmpty(
  type: string,
  content: Record<string, unknown> | null | undefined
): boolean {
  if (!content) return true

  switch (type) {
    case "FREE_TEXT":
    case "SHORT_ANSWER":
      return typeof content.text !== "string" || content.text.trim() === ""
    case "MULTIPLE_CHOICE":
      return (
        !Array.isArray(content.selectedOptionIds) ||
        (content.selectedOptionIds as unknown[]).length === 0
      )
    case "FILL_IN_THE_BLANK": {
      if (!Array.isArray(content.blanks)) return true
      return (content.blanks as { value?: unknown }[]).every(
        (b) => typeof b.value !== "string" || b.value.trim() === ""
      )
    }
    case "FILE_UPLOAD":
      return typeof content.fileKey !== "string" || content.fileKey === ""
    default:
      // MATCHING, ORDERING and TRUE_FALSE always carry a complete payload
      // once saved; CODE starts from the starter code, which is a valid
      // answer in its own right.
      return false
  }
}
