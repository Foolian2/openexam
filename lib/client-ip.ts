import type { NextRequest } from "next/server"

/**
 * Resolves the client IP for audit logging.
 *
 * In production, nginx is the single edge proxy and overwrites both
 * `X-Forwarded-For` and `X-Real-IP` with `$remote_addr` (see
 * nginx/nginx.conf), so they carry exactly one value that cannot be forged by
 * the client. The first X-Forwarded-For entry is taken defensively in case a
 * future proxy layer appends; with the current nginx config there is only
 * ever one entry.
 *
 * In development there is no nginx, so both headers are absent and the helper
 * returns null — audit IPs are a production-proxy property.
 */
export function getClientIp(
  request: Pick<NextRequest, "headers"> | { headers: Headers }
): string | null {
  const xff = request.headers.get("x-forwarded-for")
  if (xff) {
    const first = xff.split(",")[0]?.trim()
    if (first) return first
  }
  return request.headers.get("x-real-ip")?.trim() || null
}
