import { describe, expect, it } from "vitest"
import {
  computeEffectiveEndTime,
  extendEffectiveEndTime,
  keyedShuffle,
  matchingRightId,
  sanitizeQuestionConfig,
  seededShuffle,
} from "@/lib/exam-session"
import type {
  MCConfig,
  FillBlankConfig,
  MatchingConfig,
  CodeConfig,
  SanitizedMatchingConfig,
  TrueFalseConfig,
  ShortAnswerConfig,
  OrderingConfig,
} from "@/lib/types/questions"

describe("computeEffectiveEndTime", () => {
  const startedAt = new Date("2026-07-13T08:00:00Z")

  it("adds the time limit to the start time", () => {
    expect(computeEffectiveEndTime(startedAt, 45, 0)).toEqual(
      new Date("2026-07-13T08:45:00Z")
    )
  })

  it("adds time extensions on top of the limit", () => {
    // 45 min exam + NAM extension of ceil(45 * 0.15) = 7 min
    expect(computeEffectiveEndTime(startedAt, 45, 7)).toEqual(
      new Date("2026-07-13T08:52:00Z")
    )
  })
})

describe("extendEffectiveEndTime", () => {
  it("pushes the existing deadline out by the granted minutes", () => {
    expect(extendEffectiveEndTime(new Date("2026-07-13T08:52:00Z"), 5)).toEqual(
      new Date("2026-07-13T08:57:00Z")
    )
  })

  it("does not depend on the exam's time limit at all", () => {
    // The whole point of the additive form: a mid-exam edit of the exam's
    // timeLimitMin must not retroactively shift already-granted extensions.
    const before = new Date("2026-07-13T08:52:00Z")
    expect(extendEffectiveEndTime(before, 7).getTime() - before.getTime()).toBe(
      7 * 60_000
    )
  })
})

describe("matchingRightId", () => {
  it("is deterministic for the same seed and pair id", () => {
    expect(matchingRightId("s:q", "p1")).toBe(matchingRightId("s:q", "p1"))
  })

  it("differs across seeds and across pair ids", () => {
    const id = matchingRightId("s:q", "p1")
    expect(matchingRightId("other:q", "p1")).not.toBe(id)
    expect(matchingRightId("s:q", "p2")).not.toBe(id)
  })

  it("returns a 16-char hex string that does not contain the inputs", () => {
    const id = matchingRightId("session123:question456", "pair789")
    expect(id).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe("sanitizeQuestionConfig", () => {
  it("strips isCorrect flags from MULTIPLE_CHOICE options", () => {
    const config: MCConfig = {
      multiSelect: false,
      options: [
        { id: "a", text: "Right", isCorrect: true },
        { id: "b", text: "Wrong", isCorrect: false },
      ],
    }
    const sanitized = sanitizeQuestionConfig("MULTIPLE_CHOICE", config) as MCConfig
    expect(sanitized.options.every((o) => o.isCorrect === false)).toBe(true)
    expect(sanitized.options.map((o) => o.text)).toEqual(["Right", "Wrong"])
  })

  it("strips accepted answers from FILL_IN_THE_BLANK blanks", () => {
    const config: FillBlankConfig = {
      template: "{1}",
      blanks: [{ id: "b1", acceptedAnswers: ["secret"], caseSensitive: false }],
    }
    const sanitized = sanitizeQuestionConfig(
      "FILL_IN_THE_BLANK",
      config
    ) as FillBlankConfig
    expect(sanitized.blanks[0].acceptedAnswers).toEqual([])
    expect(JSON.stringify(sanitized)).not.toContain("secret")
  })

  it("strips expected output and hidden test cases from CODE configs", () => {
    const config: CodeConfig = {
      language: "python",
      starterCode: "print()",
      testCases: [
        { input: "1", expectedOutput: "2", hidden: false, points: 1 },
        { input: "3", expectedOutput: "4", hidden: true, points: 2 },
      ],
    }
    const sanitized = sanitizeQuestionConfig("CODE", config) as CodeConfig
    expect(sanitized.testCases).toHaveLength(1)
    expect(sanitized.testCases[0].expectedOutput).toBe("")
    const json = JSON.stringify(sanitized)
    expect(json).not.toContain('"2"') // visible case's expected output
    expect(json).not.toContain('"3"') // hidden case's input
    expect(json).not.toContain('"4"') // hidden case's expected output
  })

  it("decouples MATCHING pairs into left/right lists with opaque right ids", () => {
    const config: MatchingConfig = {
      pairs: [
        { id: "p1", left: "H2O", right: "Wasser" },
        { id: "p2", left: "NaCl", right: "Kochsalz" },
      ],
      shuffleSides: false,
    }
    const seed = "session1:question1"
    const sanitized = sanitizeQuestionConfig(
      "MATCHING",
      config,
      seed
    ) as SanitizedMatchingConfig
    expect(sanitized.left.map((l) => l.id)).toEqual(["p1", "p2"])
    // Right-side ids must be the HMAC-derived opaque ids, never the pair ids —
    // the id coupling is the solution. Compared as a SET: the right side is
    // keyed-shuffled, so its order must not be asserted (asserting pair order
    // would re-encode the very leak this guards against).
    expect(new Set(sanitized.right.map((r) => r.id))).toEqual(
      new Set([matchingRightId(seed, "p1"), matchingRightId(seed, "p2")])
    )
    expect(JSON.stringify(sanitized.right)).not.toContain("p1")
  })

  it("does not let a student invert the MATCHING pairing from the seed alone", () => {
    // Regression for the confirmed leak: the right side used to be permuted
    // with the unkeyed seededShuffle (seed = sessionId:questionId, both known
    // to the client) OR left pair-aligned when shuffleSides=false. Either way a
    // student could map each displayed right item back to its original pair
    // index and recover every answer. Try BOTH attacks and require that
    // neither yields a full recovery.
    for (const shuffleSides of [true, false]) {
      const n = 10
      const config: MatchingConfig = {
        pairs: Array.from({ length: n }, (_, i) => ({
          id: `p${i}`,
          left: `L${i}`,
          right: `R${i}`,
        })),
        shuffleSides,
      }
      const seed = "session1:question1"
      const sanitized = sanitizeQuestionConfig(
        "MATCHING",
        config,
        seed
      ) as SanitizedMatchingConfig

      // Ground truth: left p{i} pairs with the HMAC id for p{i}.
      const correctRightForLeft = new Map(
        config.pairs.map((p) => [p.id, matchingRightId(seed, p.id)])
      )

      // Attack A — replay the unkeyed shuffle over positions and invert it.
      const perm = seededShuffle([...Array(n).keys()], seed)
      const guessA = new Map<string, string>()
      perm.forEach((originalIndex, displayPos) => {
        guessA.set(config.pairs[originalIndex].id, sanitized.right[displayPos].id)
      })
      // Attack B — assume position alignment (the old shuffleSides=false case).
      const guessB = new Map(
        config.pairs.map((p, i) => [p.id, sanitized.right[i].id])
      )

      for (const guess of [guessA, guessB]) {
        const recovered = config.pairs.filter(
          (p) => guess.get(p.id) === correctRightForLeft.get(p.id)
        ).length
        expect(recovered).toBeLessThan(n)
      }
    }
  })

  it("throws when sanitizing a MATCHING config without a seed", () => {
    const config: MatchingConfig = { pairs: [], shuffleSides: false }
    expect(() => sanitizeQuestionConfig("MATCHING", config)).toThrow()
  })

  it("returns an empty MATCHING config for malformed input instead of crashing", () => {
    const sanitized = sanitizeQuestionConfig(
      "MATCHING",
      null,
      "s:q"
    ) as SanitizedMatchingConfig
    expect(sanitized).toEqual({ left: [], right: [], shuffleSides: false })
  })

  it("strips isCorrect from TRUE_FALSE configs (returns an empty object)", () => {
    const config: TrueFalseConfig = { isCorrect: true }
    const sanitized = sanitizeQuestionConfig("TRUE_FALSE", config)
    expect(sanitized).toEqual({})
    expect(JSON.stringify(sanitized)).not.toContain("isCorrect")
  })

  it("strips acceptedAnswers from SHORT_ANSWER but keeps maxLength and caseSensitive", () => {
    const config: ShortAnswerConfig = {
      acceptedAnswers: ["Bern", "berne"],
      caseSensitive: false,
      maxLength: 200,
    }
    const sanitized = sanitizeQuestionConfig(
      "SHORT_ANSWER",
      config
    ) as { maxLength: number; caseSensitive: boolean }
    expect(sanitized).toEqual({ maxLength: 200, caseSensitive: false })
    expect(JSON.stringify(sanitized)).not.toContain("Bern")
    expect(JSON.stringify(sanitized)).not.toContain("berne")
    expect(JSON.stringify(sanitized)).not.toContain("acceptedAnswers")
  })

  it("shuffles ORDERING items server-side without leaking the correct order", () => {
    const config: OrderingConfig = {
      items: [
        { id: "1", text: "Erstes" },
        { id: "2", text: "Zweites" },
        { id: "3", text: "Drittes" },
        { id: "4", text: "Viertes" },
      ],
      shuffle: true,
    }
    const seed = "session1:question1"
    const sanitized = sanitizeQuestionConfig(
      "ORDERING",
      config,
      seed
    ) as OrderingConfig
    // All ids and texts remain present.
    expect([...sanitized.items.map((i) => i.id)].sort()).toEqual(["1", "2", "3", "4"])
    expect([...sanitized.items.map((i) => i.text)].sort()).toEqual([
      "Drittes",
      "Erstes",
      "Viertes",
      "Zweites",
    ])
    // The displayed order is deterministic per seed so reloads keep it stable.
    const again = sanitizeQuestionConfig(
      "ORDERING",
      config,
      seed
    ) as OrderingConfig
    expect(again.items.map((i) => i.id)).toEqual(sanitized.items.map((i) => i.id))
    // ...and it comes from the keyed shuffle, not the unkeyed one.
    expect(sanitized.items).toEqual(
      keyedShuffle(
        config.items.map((i) => ({ id: i.id, text: i.text })),
        seed
      )
    )
  })

  it("shows a 2-item ORDERING question in both orders across seeds", () => {
    // Deliberately NOT "the display never equals the correct order". Forcing
    // the displayed order to always differ turns it into an oracle: with two
    // items there are only two orders, so "never correct" means "always the
    // reverse of correct", and the student just flips it back for full marks.
    // A uniform keyed shuffle must therefore land on the correct order about
    // half the time — that is the absence of a leak, not a leak.
    const config: OrderingConfig = {
      items: [
        { id: "1", text: "Erstes" },
        { id: "2", text: "Zweites" },
      ],
      shuffle: true,
    }
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const sanitized = sanitizeQuestionConfig(
        "ORDERING",
        config,
        `session${i}:question1`
      ) as OrderingConfig
      seen.add(sanitized.items.map((it) => it.id).join(","))
    }
    expect([...seen].sort()).toEqual(["1,2", "2,1"])
  })

  it("permutes ORDERING items even when the teacher sets shuffle to false", () => {
    // "Don't shuffle" would mean displaying the stored order — which IS the
    // solution — so the flag must not be able to switch the permutation off.
    const config: OrderingConfig = {
      items: [
        { id: "1", text: "Erstes" },
        { id: "2", text: "Zweites" },
        { id: "3", text: "Drittes" },
        { id: "4", text: "Viertes" },
        { id: "5", text: "Fünftes" },
        { id: "6", text: "Sechstes" },
      ],
      shuffle: false,
    }
    const sanitized = sanitizeQuestionConfig("ORDERING", config, "s:q") as OrderingConfig
    const canonical = config.items.map((i) => i.id)
    const shown = sanitized.items.map((i) => i.id)
    expect(shown).not.toEqual(canonical)
    // Specifically: not the old reverse() behaviour, which the student could
    // simply flip back to recover the answer key.
    expect(shown).not.toEqual([...canonical].reverse())
    expect(sanitized.shuffle).toBe(false)
  })

  it("does not let a student invert the ORDERING permutation from the seed alone", () => {
    // The seed is `${sessionId}:${questionId}` — the student's own client knows
    // both halves. If the permutation were derived from an unkeyed PRNG over
    // that seed (seededShuffle), replaying it on a marked array and inverting
    // recovers the stored order, i.e. the answer key. It must not.
    const config: OrderingConfig = {
      items: [
        { id: "1", text: "Erstes" },
        { id: "2", text: "Zweites" },
        { id: "3", text: "Drittes" },
        { id: "4", text: "Viertes" },
        { id: "5", text: "Fünftes" },
        { id: "6", text: "Sechstes" },
      ],
      shuffle: true,
    }
    const seed = "session1:question1"
    const shown = (sanitizeQuestionConfig("ORDERING", config, seed) as OrderingConfig).items

    // The attack, verbatim: replay the unkeyed shuffle over the positions and
    // undo it against what the browser was served.
    const positions = config.items.map((_, i) => i)
    const permutation = seededShuffle(positions, seed)
    const recovered: string[] = new Array(config.items.length)
    permutation.forEach((originalIndex, displayIndex) => {
      recovered[originalIndex] = shown[displayIndex].id
    })

    expect(recovered).not.toEqual(config.items.map((i) => i.id))
  })

  it("throws when sanitizing an ORDERING config without a seed", () => {
    const config: OrderingConfig = {
      items: [
        { id: "1", text: "A" },
        { id: "2", text: "B" },
      ],
      shuffle: true,
    }
    expect(() => sanitizeQuestionConfig("ORDERING", config)).toThrow()
  })

  it("returns an empty ORDERING config for malformed input instead of crashing", () => {
    const sanitized = sanitizeQuestionConfig(
      "ORDERING",
      null,
      "s:q"
    ) as OrderingConfig
    expect(sanitized).toEqual({ items: [], shuffle: false })
  })
})

describe("seededShuffle", () => {
  const items = ["a", "b", "c", "d", "e", "f", "g", "h"]

  it("is deterministic for the same seed", () => {
    expect(seededShuffle(items, "seed-1")).toEqual(seededShuffle(items, "seed-1"))
  })

  it("produces different orders for different seeds", () => {
    expect(seededShuffle(items, "seed-1")).not.toEqual(seededShuffle(items, "seed-2"))
  })

  it("returns a permutation without mutating the input", () => {
    const copy = [...items]
    const shuffled = seededShuffle(items, "seed-1")
    expect(items).toEqual(copy)
    expect([...shuffled].sort()).toEqual([...items].sort())
  })
})
