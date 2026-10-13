const BLOCKED_PREFIXES = ["/login", "/register", "/verify-email"]

export function loginRedirectUrl(path: string): string {
  return `/login?next=${encodeURIComponent(path)}`
}

/**
 * Validates a redirectTo value from the login URL. Only same-origin paths are
 * allowed — protocol-relative URLs ("//evil.com"), absolute URLs and auth
 * pages themselves fall back to the default destination.
 */
export function safeRedirectTo(
  redirectTo: string | undefined,
  fallback = "/dashboard"
): string {
  if (!redirectTo) return fallback
  if (!redirectTo.startsWith("/") || redirectTo.startsWith("//"))
    return fallback
  if (redirectTo.includes("://")) return fallback
  // Browsers and Next's router treat a leading backslash as a slash, so
  // "/\evil.example" would otherwise pass the checks above yet still
  // resolve to an external, protocol-relative navigation.
  if (redirectTo.includes("\\")) return fallback
  if (
    BLOCKED_PREFIXES.some(
      (p) => redirectTo === p || redirectTo.startsWith(`${p}?`)
    )
  ) {
    return fallback
  }
  return redirectTo
}
