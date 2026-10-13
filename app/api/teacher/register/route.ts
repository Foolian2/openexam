import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { isAPIError } from "better-auth/api"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { getClientIp } from "@/lib/client-ip"
import { createAuditLog } from "@/lib/audit"
import { rateLimit } from "@/lib/rate-limit"
import { readBoundedJson } from "@/lib/body-size"
import { secureEqual } from "@/lib/secure-compare"
import { verifyOrigin } from "@/lib/csrf"
import { apiError, forbidden, rateLimited } from "@/lib/api-response"
import { displayNameSchema } from "@/lib/display-name"

const bodySchema = z.object({
  name: displayNameSchema,
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
  accessCode: z.string().min(1).max(128),
  // May be empty: with DISABLE_CAPTCHA in local dev the Cap widget renders
  // nothing, so the form has no token to send. An empty token is rejected
  // below whenever verification is required.
  captchaToken: z.string().max(4096),
  acceptPrivacy: z.literal(true),
})

/**
 * One-shot teacher registration (replaces the sign-up-then-promote pair the
 * client used to do). Production requires email verification
 * (lib/auth.ts), so a sign-up never returns a session — the old client flow
 * followed its promote call into a 307-to-/login and crashed on the HTML
 * 405. Here the access code is validated BEFORE the account is created, and
 * the role is set to TEACHER immediately; the account is locked to email
 * verification (24h window, see lib/auth.ts) as required.
 *
 * This route is NOT under /api/auth/*, so better-auth's captcha plugin does
 * not run — the PoW token is verified against Cap's siteverify here instead
 * (same {secret, response} → {success} wire contract the plugin uses).
 */
export async function POST(request: NextRequest) {
  // Defense-in-depth: the proxy already checks Origin for unsafe /api/*
  // methods, but this route is reachable without a session, so the handler
  // re-checks explicitly (same pattern as other mutation routes, e.g.
  // /api/teacher/auto-archive).
  const originError = verifyOrigin(request)
  if (originError) return originError

  const ipAddress = getClientIp(request)

  const body = await readBoundedJson(request, 4096)
  if (body instanceof NextResponse) return body
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return apiError("VALIDATION_ERROR", "Ungültige Eingabedaten.", 400)
  }
  const { name, email, password, accessCode, captchaToken, acceptPrivacy } =
    parsed.data

  // Throttle per IP: this route is the privilege-escalation entry point, so
  // it must not disappear when Redis is unavailable ("closed" failure mode).
  const limit = await rateLimit(
    `teacher-register:${ipAddress ?? "unknown"}`,
    5,
    60 * 15,
    "closed"
  )
  if (!limit.allowed) {
    return tooManyAttempts(limit.resetInSeconds)
  }

  // Same skip condition as lib/auth.ts's captcha plugin: local dev/test only,
  // refused in production.
  if (
    process.env.DISABLE_CAPTCHA !== "true" ||
    process.env.NODE_ENV === "production"
  ) {
    const endpoint =
      process.env.CAP_SITEVERIFY_URL ?? "http://localhost:8090/siteverify"
    let verified = false
    // An empty token can never verify, so it isn't sent to Cap.
    if (captchaToken) {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            secret: process.env.CAP_SECRET_KEY ?? "",
            response: captchaToken,
          }),
        })
        if (res.ok) {
          const data = (await res.json()) as { success?: boolean }
          verified = data.success === true
        }
      } catch {
        verified = false
      }
    }
    if (!verified) {
      return apiError(
        "CAPTCHA_INVALID",
        "Bot-Check fehlgeschlagen. Bitte erneut versuchen.",
        403
      )
    }
  }

  const expected = process.env.TEACHER_ACCESS_CODE
  if (!expected || !secureEqual(accessCode, expected)) {
    await createAuditLog({
      action: "TEACHER_REGISTER_FAILED",
      entityType: "User",
      entityId: email,
      userId: null,
      ipAddress,
    })
    return forbidden("Ungültiger Lehrerzugangscode")
  }

  // Normalized once so the duplicate check, account creation and audit trail
  // can't drift apart (mixed-case registration would otherwise break
  // sign-in, which compares lowercase).
  const normalizedEmail = email.toLowerCase()

  // Duplicate-email check first: signUpEmail's generic duplicate response is
  // indistinguishable from success (anti-enumeration), so promoting blindly
  // off it could write a role to a non-existent account.
  const existing = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  })
  if (existing) {
    return apiError(
      "EMAIL_TAKEN",
      "Diese E-Mail-Adresse ist bereits registriert.",
      409
    )
  }

  // Creates the user (verification email sent per emailVerification.sendOnSignUp)
  // and returns token:null in production — no session yet, by design.
  let result:
    | {
        headers?: Headers
        response: { token: string | null; user?: { id: string } | null }
      }
    | { headers?: Headers; response: Response }
  try {
    result = await auth.api.signUpEmail({
      // acceptPrivacy is checked again by lib/auth.ts's user.create hook,
      // which records the acknowledgement on the new account. It isn't a
      // user column, so better-auth's inferred body type doesn't list it —
      // the endpoint accepts extra keys (signUpEmailBodySchema is
      // `.and(z.record(...))`), hence the spread instead of a literal key.
      body: { name, email: normalizedEmail, password, ...{ acceptPrivacy } },
      headers: request.headers,
      returnHeaders: true,
    })
  } catch (error) {
    if (isAPIError(error) && error.statusCode === 429) {
      return tooManyAttempts()
    }
    // Race with a concurrent registration of the same email: the pre-check
    // above can pass for both. Reply 409 like the pre-check — same code the
    // caller already handles, no new information leaks. Only the duplicate-
    // user error maps to 409: any other 422 (e.g. a password-policy failure)
    // is a real validation error and must not be reported as "email taken".
    if (isAPIError(error) && error.statusCode === 422) {
      const body = (error as { body?: { code?: string } | null }).body
      if (body?.code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL") {
        return apiError(
          "EMAIL_TAKEN",
          "Diese E-Mail-Adresse ist bereits registriert.",
          409
        )
      }
      return apiError("VALIDATION_ERROR", "Ungültige Eingabedaten.", 400)
    }
    return apiError("UNKNOWN_ERROR", "Registrierung fehlgeschlagen.", 400)
  }
  if (result.response instanceof Response) {
    // better-auth's rate limiter short-circuits the handler with a 429
    // Response instead of throwing — surface it as a 429 rather than the
    // generic failure below.
    if (result.response.status === 429) {
      return tooManyAttempts()
    }
    return apiError("UNKNOWN_ERROR", "Registrierung fehlgeschlagen.", 500)
  }
  const userId = result.response.user?.id
  if (!userId) {
    return apiError("UNKNOWN_ERROR", "Registrierung fehlgeschlagen.", 500)
  }

  // The access code was already validated above; make the account a TEACHER
  // account right away instead of the STUDENT-sign-up-then-promote dance. If
  // the role write fails, remove the just-created account again — an
  // unverified STUDENT left behind could later be verified and used with the
  // wrong role.
  try {
    await prisma.user.update({
      where: { id: userId },
      data: { role: "TEACHER" },
    })
  } catch {
    await prisma.user.delete({ where: { id: userId } }).catch(() => {})
    await createAuditLog({
      action: "TEACHER_REGISTER_FAILED",
      entityType: "User",
      entityId: userId,
      userId: null,
      ipAddress,
    })
    return apiError("UNKNOWN_ERROR", "Registrierung fehlgeschlagen.", 500)
  }

  await createAuditLog({
    action: "TEACHER_REGISTER_SUCCESS",
    entityType: "User",
    entityId: userId,
    userId,
    ipAddress,
  })

  // In dev (requireEmailVerification=false) signUpEmail returns a session
  // token; forward its cookie so the dev experience still signs the teacher
  // in. In production there is no session — the client shows the
  // verify-your-email screen instead.
  const headers = new Headers()
  result.headers?.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") headers.append("set-cookie", value)
  })

  return NextResponse.json(
    { ok: true, verificationRequired: result.response.token === null },
    { headers }
  )
}

// Wording differs from the shared default ("Anfragen"): these are
// registration attempts.
function tooManyAttempts(retryAfterSeconds = 60): NextResponse {
  return rateLimited(
    retryAfterSeconds,
    "Zu viele Versuche. Bitte später erneut versuchen."
  )
}
