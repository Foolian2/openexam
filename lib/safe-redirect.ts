/**
 * Validates a post-login return path taken from user-controllable input
 * (the `?next=` query parameter).
 *
 * Returns the path unchanged when it is a same-origin absolute path, and null
 * otherwise. Callers must treat null as "use the default destination" — never
 * as "redirect anyway".
 *
 * Rejected, and why each matters:
 *  - anything not starting with "/" — a bare "evil.com" or "https://evil.com"
 *    is an off-site redirect, which turns our login page into a credible
 *    phishing launch pad ("you really did log in to the real OpenExam").
 *  - "//evil.com" and "/\evil.com" — protocol-relative URLs. Browsers resolve
 *    both as off-site despite the leading slash, so a naive startsWith("/")
 *    check lets them straight through. This is the classic bypass.
 *  - anything containing a control character, which can truncate or split the
 *    Location header downstream.
 */
export function safeRedirectPath(next: string | null | undefined): string | null {
  if (!next) return null
  if (!next.startsWith("/")) return null
  // Second character decides protocol-relative-ness; "/" alone is fine.
  if (next.startsWith("//") || next.startsWith("/\\")) return null
  if (/[\u0000-\u001f\u007f]/.test(next)) return null
  return next
}
