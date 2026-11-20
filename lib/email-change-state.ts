import { createHmac, timingSafeEqual } from "node:crypto"

/**
 * Signed "which address is this email change for" state, carried on the
 * callbackURL of the change-email links so the settings page can tell the
 * user which step they are on.
 *
 * The query parameter alone was caller-controlled: anyone could link a
 * signed-in user to `?emailChange=<address>` and have the page claim a change
 * was confirmed. The server signs it instead (lib/auth.ts, when it sends the
 * first link) over user id and address, and the page only trusts a value
 * whose signature matches the signed-in user.
 *
 * One parameter, `<base64url address>.<signature>`, with no `&` in it:
 * better-auth copies the callbackURL from the first link into the second.
 */
export const EMAIL_CHANGE_PARAM = "emailChange"

function signature(userId: string, email: string): Buffer {
  const secret = process.env.BETTER_AUTH_SECRET
  if (!secret) throw new Error("BETTER_AUTH_SECRET must be set")
  return createHmac("sha256", secret)
    .update(`email-change:${userId}:${email.toLowerCase()}`)
    .digest()
    .subarray(0, 16)
}

/**
 * `url` (a better-auth verification link) with its callbackURL extended by
 * the signed email-change state. Returns `url` unchanged when it has no
 * callbackURL.
 */
export function withEmailChangeState(
  url: string,
  userId: string,
  newEmail: string
): string {
  const link = new URL(url)
  const callbackURL = link.searchParams.get("callbackURL")
  if (!callbackURL) return url
  // Relative callback paths are resolved against a placeholder origin and
  // written back without it.
  const callback = new URL(callbackURL, "http://callback.invalid")
  const value = `${Buffer.from(newEmail).toString("base64url")}.${signature(userId, newEmail).toString("base64url")}`
  callback.searchParams.set(EMAIL_CHANGE_PARAM, value)
  link.searchParams.set(
    "callbackURL",
    callback.origin === "http://callback.invalid"
      ? `${callback.pathname}${callback.search}`
      : callback.toString()
  )
  return link.toString()
}

/**
 * The address a signed email-change parameter names, or null when the value
 * is missing, malformed or not signed for `userId`.
 */
export function verifiedEmailChange(
  value: string | string[] | undefined,
  userId: string
): string | null {
  if (typeof value !== "string") return null
  const [encodedEmail, encodedSig, ...rest] = value.split(".")
  if (!encodedEmail || !encodedSig || rest.length > 0) return null
  const email = Buffer.from(encodedEmail, "base64url").toString()
  const given = Buffer.from(encodedSig, "base64url")
  const expected = signature(userId, email)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null
  }
  return email
}
