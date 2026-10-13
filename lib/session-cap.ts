/**
 * Absolute session lifetime. Sessions slide (better-auth refreshes expiresAt
 * on use), so without a cap an active client — or a stolen cookie on a shared
 * lab machine — could hold a session forever. 30 days is a product decision
 * (PRODUCT-RISK-DECISIONS R3c). Postgres enforces the same cap with a trigger
 * (migration 20261007101000_session_absolute_cap) for the ws-backend, which
 * reads sessions from Postgres only.
 *
 * Cost: better-auth decides "refresh due" from expiresAt alone, so in a
 * session's last 6 days (expiresIn 7d − updateAge 1d) every getSession
 * refreshes and writes again. Bounded to old sessions; accepted.
 */
export const SESSION_ABSOLUTE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30

type SessionUpdate = { expiresAt?: Date | string | null } & Record<
  string,
  unknown
>

/**
 * Decides a sliding refresh against the absolute cap, as a better-auth
 * `session.update.before` hook result:
 * - `false` once the cap has passed: the refresh is refused, so getSession
 *   answers 401 and clears the cookie instead of extending the session;
 * - `{ data }` with expiresAt clamped to the cap when the refresh would
 *   overshoot it;
 * - `undefined` (no change) for updates that don't touch expiresAt or when the
 *   session's createdAt is unknown (the Postgres trigger still clamps).
 */
export function capSessionRefresh(
  data: SessionUpdate,
  createdAt: Date | string | null | undefined,
  now: Date = new Date()
): false | { data: SessionUpdate } | undefined {
  if (!data.expiresAt || !createdAt) return undefined
  const cap = new Date(
    new Date(createdAt).getTime() + SESSION_ABSOLUTE_MAX_AGE_SECONDS * 1000
  )
  if (cap.getTime() <= now.getTime()) return false
  if (new Date(data.expiresAt).getTime() > cap.getTime()) {
    return { data: { ...data, expiresAt: cap } }
  }
  return undefined
}

/**
 * Applies the cap to a better-auth session snapshot read from Redis secondary
 * storage. Snapshots written before the cap existed (or before a refresh
 * clamped them) can carry an expiresAt past createdAt + 30 days; better-auth
 * trusts that copy on every getSession. Clamping it on read makes the cap
 * take effect immediately: an over-age session reads as expired, and
 * better-auth deletes it. Any other value passes through untouched.
 */
export function clampSessionSnapshot(raw: string | null): string | null {
  // Snapshots are JSON objects; counters and session lists skip the parse.
  // The shape is checked after parsing, not by key order in the string, so a
  // serializer change can't silently turn the cap off.
  if (!raw || raw[0] !== "{") return raw
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw
  }
  if (!isRecord(parsed) || !isRecord(parsed.session)) return raw
  const session = parsed.session
  if (
    typeof session.createdAt !== "string" ||
    typeof session.expiresAt !== "string"
  ) {
    return raw
  }
  const cap =
    new Date(session.createdAt).getTime() +
    SESSION_ABSOLUTE_MAX_AGE_SECONDS * 1000
  if (!(new Date(session.expiresAt).getTime() > cap)) return raw
  session.expiresAt = new Date(cap).toISOString()
  return JSON.stringify(parsed)
}

/**
 * Reads the createdAt of the session being refreshed from the context
 * better-auth passes to a `session.update.before` hook. getSession puts the
 * `{ session, user }` it is about to refresh on `ctx.context.session` first
 * (better-auth 1.7.7, api/routes/session). Any other shape yields undefined;
 * __tests__/session-cap-contract.test.ts pins this against real better-auth.
 */
export function sessionCreatedAtFromHookContext(
  context: unknown
): Date | string | undefined {
  if (!isRecord(context) || !isRecord(context.context)) return undefined
  const current = context.context.session
  if (!isRecord(current) || !isRecord(current.session)) return undefined
  const createdAt = current.session.createdAt
  return createdAt instanceof Date || typeof createdAt === "string"
    ? createdAt
    : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
