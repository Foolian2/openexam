/**
 * Placeholder handling for FILL_IN_THE_BLANK templates: `{1}`, `{2}`, … mark
 * the blanks, and each number is the id of a config blank. The student
 * viewer splits on the same pattern.
 */
const PLACEHOLDER_RE = /\{(\d+)\}/g

/** Every placeholder id in template order, duplicates included. */
export function placeholderIds(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER_RE)].map((m) => m[1]!)
}

/** The distinct placeholder ids, sorted numerically. */
export function parseBlankIds(template: string): string[] {
  return [...new Set(placeholderIds(template))].sort(
    (a, b) => parseInt(a) - parseInt(b)
  )
}

/**
 * Id for a newly inserted blank: one past the highest id in use. Counting
 * the blanks instead reuses an id as soon as one in the middle is deleted
 * ({1} {3} + insert → a second {3}), and two placeholders sharing an id
 * render as two inputs bound to the same answer.
 */
export function nextBlankId(template: string): string {
  const ids = placeholderIds(template).map((id) => parseInt(id))
  return String(ids.length === 0 ? 1 : Math.max(...ids) + 1)
}
