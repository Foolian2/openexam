import { redis } from "./redis"
import { logError } from "./logger"
import { rateLimitRejections } from "./metrics"

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  resetInSeconds: number
}

export type RateLimitFailureMode = "open" | "closed"

// INCR + EXPIRE + TTL in one atomic script: a crash between a plain incr and
// expire (the naive two-call form) would leave a counter key with no TTL,
// living forever. One round trip, and the TTL is returned in the same call.
const FIXED_WINDOW_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
local ttl = redis.call("TTL", KEYS[1])
return { count, ttl }
`

/**
 * Fixed-window rate limiter backed by Redis.
 *
 * Increments a counter keyed by `key` and applies a TTL on first hit. If Redis
 * is unavailable the request is allowed by default (fail-open) so an
 * infrastructure outage never locks legitimate users out — pass
 * `"closed"` for limiter calls that protect an authentication step (e.g.
 * access-code brute-force), where allowing unbounded attempts during a
 * Redis outage is worse than refusing the request.
 *
 * DISABLE_RATE_LIMIT=true bypasses this entirely (see lib/auth.ts's Better
 * Auth rateLimit config for the same opt-out on sign-in/sign-up) — for
 * local k6 load-test iteration only, see load/README.md; never set it in a
 * reachable deployment. The bypass is refused in NODE_ENV=production so
 * a misconfigured deployment can't silently disable rate limiting.
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
  failureMode: RateLimitFailureMode = "open"
): Promise<RateLimitResult> {
  if (
    process.env.DISABLE_RATE_LIMIT === "true" &&
    process.env.NODE_ENV !== "production"
  ) {
    return { allowed: true, remaining: limit, resetInSeconds: windowSeconds }
  }

  const redisKey = `ratelimit:${key}`
  try {
    const result = await redis.eval(
      FIXED_WINDOW_SCRIPT,
      1,
      redisKey,
      windowSeconds
    )
    const [count, ttl] = (
      Array.isArray(result) ? result : [result, windowSeconds]
    ) as number[]
    const allowed = count <= limit
    if (!allowed) rateLimitRejections.inc({ reason: "limit" })
    return {
      allowed,
      remaining: Math.max(0, limit - count),
      resetInSeconds: ttl >= 0 ? ttl : windowSeconds,
    }
  } catch (err) {
    if (failureMode === "closed") {
      // An authentication-step limiter must not become a free pass during a
      // Redis outage — return a denial so the caller emits 429/503.
      logError("rate-limit fail-closed (Redis unreachable)", { key, err })
      rateLimitRejections.inc({ reason: "redis_unavailable" })
    }
    return {
      allowed: failureMode === "open",
      remaining: failureMode === "open" ? limit : 0,
      resetInSeconds: windowSeconds,
    }
  }
}
