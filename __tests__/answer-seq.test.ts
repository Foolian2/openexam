import { describe, expect, it } from "vitest"
import { createClientSeq } from "@/lib/answer-seq"

describe("createClientSeq", () => {
  it("issues the clock time when it is ahead of the last value", () => {
    let now = 1_000
    const seq = createClientSeq(() => now)
    expect(seq.next()).toBe(1_000)
    now = 5_000
    expect(seq.next()).toBe(5_000)
  })

  it("stays strictly increasing within one millisecond and when the clock steps back", () => {
    let now = 1_000
    const seq = createClientSeq(() => now)
    expect(seq.next()).toBe(1_000)
    expect(seq.next()).toBe(1_001)
    now = 500
    expect(seq.next()).toBe(1_002)
  })

  it("issues values above what the server already holds when this clock lags", () => {
    const seq = createClientSeq(() => 1_000)
    seq.observe(9_000)
    seq.observe(null)
    seq.observe(undefined)
    seq.observe(4_000)
    expect(seq.next()).toBe(9_001)
  })

  it("ignores non-finite observed values", () => {
    const seq = createClientSeq(() => 1_000)
    seq.observe(Number.POSITIVE_INFINITY)
    seq.observe(Number.NaN)
    expect(seq.next()).toBe(1_000)
  })
})
