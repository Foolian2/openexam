import { describe, expect, it } from "vitest"
import { generateAccessCode } from "@/lib/access-code"

describe("generateAccessCode", () => {
  it("generates 6-character codes", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateAccessCode()).toHaveLength(6)
    }
  })

  it("only uses unambiguous uppercase characters (no 0, O, 1, I)", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateAccessCode()).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/)
    }
  })

  it("does not generate the same code every time", () => {
    const codes = new Set(Array.from({ length: 50 }, generateAccessCode))
    expect(codes.size).toBeGreaterThan(1)
  })

  // 32-symbol alphabet, matches lib/access-code.ts's CHARS constant (not
  // exported, so mirrored here for the distribution checks below).
  const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

  it("produces near-fully-unique codes across a large sample", () => {
    // 32^6 ≈ 1.07B possible codes. With 5000 samples the birthday-paradox
    // expected collision count is ~0.01, so requiring 99%+ uniqueness is a
    // generous, effectively non-flaky bound (false-positive probability is
    // astronomically small) that still catches a degenerate generator (e.g.
    // one drawing from a tiny pool, or a broken/constant RNG).
    const SAMPLE = 5000
    const codes = new Set(Array.from({ length: SAMPLE }, generateAccessCode))
    expect(codes.size).toBeGreaterThan(SAMPLE * 0.99)
  })

  it("draws roughly uniformly from the full alphabet rather than a skewed subset", () => {
    // Every symbol in the 32-char alphabet should show up, and no symbol
    // should be wildly over/under-represented. With 3000 codes * 6 chars =
    // 18000 draws, expected count per symbol is 562.5 (std dev ~23.4), so a
    // 0.5x-1.5x band around the expected value is many standard deviations
    // wide — a fair RNG essentially never trips it, but a degenerate one
    // (e.g. always picking from a handful of characters) reliably does.
    const SAMPLE = 3000
    const counts = new Map<string, number>()
    for (let i = 0; i < SAMPLE; i++) {
      for (const ch of generateAccessCode()) {
        counts.set(ch, (counts.get(ch) ?? 0) + 1)
      }
    }
    expect(counts.size).toBe(ALPHABET.length)
    const expectedPerChar = (SAMPLE * 6) / ALPHABET.length
    for (const ch of ALPHABET) {
      const count = counts.get(ch) ?? 0
      expect(count).toBeGreaterThan(expectedPerChar * 0.5)
      expect(count).toBeLessThan(expectedPerChar * 1.5)
    }
  })
})
