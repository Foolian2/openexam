import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { requireSession } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { getClientIp } from "@/lib/client-ip"
import { createAuditLog } from "@/lib/audit"
import { rateLimit } from "@/lib/rate-limit"
import { readBoundedJson } from "@/lib/body-size"
import { secureEqual } from "@/lib/secure-compare"
import { verifyOrigin } from "@/lib/csrf"
import {
  purgeSessionRedisKeys,
  revokeUserSessionsInTx,
} from "@/lib/session-revocation"
import { conflict, forbidden, rateLimited } from "@/lib/api-response"

export async function POST(request: NextRequest) {
  const originError = verifyOrigin(request)
  if (originError) return originError

  const authed = await requireSession(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  // Only a STUDENT may redeem the access code. An ADMIN calling this would
  // silently demote itself to TEACHER, bypassing the last-admin protection in
  // /api/admin/users/[userId] (and could leave the system with zero admins);
  // a TEACHER is already staff, so there is nothing to promote.
  if (session.user.role !== "STUDENT") {
    return forbidden("Nur Studierende können den Lehrerzugangscode einlösen.")
  }

  // Local read before the Redis round-trip below, so an oversized payload
  // can't be used to pile load onto the rate limiter itself.
  const body = await readBoundedJson(request, 1024)
  if (body instanceof NextResponse) return body
  // Optional re-auth for the register-teacher flow: the client signs up as
  // STUDENT, then promotes here. The session cookie caches the role (5 min
  // TTL), so the old session would keep acting as STUDENT — instead of a
  // second captcha-gated client-side sign-in, we re-issue the session
  // server-side, where better-auth's captcha middleware doesn't apply
  // (auth.api calls bypass the HTTP router's onRequest hooks).
  const reauth =
    typeof body?.email === "string" &&
    body.email === session.user.email &&
    typeof body?.password === "string" &&
    body.password.length > 0
      ? { email: body.email as string, password: body.password as string }
      : null

  // Throttle guesses per user to defeat brute-forcing of the access code.
  // This gate protects a privilege-escalation secret. Unlike lower-risk
  // convenience limits, it must not disappear when Redis is unavailable.
  const limit = await rateLimit(
    `teacher-promote:${session.user.id}`,
    5,
    60 * 15,
    "closed"
  )
  if (!limit.allowed) {
    return rateLimited(
      limit.resetInSeconds,
      "Zu viele Versuche. Bitte später erneut versuchen."
    )
  }

  const accessCode = body?.accessCode
  const expected = process.env.TEACHER_ACCESS_CODE

  if (
    !expected ||
    typeof accessCode !== "string" ||
    !secureEqual(accessCode, expected)
  ) {
    await createAuditLog({
      action: "TEACHER_PROMOTE_FAILED",
      entityType: "User",
      entityId: session.user.id,
      userId: session.user.id,
      ipAddress: getClientIp(request) ?? undefined,
    })
    return forbidden("Ungültiger Lehrerzugangscode")
  }

  // Role change and session revocation happen in one transaction, then the
  // Redis snapshots are purged after the commit — see
  // lib/session-revocation.ts for why the split must look exactly like this.
  // Dropping the caller's old sessions makes the promotion take effect
  // immediately even if the re-auth below is skipped or fails (the client
  // would otherwise keep a STUDENT session for the rest of its lifetime).
  // The re-auth issues a fresh session carrying the new role.
  const revokedTokens = await prisma.$transaction(async (tx) => {
    // Scope the write to STUDENT so a role that changed between the guard
    // above and here (concurrent admin action) can never be demoted.
    const { count } = await tx.user.updateMany({
      where: { id: session.user.id, role: "STUDENT" },
      data: { role: "TEACHER" },
    })
    if (count === 0) return null
    return revokeUserSessionsInTx(tx, session.user.id)
  })
  if (revokedTokens === null) {
    // A concurrent role change won the race: nothing was promoted, so neither
    // report success nor re-issue a session for a role this request didn't set.
    await createAuditLog({
      action: "TEACHER_PROMOTE_NOOP",
      entityType: "User",
      entityId: session.user.id,
      userId: session.user.id,
      ipAddress: getClientIp(request) ?? undefined,
    })
    return conflict("Die Rolle wurde inzwischen geändert. Bitte neu anmelden.")
  }
  await purgeSessionRedisKeys(revokedTokens)

  await createAuditLog({
    action: "TEACHER_PROMOTE_SUCCESS",
    entityType: "User",
    entityId: session.user.id,
    userId: session.user.id,
    ipAddress: getClientIp(request) ?? undefined,
  })

  if (reauth) {
    try {
      // returnHeaders keeps the set-cookie the new session issues — a plain
      // auth.api call returns only the parsed body and would silently drop it.
      const { headers: signInHeaders } = await auth.api.signInEmail({
        body: { email: reauth.email, password: reauth.password },
        headers: request.headers,
        returnHeaders: true,
      })
      const headers = new Headers()
      signInHeaders.forEach((value, key) => {
        if (key.toLowerCase() === "set-cookie")
          headers.append("set-cookie", value)
      })
      return NextResponse.json({ ok: true, reauth: true }, { headers })
    } catch {
      // Account is created and promoted; only the automatic cookie refresh
      // failed (e.g. unverified email in production). The client falls back
      // to a manual sign-in.
    }
  }

  return NextResponse.json({ ok: true, reauth: false })
}
