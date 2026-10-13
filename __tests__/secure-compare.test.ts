import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"

// node:crypto's module namespace isn't configurable in ESM, so vi.spyOn on
// the live import fails ("Cannot redefine property"). vi.mock lets us swap
// in a vi.fn() wrapper that still calls through to the real implementation,
// which both lets us assert the call *and* keeps the actual constant-time
// comparison in effect for every other test in this file.
const { timingSafeEqualSpy } = vi.hoisted(() => ({
  timingSafeEqualSpy: vi.fn(),
}))

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>()
  timingSafeEqualSpy.mockImplementation(actual.timingSafeEqual)
  return {
    ...actual,
    timingSafeEqual: timingSafeEqualSpy,
  }
})

const { secureEqual } = await import("@/lib/secure-compare")

describe("secureEqual", () => {
  it("matches identical strings", () => {
    expect(secureEqual("abc", "abc")).toBe(true)
  })

  it("rejects different strings", () => {
    expect(secureEqual("abc", "abd")).toBe(false)
  })

  it("rejects different lengths", () => {
    expect(secureEqual("abc", "abcd")).toBe(false)
    expect(secureEqual("abcd", "abc")).toBe(false)
  })

  it("handles empty strings", () => {
    expect(secureEqual("", "")).toBe(true)
    expect(secureEqual("", "x")).toBe(false)
  })

  // The whole point of this module is to avoid a timing side-channel via a
  // short-circuiting `===`/localeCompare comparison. Assert the constant-time
  // primitive is what actually does the byte comparison, for both the
  // equal-length and mismatched-length paths (the module burns comparable
  // time on a length mismatch rather than returning early — see the comment
  // in lib/secure-compare.ts).
  it("delegates the equal-length comparison to crypto.timingSafeEqual", () => {
    timingSafeEqualSpy.mockClear()
    secureEqual("abc", "abd")
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1)
    expect(timingSafeEqualSpy).toHaveBeenCalledWith(
      Buffer.from("abc", "utf8"),
      Buffer.from("abd", "utf8")
    )
  })

  it("still calls timingSafeEqual (burning comparable time) on a length mismatch", () => {
    timingSafeEqualSpy.mockClear()
    secureEqual("abc", "abcd")
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1)
  })

  it("does not use a short-circuiting string comparison for the underlying check", () => {
    const source = readFileSync(
      new URL("../lib/secure-compare.ts", import.meta.url),
      "utf8"
    )
    expect(source).toMatch(/from ["']node:crypto["']/)
    expect(source).toMatch(/\btimingSafeEqual\(/)
    // A regression to `a === b` or `a.localeCompare(b)` would reintroduce the
    // timing side-channel this module exists to close.
    expect(source).not.toMatch(/return a === b/)
    expect(source).not.toMatch(/localeCompare/)
  })
})
