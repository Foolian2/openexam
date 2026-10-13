import { describe, expect, it, vi } from "vitest"

// node:crypto's module namespace isn't configurable in ESM, so vi.spyOn on
// the live import fails ("Cannot redefine property"). vi.mock lets us swap
// in a vi.fn() wrapper that still calls through to the real implementation,
// which both lets us assert the call *and* keeps real randomness in effect
// for every other test in this file.
const { randomBytesSpy } = vi.hoisted(() => ({
  randomBytesSpy: vi.fn(),
}))

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>()
  randomBytesSpy.mockImplementation(actual.randomBytes)
  return {
    ...actual,
    randomBytes: randomBytesSpy,
  }
})

const { generateShareToken } = await import("@/lib/question-bank-share")

describe("generateShareToken", () => {
  it("produces 32 hex chars (128 bits of entropy)", () => {
    const token = generateShareToken()
    expect(token).toMatch(/^[0-9a-f]{32}$/)
  })

  it("never repeats across calls", () => {
    const tokens = new Set(
      Array.from({ length: 100 }, () => generateShareToken())
    )
    expect(tokens.size).toBe(100)
  })

  // A regression to Math.random() would still pass the format/collision
  // tests above (Math.random() rarely collides in 100 draws either) but
  // would make tokens predictable. Assert the CSPRNG is actually the thing
  // producing the bytes.
  it("uses a CSPRNG (crypto.randomBytes), not Math.random", () => {
    randomBytesSpy.mockClear()
    generateShareToken()
    expect(randomBytesSpy).toHaveBeenCalledTimes(1)
    expect(randomBytesSpy).toHaveBeenCalledWith(16)
  })
})
