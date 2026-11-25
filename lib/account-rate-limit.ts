import { createHash } from "node:crypto"
import { z } from "zod"
import { rateLimit, underRateLimit } from "@/lib/rate-limit"

/**
 * Per-account throttles on credential endpoints, layered on better-auth's
 * per-IP limits. IP limits alone misfire at schools: one NAT address both
 * over-blocks a class and under-protects an account that a botnet attacks
 * from many addresses. (PRODUCT-RISK-DECISIONS R3a.)
 */
const ACCOUNT_LIMITS: Record<
  string,
  { prefix: string; limit: number; windowSeconds: number; message: string }
> = {
  "/sign-in/email": {
    prefix: "login-account",
    limit: 10,
    windowSeconds: 15 * 60,
    message:
      "Zu viele Anmeldeversuche für dieses Konto. Bitte in 15 Minuten erneut versuchen.",
  },
  "/request-password-reset": {
    prefix: "password-reset-account",
    limit: 3,
    windowSeconds: 60 * 60,
    message:
      "Zu viele Anfragen zum Zurücksetzen für dieses Konto. Bitte später erneut versuchen.",
  },
}

const credentialBodySchema = z.object({ email: z.string().trim().min(1) })

/** Lowercased, trimmed email hashed so Redis keys carry no address. */
export function accountKey(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex")
}

/**
 * Returns the German error message when `path` is a throttled credential
 * endpoint and this account is over its limit, otherwise null. Fails open on
 * Redis errors: better-auth's per-IP limit still applies, and a Redis outage
 * must not lock every user out.
 */
export async function accountRateLimitMessage(
  path: string,
  body: unknown
): Promise<string | null> {
  const rule = ACCOUNT_LIMITS[path]
  if (!rule) return null
  const parsed = credentialBodySchema.safeParse(body)
  if (!parsed.success) return null
  const email = parsed.data.email
  const result = await rateLimit(
    `${rule.prefix}:${accountKey(email)}`,
    rule.limit,
    rule.windowSeconds,
    "open"
  )
  return result.allowed ? null : rule.message
}

/**
 * Failed password sign-ins per client IP. better-auth's per-IP sign-in rule
 * has to admit a whole class behind one school NAT address (lib/auth.ts), which
 * on its own would let one address try a common password against ~200
 * accounts a minute (password spraying) without tripping the per-account
 * limit above. Counting only failures keeps a class that signs in correctly
 * unaffected, while spraying from one address stops after FAILED_SIGN_IN_LIMIT
 * wrong guesses. Sized for typos across several classes on one school
 * address; a successful sign-in does not reset it, so an attacker cannot clear
 * the count by interleaving their own account.
 */
export const FAILED_SIGN_IN_LIMIT = 50
export const FAILED_SIGN_IN_WINDOW_SECONDS = 15 * 60
const FAILED_SIGN_IN_MESSAGE =
  "Zu viele fehlgeschlagene Anmeldungen von diesem Netzwerk. Bitte in 15 Minuten erneut versuchen."

function failedSignInKey(ip: string): string {
  return `login-failed-ip:${ip}`
}

/**
 * The German error message when password sign-in from `ip` is blocked by too
 * many recent failures, otherwise null. Only reads the counter; failures are
 * counted by recordFailedSignIn. Fails open on Redis errors.
 */
export async function failedSignInMessage(
  path: string,
  ip: string | null
): Promise<string | null> {
  if (path !== "/sign-in/email" || !ip) return null
  return (await underRateLimit(failedSignInKey(ip), FAILED_SIGN_IN_LIMIT))
    ? null
    : FAILED_SIGN_IN_MESSAGE
}

/** Counts one wrong email/password sign-in from `ip`. Fails open. */
export async function recordFailedSignIn(ip: string | null): Promise<void> {
  if (!ip) return
  await rateLimit(
    failedSignInKey(ip),
    FAILED_SIGN_IN_LIMIT,
    FAILED_SIGN_IN_WINDOW_SECONDS,
    "open"
  )
}

/** better-auth's wrong email or password refusal on /sign-in/email. */
export function isInvalidCredentials(returned: unknown): boolean {
  // Duck-typed: the error is better-call's APIError, which need not be the
  // same class instance that better-auth/api re-exports.
  if (typeof returned !== "object" || returned === null) return false
  const { statusCode, body } = returned as {
    statusCode?: unknown
    body?: { code?: unknown }
  }
  return statusCode === 401 && body?.code === "INVALID_EMAIL_OR_PASSWORD"
}
