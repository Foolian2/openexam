import type { SecondaryStorage } from "better-auth"
import { redis } from "./redis"
import { clampSessionSnapshot } from "./session-cap"

// INCR + first-hit EXPIRE in one atomic script (same shape as the fixed-window
// limiter in lib/rate-limit.ts): setting the TTL in the same atomic step means
// a crash between two separate calls can't leave a counter key that never
// expires. The TTL is applied only when the counter is created, so the window
// is fixed from the first request — exactly better-auth's `increment` contract.
// redis.pcall self-heals keys that still hold the JSON snapshots written by
// better-auth's non-atomic fallback (plain INCR errors on those): drop the
// stale value and restart the window rather than failing the request.
const INCREMENT_SCRIPT = `
local result = redis.pcall("INCR", KEYS[1])
if type(result) == "table" and result.err then
  redis.call("DEL", KEYS[1])
  result = redis.call("INCR", KEYS[1])
end
if result == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
return result
`

/**
 * Redis-backed secondary storage for Better Auth. Implements the atomic
 * `increment` primitive so rate limiting is enforced with a single atomic
 * Redis step; without it Better Auth falls back to a read-decide-write
 * sequence where concurrent requests can all pass a stale read (brute-force
 * amplification on sign-in/sign-up). `getAndDelete` closes the analogous
 * read-then-delete race for single-use credentials.
 */
export const redisSecondaryStorage: SecondaryStorage = {
  async get(key) {
    // Session snapshots get the absolute lifetime cap applied on read
    // (lib/session-cap.ts); every other key passes through unchanged.
    return clampSessionSnapshot(await redis.get(key))
  },
  async set(key, value, ttl) {
    if (ttl) await redis.set(key, value, "EX", ttl)
    else await redis.set(key, value)
  },
  async delete(key) {
    await redis.del(key)
  },
  async getAndDelete(key) {
    return redis.getdel(key)
  },
  async increment(key, ttl) {
    const count = await redis.eval(INCREMENT_SCRIPT, 1, key, ttl)
    return Number(count)
  },
}
