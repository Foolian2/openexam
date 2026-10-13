import { beforeEach, describe, expect, it, vi } from "vitest"

const redisMock = vi.hoisted(() => ({
  set: vi.fn<(key: string, value: string, mode: string, ttl: number) => Promise<string>>(),
  get: vi.fn<(key: string) => Promise<string | null>>(),
  getdel: vi.fn<(key: string) => Promise<string | null>>(),
}))

vi.mock("@/lib/redis", () => ({ redis: redisMock }))

import { mintLaunchToken, consumeLaunchToken, peekLaunchToken } from "@/lib/seb-launch-token"

beforeEach(() => {
  vi.clearAllMocks()
  redisMock.set.mockResolvedValue("OK")
})

const TOKEN = /^[0-9a-f]{64}$/

describe("mintLaunchToken", () => {
  it("returns a 32-byte hex token", async () => {
    const token = await mintLaunchToken({ userId: "u1", examId: "e1" })
    expect(token).toMatch(TOKEN)
  })

  it("stores the payload under the seb:lt: prefix with a 300s TTL", async () => {
    await mintLaunchToken({ userId: "u1", examId: "e1" })
    const [key, value, mode, ttl] = redisMock.set.mock.calls[0]
    expect(key).toMatch(/^seb:lt:[0-9a-f]{64}$/)
    expect(JSON.parse(value)).toEqual({ v: 1, userId: "u1", examId: "e1" })
    expect(mode).toBe("EX")
    expect(ttl).toBe(300)
  })

  it("mints unique tokens on successive calls", async () => {
    const a = await mintLaunchToken({ userId: "u1", examId: "e1" })
    const b = await mintLaunchToken({ userId: "u1", examId: "e1" })
    expect(a).not.toBe(b)
  })
})

describe("consumeLaunchToken", () => {
  it("decodes and returns the payload for a valid, matching token", async () => {
    redisMock.getdel.mockResolvedValue(JSON.stringify({ v: 1, userId: "u1", examId: "e1" }))
    const result = await consumeLaunchToken("deadbeef", "e1")
    expect(result).toEqual({ userId: "u1", examId: "e1" })
  })

  it("is single-use: atomically gets and deletes the token", async () => {
    redisMock.getdel.mockResolvedValue(JSON.stringify({ v: 1, userId: "u1", examId: "e1" }))
    await consumeLaunchToken("deadbeef", "e1")
    expect(redisMock.getdel).toHaveBeenCalledWith("seb:lt:deadbeef")
  })

  it("returns null when the token is missing or expired (getdel -> null)", async () => {
    redisMock.getdel.mockResolvedValue(null)
    const result = await consumeLaunchToken("deadbeef", "e1")
    expect(result).toBeNull()
    expect(redisMock.getdel).toHaveBeenCalledWith("seb:lt:deadbeef")
  })

  it("returns null when the examId does not match", async () => {
    redisMock.getdel.mockResolvedValue(JSON.stringify({ v: 1, userId: "u1", examId: "e1" }))
    const result = await consumeLaunchToken("deadbeef", "other-exam")
    expect(result).toBeNull()
  })

  it("returns null on corrupted storage", async () => {
    redisMock.getdel.mockResolvedValue("not-json")
    const result = await consumeLaunchToken("deadbeef", "e1")
    expect(result).toBeNull()
  })

  it("returns null on a malformed payload", async () => {
    redisMock.getdel.mockResolvedValue(JSON.stringify({ v: 1, userId: "u1" }))
    const result = await consumeLaunchToken("deadbeef", "e1")
    expect(result).toBeNull()
  })

  it("returns null for an empty token string", async () => {
    const result = await consumeLaunchToken("", "e1")
    expect(result).toBeNull()
    expect(redisMock.getdel).not.toHaveBeenCalled()
  })
})

// Regression: SEB always sends a HEAD request immediately before the real
// GET when resolving a seb:// link. The route's HEAD handler must check the
// token with peekLaunchToken (a plain GET), not consumeLaunchToken (GETDEL)
// — otherwise the HEAD request burns the single-use token and the real GET
// that follows always 401s as "Ungültiger oder abgelaufener Start-Link".
describe("peekLaunchToken", () => {
  it("returns true for a valid, matching token without deleting it", async () => {
    redisMock.get.mockResolvedValue(JSON.stringify({ v: 1, userId: "u1", examId: "e1" }))
    const result = await peekLaunchToken("deadbeef", "e1")
    expect(result).toBe(true)
    expect(redisMock.get).toHaveBeenCalledWith("seb:lt:deadbeef")
    expect(redisMock.getdel).not.toHaveBeenCalled()
  })

  it("returns false when the token is missing or expired", async () => {
    redisMock.get.mockResolvedValue(null)
    expect(await peekLaunchToken("deadbeef", "e1")).toBe(false)
  })

  it("returns false when the examId does not match", async () => {
    redisMock.get.mockResolvedValue(JSON.stringify({ v: 1, userId: "u1", examId: "e1" }))
    expect(await peekLaunchToken("deadbeef", "other-exam")).toBe(false)
  })

  it("returns false on corrupted storage", async () => {
    redisMock.get.mockResolvedValue("not-json")
    expect(await peekLaunchToken("deadbeef", "e1")).toBe(false)
  })

  it("returns false for an empty token string", async () => {
    expect(await peekLaunchToken("", "e1")).toBe(false)
    expect(redisMock.get).not.toHaveBeenCalled()
  })

  it("leaves the token consumable: peek followed by consume both succeed", async () => {
    const stored = JSON.stringify({ v: 1, userId: "u1", examId: "e1" })
    redisMock.get.mockResolvedValue(stored)
    redisMock.getdel.mockResolvedValue(stored)

    expect(await peekLaunchToken("deadbeef", "e1")).toBe(true)
    const consumed = await consumeLaunchToken("deadbeef", "e1")
    expect(consumed).toEqual({ userId: "u1", examId: "e1" })
  })
})