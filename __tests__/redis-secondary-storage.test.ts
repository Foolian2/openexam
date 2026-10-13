import { beforeEach, describe, expect, it, vi } from "vitest"
import Redis from "ioredis"

const redisMock = vi.hoisted(() => ({
  get: vi.fn<(key: string) => Promise<string | null>>(),
  set: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  del: vi.fn<(key: string) => Promise<number>>(),
  getdel: vi.fn<(key: string) => Promise<string | null>>(),
  eval: vi.fn<
    (
      script: string,
      numKeys: number,
      key: string,
      ttl: number
    ) => Promise<unknown>
  >(),
}))

vi.mock("@/lib/redis", () => ({ redis: redisMock }))

import { redisSecondaryStorage } from "@/lib/redis-secondary-storage"

beforeEach(() => {
  vi.clearAllMocks()
})

describe("redisSecondaryStorage", () => {
  it("proxies get/set/delete to the redis client", async () => {
    redisMock.get.mockResolvedValue("value")
    await expect(redisSecondaryStorage.get("k")).resolves.toBe("value")
    expect(redisMock.get).toHaveBeenCalledWith("k")

    await redisSecondaryStorage.set("k", "v", 60)
    expect(redisMock.set).toHaveBeenCalledWith("k", "v", "EX", 60)

    await redisSecondaryStorage.set("k", "v")
    expect(redisMock.set).toHaveBeenCalledWith("k", "v")

    await redisSecondaryStorage.delete("k")
    expect(redisMock.del).toHaveBeenCalledWith("k")
  })

  it("applies the 30-day session cap to session snapshots on read", async () => {
    const createdAt = new Date(Date.now() - 31 * 86_400_000)
    redisMock.get.mockResolvedValue(
      JSON.stringify({
        session: {
          createdAt: createdAt.toISOString(),
          expiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
        },
        user: {},
      })
    )
    const raw = await redisSecondaryStorage.get("session-token")
    const expiresAt = new Date(JSON.parse(raw as string).session.expiresAt)
    expect(expiresAt.getTime()).toBeLessThan(Date.now())
  })

  it("getAndDelete uses atomic GETDEL so single-use credentials can't be read twice", async () => {
    redisMock.getdel.mockResolvedValue("token")
    await expect(redisSecondaryStorage.getAndDelete!("k")).resolves.toBe(
      "token"
    )
    expect(redisMock.getdel).toHaveBeenCalledWith("k")

    redisMock.getdel.mockResolvedValue(null)
    await expect(
      redisSecondaryStorage.getAndDelete!("missing")
    ).resolves.toBeNull()
  })

  it("increment runs the atomic script with the key and ttl and returns the count", async () => {
    redisMock.eval.mockResolvedValue(3)
    await expect(redisSecondaryStorage.increment!("rl:key", 60)).resolves.toBe(
      3
    )
    expect(redisMock.eval).toHaveBeenCalledWith(
      expect.stringContaining("INCR"),
      1,
      "rl:key",
      60
    )
  })

  it("increment coerces the redis reply to a number", async () => {
    redisMock.eval.mockResolvedValue("7")
    await expect(redisSecondaryStorage.increment!("rl:key", 60)).resolves.toBe(
      7
    )
  })
})

// Runs the increment script itself against an isolated Redis, so the TTL and
// self-heal behavior is asserted on keys, not on the Lua source text. Like
// the admission suite, it is skipped unless REDIS_TEST_URL is set.
describe.skipIf(!process.env.REDIS_TEST_URL)(
  "increment script against Redis",
  () => {
    async function fixture() {
      const client = new Redis(process.env.REDIS_TEST_URL!)
      const key = `rl-test:${Math.random().toString(36).slice(2)}`
      redisMock.eval.mockImplementation((script, numKeys, k, ttl) =>
        client.eval(script, numKeys, k, ttl)
      )
      return { client, key }
    }

    it("sets the TTL when the counter is created and keeps the window fixed", async () => {
      const { client, key } = await fixture()
      try {
        await expect(redisSecondaryStorage.increment!(key, 60)).resolves.toBe(1)
        expect(await client.ttl(key)).toBeGreaterThan(0)
        await client.expire(key, 30)
        await expect(redisSecondaryStorage.increment!(key, 60)).resolves.toBe(2)
        expect(await client.ttl(key)).toBeLessThanOrEqual(30)
      } finally {
        await client.del(key)
        client.disconnect()
      }
    })

    it("self-heals a non-counter value left by the legacy fallback", async () => {
      const { client, key } = await fixture()
      try {
        await client.set(key, JSON.stringify({ count: 4 }))
        await expect(redisSecondaryStorage.increment!(key, 60)).resolves.toBe(1)
        expect(await client.get(key)).toBe("1")
        expect(await client.ttl(key)).toBeGreaterThan(0)
      } finally {
        await client.del(key)
        client.disconnect()
      }
    })
  }
)
