"use client"

/**
 * Wraps occurrences of teacher-configured expected keywords in <mark> inside
 * a sanitized HTML answer, so they pop during manual grading.
 *
 * Operates on text nodes only (never tag/attribute names) and skips nodes
 * that are already inside a <mark>. Matches are whole-word and
 * case-insensitive.
 */

function keywordRegexes(keywords: string[]): RegExp[] {
  const regexes: RegExp[] = []
  for (const kw of keywords) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    if (!escaped) continue
    regexes.push(
      new RegExp(`(?<![\\p{L}\\p{N}])(${escaped})(?![\\p{L}\\p{N}])`, "giu")
    )
  }
  return regexes
}

/** Highlight keyword occurrences in a live DOM subtree (after hydration). */
export function highlightKeywordsInElement(
  root: HTMLElement,
  keywords: string[]
): void {
  if (!keywords?.length || !root.textContent?.trim()) return
  const regexes = keywordRegexes(keywords)
  if (!regexes.length) return

  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement
        if (!parent || parent.closest("mark, script, style")) {
          return NodeFilter.FILTER_REJECT
        }
        return NodeFilter.FILTER_ACCEPT
      },
    }
  )

  const textNodes: Text[] = []
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text)

  for (const node of textNodes) {
    const matches: { start: number; end: number }[] = []
    for (const re of regexes) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(node.data))) {
        matches.push({ start: m.index, end: m.index + m[0].length })
      }
    }
    if (!matches.length) continue
    // De-duplicate overlapping matches (e.g. "der" vs "deren").
    matches.sort((a, b) => a.start - b.start)
    const unique = matches.filter(
      (m, i) => i === 0 || m.start >= matches[i - 1].end
    )
    if (!unique.length) continue

    // Split from the end so earlier offsets stay valid on the leading node.
    for (let i = unique.length - 1; i >= 0; i--) {
      const { start, end } = unique[i]
      if (end > node.data.length) continue
      const prefix = node.data.slice(0, start)
      const matched = node.data.slice(start, end)
      const suffix = node.data.slice(end)
      node.data = prefix
      const mark = root.ownerDocument.createElement("mark")
      mark.textContent = matched
      node.after(mark, root.ownerDocument.createTextNode(suffix))
    }
  }
}
