// Package ratelimit implements a fixed-window rate limiter backed by Redis,
// mirroring lib/rate-limit.ts's INCR+EXPIRE Lua script on the Next.js side.
// Deliberately an independent budget from the TS side (its own key prefix,
// no shared state) — coupling two languages' TTL/format assumptions buys
// nothing when the only job here is bounding abuse of the WS handshake, not
// tracking a precise cross-service quota.
package ratelimit

import (
	"context"

	"github.com/redis/go-redis/v9"
)

// Mirrors the atomicity reasoning in lib/rate-limit.ts: INCR + conditional
// EXPIRE in one round trip, so a crash between a plain incr and a separate
// expire call can never leave a counter key with no TTL.
const fixedWindowScript = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
return count
`

// Allow increments the counter for key and reports whether this call is
// still within limit over the trailing windowSeconds. Fails open on a Redis
// error: an outage must not lock a student out of a WS handshake for an
// exam they're already authorized to sit — the SEB guard downstream is the
// actual security boundary, this is only an abuse throttle on top of it.
func Allow(ctx context.Context, rdb *redis.Client, key string, limit, windowSeconds int) bool {
	count, err := rdb.Eval(ctx, fixedWindowScript, []string{"ratelimit:" + key}, windowSeconds).Int()
	if err != nil {
		return true
	}
	return count <= limit
}
