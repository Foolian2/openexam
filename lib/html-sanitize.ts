import sanitizeHtml from "sanitize-html"

/**
 * Allowlist for student-authored rich-text answers (FREE_TEXT with
 * `richText` enabled). Everything else — scripts, event handlers, inline
 * styles, media, iframes — is stripped before the HTML is ever rendered in
 * a teacher- or student-facing view.
 */
const ALLOWED_TAGS = [
  "p",
  "br",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "strike",
  "ul",
  "ol",
  "li",
  "blockquote",
  "code",
  "pre",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "a",
  "hr",
  "mark",
  "sub",
  "sup",
]

// `target`/`rel` are not student-settable: they are overwritten below so an
// answer link can never keep a window handle on the grading view.
const ALLOWED_ATTR = ["href", "title", "target", "rel"]

/** Sanitize arbitrary HTML so it is safe to render with innerHTML. */
export function sanitizeRichText(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: { a: ALLOWED_ATTR },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: {},
    // `//evil.example` inherits the page scheme and slips past an
    // http/https/mailto allowlist, so protocol-relative hrefs are dropped.
    allowProtocolRelative: false,
    transformTags: {
      // A student answer is rendered in the teacher's grading view. Any link
      // in it opens in a new tab that must not be able to navigate the
      // opener (reverse tabnabbing) or pass referrer/ranking signals on.
      a: sanitizeHtml.simpleTransform("a", {
        target: "_blank",
        rel: "noopener noreferrer nofollow",
      }),
    },
  })
}

/** True when the string contains a plausible HTML tag. */
export function looksLikeHtml(value: string): boolean {
  return /<[a-z!][^>]*>/i.test(value)
}

/** Escape a plain-text string so it can be embedded in HTML safely. */
export function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/** Approximate visible-text length of an HTML answer (tags excluded). */
export function richTextLength(html: string): number {
  return html.replace(/<[^>]*>/g, "").length
}
