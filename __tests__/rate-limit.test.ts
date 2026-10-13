import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const redisMock = vi.hoisted(() => ({
  eval: vi.fn<(script: string, numKeys: number, key: string, window: number) => Promise<unknown>>(),
}))

vi.mock("@/lib/redis", () => ({ redis: redisMock }))

import { rateLimit } from "@/lib/rate-limit"

function evalResult(count: number, ttl: number): [number, number] {
  return [count, ttl]
}

beforeEach(() => {
  vi.clearAllMocks()
  redisMock.eval.mockResolvedValue(evalResult(0, 42))
})

describe("rateLimit", () => {
  it("allows requests under the limit and reports remaining quota", () => {
    redisMock.eval.mockResolvedValue(evalResult(3, 42))
    return expect(rateLimit("login:1.2.3.4", 5, 60)).resolves.toEqual({
      allowed: true,
      remaining: 2,
      resetInSeconds: 42,
    })
  })

  it("allows the request that exactly reaches the limit", async () => {
    redisMock.eval.mockResolvedValue(evalResult(5, 42))
    const result = await rateLimit("login:1.2.3.4", 5, 60)
    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(0)
  })

  it("denies requests over the limit without going negative on remaining", async () => {
    redisMock.eval.mockResolvedValue(evalResult(7, 42))
    const result = await rateLimit("login:1.2.3.4", 5, 60)
    expect(result.allowed).toBe(false)
    expect(result.remaining).toBe(0)
  })

  it("runs the atomic window script against the keyed Redis key", async () => {
    redisMock.eval.mockResolvedValue(evalResult(1, 60))
    await rateLimit("api:user1", 100, 60)
    expect(redisMock.eval).toHaveBeenCalledWith(
      expect.stringContaining("INCR"),
      1,
      "ratelimit:api:user1",
      60
    )
  })

  it("falls back to the window length when the key has no TTL", async () => {
    redisMock.eval.mockResolvedValue(evalResult(2, -1))
    const result = await rateLimit("api:user1", 100, 60)
    expect(result.resetInSeconds).toBe(60)
  })

  it("fails open when Redis is unavailable", async () => {
    redisMock.eval.mockRejectedValue(new Error("ECONNREFUSED"))
    const result = await rateLimit("login:1.2.3.4", 5, 60)
    expect(result).toEqual({ allowed: true, remaining: 5, resetInSeconds: 60 })
  })

  it("can fail closed for privilege-escalation controls", async () => {
    redisMock.eval.mockRejectedValue(new Error("ECONNREFUSED"))
    await expect(
      rateLimit("teacher-promote:user-1", 5, 60, "closed")
    ).resolves.toEqual({
      allowed: false,
      remaining: 0,
      resetInSeconds: 60,
    })
  })

  describe("DISABLE_RATE_LIMIT bypass", () => {
    const ORIGINAL_ENV = { ...process.env }

    // NODE_ENV is typed read-only on process.env; reassigning the whole
    // object sidesteps that (same pattern as __tests__/env.test.ts).
    function setEnv(overrides: Record<string, string | undefined>) {
      const next: Record<string, string | undefined> = { ...process.env }
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) delete next[key]
        else next[key] = value
      }
      process.env = next as unknown as NodeJS.ProcessEnv
    }

    afterEach(() => {
      process.env = { ...ORIGINAL_ENV }
    })

    it("bypasses rate limiting outside production", async () => {
      setEnv({ DISABLE_RATE_LIMIT: "true", NODE_ENV: "test" })
      const result = await rateLimit("login:1.2.3.4", 5, 60)
      expect(result).toEqual({
        allowed: true,
        remaining: 5,
        resetInSeconds: 60,
      })
      expect(redisMock.eval).not.toHaveBeenCalled()
    })

    it("still enforces rate limiting when DISABLE_RATE_LIMIT=true AND NODE_ENV=production", async () => {
      setEnv({ DISABLE_RATE_LIMIT: "true", NODE_ENV: "production" })
      redisMock.eval.mockResolvedValue(evalResult(7, 42))
      const result = await rateLimit("login:1.2.3.4", 5, 60)
      // The bypass must be ignored in production: Redis is still consulted
      // and the over-limit request is still denied.
      expect(redisMock.eval).toHaveBeenCalled()
      expect(result.allowed).toBe(false)
      expect(result.remaining).toBe(0)
    })
  })
})
