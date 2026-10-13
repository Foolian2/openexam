import { NextRequest, NextResponse } from "next/server"
import { forbidden } from "@/lib/api-response"

/**
 * Session cookies alone don't prove a mutating request came from our own
 * frontend, so state-changing routes must check Origin explicitly. Reuses
 * ALLOWED_ORIGINS (already set for ws-backend's WebSocket origin check, see
 * ws-backend/internal/config/config.go) so both sides agree on one allowlist.
 * Falls back to the app's own configured URL when ALLOWED_ORIGINS isn't set,
 * so this doesn't require new infra config to work in dev/docker-compose.
 */
export function allowedOrigins(): string[] {
  const raw = process.env.ALLOWED_ORIGINS
  if (raw) {
    return raw
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  }

  const fallback = [
    process.env.NEXT_PUBLIC_BASE_URL,
    process.env.BETTER_AUTH_URL,
  ].filter((origin): origin is string => Boolean(origin))
  if (fallback.length > 0) return fallback

  return process.env.NODE_ENV === "production" ? [] : ["http://localhost:3000"]
}

/**
 * True when the Origin matches an allowlist entry. Compared via `new URL().origin`
 * so scheme/host casing, trailing slashes and explicit default ports can't mask
 * a (mis)match — proxy.ts and verifyOrigin must agree on the same request.
 */
export function isOriginAllowed(origin: string): boolean {
  return allowedOrigins().some((allowed) => {
    try {
      return new URL(origin).origin === new URL(allowed).origin
    } catch {
      return false
    }
  })
}

/** Returns an error response if the request's Origin isn't allowed, else null. */
export function verifyOrigin(request: NextRequest): NextResponse | null {
  const origin = request.headers.get("origin")
  if (!origin || !isOriginAllowed(origin)) {
    return forbidden("Ungültiger Origin")
  }
  return null
}
