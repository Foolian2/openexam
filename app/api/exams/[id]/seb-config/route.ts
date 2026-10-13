import { NextRequest, NextResponse } from "next/server"
import { requireSession } from "@/lib/api-auth"
import {
  conflict,
  notFound,
  rateLimited,
  unauthorized,
} from "@/lib/api-response"
import { getClientIp } from "@/lib/client-ip"
import { rateLimit } from "@/lib/rate-limit"
import { issueSebConfig } from "@/lib/seb-issuance"
import { consumeLaunchToken, peekLaunchToken } from "@/lib/seb-launch-token"

type Params = { params: Promise<{ id: string }> }

// SEB always issues a HEAD request immediately before the real GET when it
// resolves a seb:// link. Without this handler, Next.js would auto-generate
// one from GET below — which would run consumeLaunchToken (a single-use
// Redis GETDEL) and burn the token before the real GET ever arrives, so
// every launch would 401 as "Ungültiger oder abgelaufener Start-Link".
// This peeks the token/session instead of consuming it.
export async function HEAD(request: NextRequest, { params }: Params) {
  const { id } = await params
  const launchToken = request.nextUrl.searchParams.get("lt")

  if (launchToken) {
    const valid = await peekLaunchToken(launchToken, id)
    return new NextResponse(null, { status: valid ? 200 : 401 })
  }

  const authed = await requireSession(request)
  return new NextResponse(null, {
    status: authed instanceof NextResponse ? 401 : 200,
  })
}

export async function GET(request: NextRequest, { params }: Params) {
  const { id } = await params
  const ip = getClientIp(request) ?? undefined

  // SEB resolves seb:// handoffs with a brand-new cookieless GET, so the
  // session cookie can't authenticate that fetch. The launch-seb page mints a
  // short-TTL, single-use launch token (see lib/seb-launch-token.ts) and
  // carries it in the URL as ?lt=. Fall back to the session cookie for the
  // browser download path, where the cookie is present.
  const launchToken = request.nextUrl.searchParams.get("lt")
  let userId: string
  // One-time login token to bake into the personalized config's startURL. Only
  // ever set on the seb:// path, where the launch page mints it and it rides
  // alongside `lt`. The browser-download path leaves it null on purpose — see
  // the NOTE on SebIssuanceInput.loginToken in lib/seb-issuance.ts.
  let loginToken: string | null = null

  if (launchToken) {
    // Identity isn't known yet at this point (that's what the token
    // resolves), so throttle the guess itself by exam+IP before consuming
    // it. Fail-closed: this hands out exam configs and burns a single-use
    // token, so an outage must refuse rather than allow unbounded guessing.
    const preLimit = await rateLimit(
      `seb-config-lt:${id}:${ip ?? "unknown"}`,
      20,
      60,
      "closed"
    )
    if (!preLimit.allowed) return rateLimited(preLimit.resetInSeconds)

    const redeemed = await consumeLaunchToken(launchToken, id)
    if (!redeemed) {
      return unauthorized("Ungültiger oder abgelaufener Start-Link")
    }
    userId = redeemed.userId
    loginToken = request.nextUrl.searchParams.get("ott")
  } else {
    const authed = await requireSession(request)
    if (authed instanceof NextResponse) return authed
    userId = authed.user.id
  }

  const limit = await rateLimit(`seb-config:${userId}`, 20, 60, "closed")
  if (!limit.allowed) return rateLimited(limit.resetInSeconds)

  const issued = await issueSebConfig({
    examId: id,
    userId,
    loginToken,
    ipAddress: ip,
    userAgent: request.headers.get("user-agent") ?? undefined,
    launchTokenUsed: !!launchToken,
  })

  if (!issued.ok) {
    return issued.reason === "key_drift"
      ? conflict("SEB-Konfiguration muss vor dem Start aktualisiert werden")
      : notFound("SEB-Konfiguration nicht verfügbar")
  }

  return new NextResponse(new Uint8Array(issued.file), {
    headers: {
      "Content-Type": "application/seb",
      "Content-Disposition": `attachment; filename="openexam-${issued.examId}.seb"`,
      "Cache-Control": "no-store",
    },
  })
}
