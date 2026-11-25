import { beforeEach, describe, expect, it, vi } from "vitest"

const get = vi.hoisted(() => vi.fn())
vi.mock("@/lib/redis", () => ({ redis: { get } }))

import { underRateLimit } from "@/lib/rate-limit"

beforeEach(() => {
  get.mockReset()
})

describe("underRateLimit", () => {
  it("reads the same counter rateLimit writes, without counting a hit", async () => {
    get.mockResolvedValue("49")
    expect(await underRateLimit("login-failed-ip:1.2.3.4", 50)).toBe(true)
    expect(get).toHaveBeenCalledWith("ratelimit:login-failed-ip:1.2.3.4")
  })

  it("is false once the counter reaches the limit", async () => {
    get.mockResolvedValue("50")
    expect(await underRateLimit("k", 50)).toBe(false)
  })

  it("treats a missing counter as zero and fails open on Redis errors", async () => {
    get.mockResolvedValue(null)
    expect(await underRateLimit("k", 1)).toBe(true)
    get.mockRejectedValue(new Error("down"))
    expect(await underRateLimit("k", 1)).toBe(true)
  })
})
