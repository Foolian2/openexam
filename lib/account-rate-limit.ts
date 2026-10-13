import { createHash } from "node:crypto"
import { z } from "zod"
import { rateLimit } from "@/lib/rate-limit"

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
