/**
 * Base origin of this app as seen by SEB clients. Reads NEXT_PUBLIC_BASE_URL.
 *
 * The dev fallback is deliberately permissive: every request path that
 * derives an absolute URL defaults to localhost, and only lib/auth.ts
 * refuses to boot in production without the variable set.
 */
export function sebBaseUrl(
  env: Record<string, string | undefined> = process.env
): string {
  // `||`, not `??`: a present-but-empty NEXT_PUBLIC_BASE_URL must fall back
  // too, mirroring ws-backend/internal/config/config.go's firstNonEmpty
  // (which treats "" as unset). Otherwise a blank env var yields a relative
  // takeUrl() here while the Go verifier hashes against localhost, and every
  // SEB handshake fails with invalid_token.
  return env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"
}

/**
 * The hashed-token subject URL: the take page's absolute URL.
 *
 * This is the URL SEB's Config Key token is computed against (see
 * lib/seb-key.ts's configKeyTokenForUrl), so every site that builds it —
 * the request guard, the take page, and the Go verifier — must derive it
 * from one formula or their tokens silently stop matching.
 */
export function takeUrl(
  examId: string,
  env: Record<string, string | undefined> = process.env
): string {
  return `${sebBaseUrl(env)}/exam/${examId}/take`
}

/** Path of an exam's shared-start waiting room. */
export function waitPath(examId: string): string {
  return `/exam/${examId}/wait`
}

/**
 * The absolute URL of the waiting room: the per-URL Config Key token subject
 * when SEB sends its native header on that page (see verifySebAccess).
 */
export function waitUrl(
  examId: string,
  env: Record<string, string | undefined> = process.env
): string {
  return `${sebBaseUrl(env)}${waitPath(examId)}`
}

/**
 * The absolute URL of an incoming request as the *client* addressed it.
 *
 * Never use `request.url` for this. Behind nginx the web container reports its
 * own internal bind address, so `request.url` is `http://0.0.0.0:3000/...`
 * while SEB hashed `https://openexam.ch/...`. That mismatch silently broke the
 * per-URL Config Key candidate for every student on Windows — where SEB's
 * native X-SafeExamBrowser-ConfigKeyHash header overwrites the take-page token
 * lib/seb-client.ts sends, making the per-URL candidate the only one that can
 * match — so every /api/sessions/* call answered 403 "Safe Exam Browser
 * erforderlich". macOS was unaffected (WKWebView cannot send the header, so
 * the take-page candidate carried it), which is why this hid for so long.
 *
 * Path and query come from the request; only the origin is substituted.
 */
export function publicRequestUrl(
  request: { nextUrl: { pathname: string; search: string } },
  env: Record<string, string | undefined> = process.env
): string {
  return `${sebBaseUrl(env)}${request.nextUrl.pathname}${request.nextUrl.search}`
}

/**
 * Like sebBaseUrl, but refuses a missing NEXT_PUBLIC_BASE_URL instead of
 * falling back to localhost.
 *
 * Intended for offline scripts (e.g. scripts/regenerate-seb-config-keys.ts):
 * the Config Key hashes the exam's absolute URLs, so a wrong origin here
 * silently produces keys that no SEB client will ever match.
 */
export function requireSebBaseUrl(
  env: Record<string, string | undefined> = process.env
): string {
  const baseUrl = env.NEXT_PUBLIC_BASE_URL
  if (!baseUrl) {
    throw new Error(
      "NEXT_PUBLIC_BASE_URL must be set — the Config Key hashes the exam's absolute URLs, so a wrong origin here silently produces keys that no SEB client will ever match."
    )
  }
  return baseUrl
}
