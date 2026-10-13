package ratelimit

import (
	"context"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func newTestRedis(t *testing.T) *redis.Client {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	t.Cleanup(mr.Close)
	return redis.NewClient(&redis.Options{Addr: mr.Addr()})
}

func TestAllow(t *testing.T) {
	ctx := context.Background()
	rdb := newTestRedis(t)

	for i := 0; i < 3; i++ {
		if !Allow(ctx, rdb, "k1", 3, 60) {
			t.Fatalf("call %d: expected allowed within limit", i+1)
		}
	}
	if Allow(ctx, rdb, "k1", 3, 60) {
		t.Fatal("expected the 4th call to exceed the limit of 3")
	}
}

func TestAllowKeysAreIndependent(t *testing.T) {
	ctx := context.Background()
	rdb := newTestRedis(t)

	for i := 0; i < 5; i++ {
		Allow(ctx, rdb, "exhausted", 1, 60)
	}
	if !Allow(ctx, rdb, "fresh", 1, 60) {
		t.Fatal("a different key must have its own independent budget")
	}
}

func TestAllowFailsOpenOnRedisError(t *testing.T) {
	ctx := context.Background()
	// A client pointed at nothing: every call errors, and Allow must fail
	// open rather than lock a legitimate handshake out during an outage —
	// the SEB guard downstream is the real security boundary, not this
	// throttle.
	rdb := redis.NewClient(&redis.Options{Addr: "127.0.0.1:1"})
	t.Cleanup(func() { _ = rdb.Close() })

	if !Allow(ctx, rdb, "k1", 1, 60) {
		t.Fatal("expected fail-open (allowed) when Redis is unreachable")
	}
}
