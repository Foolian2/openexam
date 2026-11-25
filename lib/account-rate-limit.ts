import { createHash } from "node:crypto"
import { z } from "zod"
import { rateLimit } from "@/lib/rate-limit"
import { redis } from "@/lib/redis"
import { logError } from "@/lib/logger"
import { rateLimitRejections } from "@/lib/metrics"

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
 * wrong guesses. A successful sign-in does not reset the count, so an
 * attacker cannot clear it by interleaving their own account.
 *
 * Check and count are one atomic step: every attempt reserves an in-flight
 * slot before the password is checked (reserveSignInAttempt), and the slot is
 * settled afterwards — turned into a failure or released
 * (settleSignInAttempt). Refusing once failures + in-flight attempts reach the
 * limit means a burst of parallel guesses cannot all pass a check that only
 * saw the failures recorded so far. Correct sign-ins hold a slot only while
 * the password is checked, so they never lock anyone out; at most a burst of
 * ~50 simultaneous attempts on an address already near the limit is refused
 * until those finish.
 *
 * Trade-off, accepted: the limit refuses every password sign-in from the
 * address, so someone on a school network who deliberately submits 50 wrong
 * passwords (each behind a solved Cap proof-of-work) blocks password sign-in
 * there for up to 15 minutes. Microsoft sign-in and passkeys are not
 * affected, and refusals show in the rate-limit rejection metric.
 */
export const FAILED_SIGN_IN_LIMIT = 50
export const FAILED_SIGN_IN_WINDOW_SECONDS = 15 * 60
/** Safety TTL for in-flight slots a crashed request never settled. */
const IN_FLIGHT_TTL_SECONDS = 60
const FAILED_SIGN_IN_MESSAGE =
  "Zu viele fehlgeschlagene Anmeldungen von diesem Netzwerk. Bitte in 15 Minuten erneut versuchen."

// KEYS: failures, in-flight. ARGV: limit, in-flight TTL. 1 = slot reserved.
const RESERVE_SCRIPT = `
local failed = tonumber(redis.call("GET", KEYS[1]) or "0")
local pending = tonumber(redis.call("GET", KEYS[2]) or "0")
if failed + pending >= tonumber(ARGV[1]) then return 0 end
redis.call("INCR", KEYS[2])
redis.call("EXPIRE", KEYS[2], ARGV[2])
return 1
`

// KEYS: failures, in-flight. ARGV: 1 to count a failure, failure window.
const SETTLE_SCRIPT = `
if tonumber(redis.call("GET", KEYS[2]) or "0") > 0 then
  redis.call("DECR", KEYS[2])
end
if ARGV[1] == "1" then
  if redis.call("INCR", KEYS[1]) == 1 then
    redis.call("EXPIRE", KEYS[1], ARGV[2])
  end
end
return 1
`

function signInKeys(ip: string): [string, string] {
  return [`ratelimit:login-failed-ip:${ip}`, `ratelimit:login-pending-ip:${ip}`]
}

function signInLimitBypassed(): boolean {
  return (
    process.env.DISABLE_RATE_LIMIT === "true" &&
    process.env.NODE_ENV !== "production"
  )
}

/**
 * Before a password sign-in: reserves an in-flight slot for `ip` and returns
 * null, or returns the German error message when the address is over its
 * failed sign-in limit. Every null for a non-null `ip` on /sign-in/email
 * must be followed by settleSignInAttempt. Fails open on Redis errors, like
 * the per-account limit: better-auth's per-IP limit still applies.
 */
export async function reserveSignInAttempt(
  path: string,
  ip: string | null
): Promise<string | null> {
  if (path !== "/sign-in/email" || !ip || signInLimitBypassed()) return null
  try {
    const reserved = await redis.eval(
      RESERVE_SCRIPT,
      2,
      ...signInKeys(ip),
      FAILED_SIGN_IN_LIMIT,
      IN_FLIGHT_TTL_SECONDS
    )
    if (Number(reserved) === 1) return null
    rateLimitRejections.inc({ reason: "limit" })
    return FAILED_SIGN_IN_MESSAGE
  } catch (err) {
    logError("failed sign-in limit unavailable (Redis), allowing", { err })
    return null
  }
}

/**
 * After a password sign-in (or when it is refused for another reason after
 * reserveSignInAttempt): releases the in-flight slot and, when `failed`,
 * counts one wrong email/password against `ip`.
 */
export async function settleSignInAttempt(
  path: string,
  ip: string | null,
  failed: boolean
): Promise<void> {
  if (path !== "/sign-in/email" || !ip || signInLimitBypassed()) return
  try {
    await redis.eval(
      SETTLE_SCRIPT,
      2,
      ...signInKeys(ip),
      failed ? "1" : "0",
      FAILED_SIGN_IN_WINDOW_SECONDS
    )
  } catch (err) {
    logError("failed sign-in limit unavailable (Redis), not counted", { err })
  }
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
