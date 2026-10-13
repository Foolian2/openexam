import { NextResponse, type NextRequest } from "next/server"
import { getClientIp } from "@/lib/client-ip"
import { rateLimit } from "@/lib/rate-limit"
import { logError } from "@/lib/logger"
import { readBoundedBytes } from "@/lib/body-size"

export const dynamic = "force-dynamic"

// Envelopes are small JSON events (a stack trace plus breadcrumbs); anything
// above this is either misconfigured capture or an attempt to buffer huge
// bodies through an unauthenticated endpoint. Bounded BEFORE the body is
// read so a giant Content-Length never even gets buffered.
const MAX_ENVELOPE_BYTES = 5 * 1024 * 1024

// Only ever forward to our own internal GlitchTip instance — never to
// whatever host a client-supplied envelope claims. Without this allowlist,
// an attacker could POST an arbitrary envelope whose embedded `dsn` field
// names any host, turning this unauthenticated route into an open SSRF
// relay. Derived from SENTRY_DSN (instrumentation.ts's server-side DSN),
// since both point at the same internal glitchtip-web address.
function allowedIngestOrigin(): string | null {
  if (!process.env.SENTRY_DSN) return null
  try {
    return new URL(process.env.SENTRY_DSN).origin
  } catch {
    return null
  }
}

/**
 * Relays browser-side Sentry/GlitchTip envelopes to the internal-only
 * glitchtip-web service (see instrumentation-client.ts's `tunnel` option).
 * GlitchTip is never published on a public interface — this route is the
 * only path a browser error report can take to reach it.
 */
// No strict Origin check, on purpose: this route is unauthenticated and acts
// on no user's behalf (it ignores cookies and only forwards an error report to
// the pinned internal GlitchTip project), so a cross-site request can't make
// it do anything a direct request couldn't. It stays under the proxy.ts Origin
// gate, the IP rate limit, the body cap and the DSN host/project pinning.
// nosemgrep: openexam-mutation-missing-origin-check
export async function POST(request: NextRequest) {
  const allowedOrigin = allowedIngestOrigin()
  if (!allowedOrigin) return new NextResponse(null, { status: 404 })

  // Unauthenticated POST endpoint reachable by any visitor's browser —
  // rate-limited by IP like the project's other public forms (fail-open:
  // losing error reports during a Redis blip is preferable to losing exam
  // functionality over it).
  const ip = getClientIp(request) ?? "unknown"
  const limit = await rateLimit(`monitoring-tunnel:${ip}`, 20, 60)
  if (!limit.allowed) {
    return new NextResponse(null, { status: 429 })
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_ENVELOPE_BYTES) {
    return new NextResponse(null, { status: 413 })
  }

  // Chunked bodies have no Content-Length, so the cap is enforced while
  // reading: stop at MAX_ENVELOPE_BYTES instead of buffering the whole body.
  const envelopeBytes = await readBoundedBytes(request, MAX_ENVELOPE_BYTES)
  if (envelopeBytes === null) {
    return new NextResponse(null, { status: 413 })
  }

  let upstreamUrl: string
  try {
    const header = JSON.parse(
      new TextDecoder().decode(envelopeBytes).split("\n")[0]!
    ) as {
      dsn?: string
    }
    if (!header.dsn) throw new Error("envelope header missing dsn")
    const dsn = new URL(header.dsn)
    if (dsn.origin !== allowedOrigin) {
      throw new Error(
        `dsn origin ${dsn.origin} is not the configured GlitchTip instance`
      )
    }
    const projectId = dsn.pathname.replace(/^\//, "")
    // A GlitchTip/Sentry project id is a bare integer. Pin it so a crafted DSN
    // path ("../../admin/x", "a/b/c", "//evil") can't steer the forwarded
    // request to a different path segment on the upstream.
    if (!/^\d+$/.test(projectId)) {
      throw new Error(
        `dsn project id ${JSON.stringify(projectId)} is not numeric`
      )
    }
    upstreamUrl = `${allowedOrigin}/api/${projectId}/envelope/`
  } catch (err) {
    logError("monitoring tunnel: rejected malformed/untrusted envelope", {
      err: err instanceof Error ? err.message : String(err),
    })
    return new NextResponse(null, { status: 400 })
  }

  try {
    // redirect: "manual" — the upstream URL is allowlisted and internal, but
    // keep fetch from ever following a redirect to a different host.
    await fetch(upstreamUrl, {
      method: "POST",
      body: envelopeBytes,
      redirect: "manual",
    })
  } catch (err) {
    // Best-effort: a GlitchTip outage must not surface as a user-visible
    // error on top of whatever error the client was already reporting.
    logError("monitoring tunnel: forward to GlitchTip failed", {
      err: err instanceof Error ? err.message : String(err),
    })
  }

  return new NextResponse(null, { status: 200 })
}
