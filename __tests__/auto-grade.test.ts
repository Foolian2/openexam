import { describe, expect, it } from "vitest"
import { autoGrade } from "@/lib/grading/auto-grade"
import { matchingRightId } from "@/lib/exam-session"
import type {
  MCConfig,
  FillBlankConfig,
  MatchingConfig,
  TrueFalseConfig,
  ShortAnswerConfig,
  OrderingConfig,
} from "@/lib/types/questions"

const mcConfig: MCConfig = {
  multiSelect: true,
  options: [
    { id: "a", text: "A", isCorrect: true },
    { id: "b", text: "B", isCorrect: true },
    { id: "c", text: "C", isCorrect: false },
  ],
}

describe("autoGrade MULTIPLE_CHOICE", () => {
  it("awards full points for the exact correct set", () => {
    const result = autoGrade(
      "MULTIPLE_CHOICE",
      mcConfig,
      { type: "MULTIPLE_CHOICE", selectedOptionIds: ["b", "a"] },
      4
    )
    expect(result).toEqual({ points: 4, autoGraded: true })
  })

  it("awards zero for a partially correct selection (all-or-nothing)", () => {
    const result = autoGrade(
      "MULTIPLE_CHOICE",
      mcConfig,
      { type: "MULTIPLE_CHOICE", selectedOptionIds: ["a"] },
      4
    )
    expect(result).toEqual({ points: 0, autoGraded: true })
  })

  it("awards zero when a wrong option is included alongside all correct ones", () => {
    const result = autoGrade(
      "MULTIPLE_CHOICE",
      mcConfig,
      { type: "MULTIPLE_CHOICE", selectedOptionIds: ["a", "b", "c"] },
      4
    )
    expect(result?.points).toBe(0)
  })

  it("grades a missing answer as zero", () => {
    const result = autoGrade("MULTIPLE_CHOICE", mcConfig, null, 4)
    expect(result).toEqual({ points: 0, autoGraded: true })
  })

  it("returns null on answer type mismatch", () => {
    const result = autoGrade(
      "MULTIPLE_CHOICE",
      mcConfig,
      { type: "FREE_TEXT", text: "hi" },
      4
    )
    expect(result).toBeNull()
  })
})

const fillBlankConfig: FillBlankConfig = {
  template: "The capital of {1} is {2}.",
  blanks: [
    {
      id: "b1",
      acceptedAnswers: ["Schweiz", "Switzerland"],
      caseSensitive: false,
    },
    { id: "b2", acceptedAnswers: ["Bern"], caseSensitive: true },
  ],
}

describe("autoGrade FILL_IN_THE_BLANK", () => {
  it("awards proportional points per correct blank", () => {
    const result = autoGrade(
      "FILL_IN_THE_BLANK",
      fillBlankConfig,
      {
        type: "FILL_IN_THE_BLANK",
        blanks: [
          { id: "b1", value: "Schweiz" },
          { id: "b2", value: "Zürich" },
        ],
      },
      3
    )
    // 1 of 2 blanks correct → 1.5 of 3 points
    expect(result?.points).toBe(1.5)
  })

  it("matches case-insensitively and trims whitespace when caseSensitive is false", () => {
    const result = autoGrade(
      "FILL_IN_THE_BLANK",
      fillBlankConfig,
      {
        type: "FILL_IN_THE_BLANK",
        blanks: [
          { id: "b1", value: "  switzerland " },
          { id: "b2", value: "Bern" },
        ],
      },
      2
    )
    expect(result?.points).toBe(2)
  })

  it("enforces case when caseSensitive is true", () => {
    const result = autoGrade(
      "FILL_IN_THE_BLANK",
      fillBlankConfig,
      {
        type: "FILL_IN_THE_BLANK",
        blanks: [{ id: "b2", value: "bern" }],
      },
      2
    )
    expect(result?.points).toBe(0)
  })

  it("rounds to the nearest half point", () => {
    const config: FillBlankConfig = {
      template: "{1} {2} {3}",
      blanks: [
        { id: "b1", acceptedAnswers: ["x"], caseSensitive: false },
        { id: "b2", acceptedAnswers: ["x"], caseSensitive: false },
        { id: "b3", acceptedAnswers: ["x"], caseSensitive: false },
      ],
    }
    const result = autoGrade(
      "FILL_IN_THE_BLANK",
      config,
      {
        type: "FILL_IN_THE_BLANK",
        blanks: [{ id: "b1", value: "x" }],
      },
      1
    )
    // 1/3 of 1 point = 0.333… → rounds to 0.5
    expect(result?.points).toBe(0.5)
  })

  it("grades an empty config as zero without dividing by zero", () => {
    const config: FillBlankConfig = { template: "", blanks: [] }
    const result = autoGrade("FILL_IN_THE_BLANK", config, null, 5)
    expect(result?.points).toBe(0)
  })
})

const matchingConfig: MatchingConfig = {
  pairs: [
    { id: "p1", left: "H2O", right: "Wasser" },
    { id: "p2", left: "NaCl", right: "Kochsalz" },
  ],
  shuffleSides: false,
}
const seed = "session1:question1"

describe("autoGrade MATCHING", () => {
  it("awards full points when every pair matches the HMAC-derived right id", () => {
    const result = autoGrade(
      "MATCHING",
      matchingConfig,
      {
        type: "MATCHING",
        matches: [
          { leftId: "p1", rightId: matchingRightId(seed, "p1") },
          { leftId: "p2", rightId: matchingRightId(seed, "p2") },
        ],
      },
      4,
      { matchingSeed: seed }
    )
    expect(result?.points).toBe(4)
  })

  it("awards proportional points for partially correct matches", () => {
    const result = autoGrade(
      "MATCHING",
      matchingConfig,
      {
        type: "MATCHING",
        matches: [
          { leftId: "p1", rightId: matchingRightId(seed, "p1") },
          { leftId: "p2", rightId: matchingRightId(seed, "p1") }, // wrong pairing
        ],
      },
      4,
      { matchingSeed: seed }
    )
    expect(result?.points).toBe(2)
  })

  it("ignores duplicated and fabricated left ids so the score cannot exceed maxPoints", () => {
    const correct = { leftId: "p1", rightId: matchingRightId(seed, "p1") }
    const result = autoGrade(
      "MATCHING",
      matchingConfig,
      {
        type: "MATCHING",
        matches: [
          correct,
          correct,
          correct,
          { leftId: "forged", rightId: matchingRightId(seed, "forged") },
        ],
      },
      4,
      { matchingSeed: seed }
    )
    expect(result?.points).toBe(2)
  })

  it("rejects right ids computed with a different session seed", () => {
    const result = autoGrade(
      "MATCHING",
      matchingConfig,
      {
        type: "MATCHING",
        matches: [
          { leftId: "p1", rightId: matchingRightId("other:seed", "p1") },
        ],
      },
      4,
      { matchingSeed: seed }
    )
    expect(result?.points).toBe(0)
  })

  it("returns null without a matching seed", () => {
    const result = autoGrade("MATCHING", matchingConfig, null, 4)
    expect(result).toBeNull()
  })

  it("returns null for a malformed config", () => {
    const result = autoGrade("MATCHING", { pairs: "nope" }, null, 4, {
      matchingSeed: seed,
    })
    expect(result).toBeNull()
  })
})

describe("autoGrade manual-only types", () => {
  it.each(["FREE_TEXT", "FILE_UPLOAD", "CODE"] as const)(
    "returns null for %s",
    (type) => {
      expect(autoGrade(type, {}, null, 5)).toBeNull()
    }
  )
})

const trueFalseConfig: TrueFalseConfig = { isCorrect: true }

describe("autoGrade TRUE_FALSE", () => {
  it("awards full points when the student selects the correct boolean", () => {
    const result = autoGrade(
      "TRUE_FALSE",
      trueFalseConfig,
      { type: "TRUE_FALSE", selected: true },
      2
    )
    expect(result?.points).toBe(2)
  })

  it("awards zero when the student selects the wrong boolean", () => {
    const result = autoGrade(
      "TRUE_FALSE",
      trueFalseConfig,
      { type: "TRUE_FALSE", selected: false },
      2
    )
    expect(result?.points).toBe(0)
  })

  it("awards zero when no answer was submitted", () => {
    const result = autoGrade("TRUE_FALSE", trueFalseConfig, null, 2)
    expect(result?.points).toBe(0)
  })

  it("awards full points when the correct answer is Falsch and the student selects Falsch", () => {
    const result = autoGrade(
      "TRUE_FALSE",
      { isCorrect: false },
      { type: "TRUE_FALSE", selected: false },
      3
    )
    expect(result?.points).toBe(3)
  })

  it("returns null on answer type mismatch", () => {
    const result = autoGrade(
      "TRUE_FALSE",
      trueFalseConfig,
      { type: "FREE_TEXT", text: "hi" },
      2
    )
    expect(result).toBeNull()
  })

  it("returns null instead of throwing for a null/malformed config", () => {
    expect(() =>
      autoGrade("TRUE_FALSE", null, { type: "TRUE_FALSE", selected: true }, 2)
    ).not.toThrow()
    expect(
      autoGrade("TRUE_FALSE", null, { type: "TRUE_FALSE", selected: true }, 2)
    ).toBeNull()
    expect(
      autoGrade(
        "TRUE_FALSE",
        { isCorrect: "yes" },
        { type: "TRUE_FALSE", selected: true },
        2
      )
    ).toBeNull()
  })
})

const shortAnswerConfig: ShortAnswerConfig = {
  acceptedAnswers: ["Bern", "Berne"],
  caseSensitive: false,
  maxLength: 200,
}

describe("autoGrade SHORT_ANSWER", () => {
  it("awards full points for a trimmed matching answer (case-insensitive)", () => {
    const result = autoGrade(
      "SHORT_ANSWER",
      shortAnswerConfig,
      { type: "SHORT_ANSWER", text: "  bern " },
      2
    )
    expect(result?.points).toBe(2)
  })

  it("matches an alternate accepted answer variant", () => {
    const result = autoGrade(
      "SHORT_ANSWER",
      shortAnswerConfig,
      { type: "SHORT_ANSWER", text: "Berne" },
      2
    )
    expect(result?.points).toBe(2)
  })

  it("awards zero for an incorrect answer", () => {
    const result = autoGrade(
      "SHORT_ANSWER",
      shortAnswerConfig,
      { type: "SHORT_ANSWER", text: "Zürich" },
      2
    )
    expect(result?.points).toBe(0)
  })

  it("awards zero for an empty/whitespace answer", () => {
    const result = autoGrade(
      "SHORT_ANSWER",
      shortAnswerConfig,
      { type: "SHORT_ANSWER", text: "   " },
      2
    )
    expect(result?.points).toBe(0)
  })

  it("awards zero for a missing answer", () => {
    const result = autoGrade("SHORT_ANSWER", shortAnswerConfig, null, 2)
    expect(result?.points).toBe(0)
  })

  it("respects caseSensitive=true (rejects case mismatch)", () => {
    const config: ShortAnswerConfig = {
      acceptedAnswers: ["Bern"],
      caseSensitive: true,
      maxLength: 100,
    }
    const result = autoGrade(
      "SHORT_ANSWER",
      config,
      { type: "SHORT_ANSWER", text: "bern" },
      2
    )
    expect(result?.points).toBe(0)
  })

  it("returns null on answer type mismatch", () => {
    const result = autoGrade(
      "SHORT_ANSWER",
      shortAnswerConfig,
      { type: "MULTIPLE_CHOICE", selectedOptionIds: ["x"] },
      2
    )
    expect(result).toBeNull()
  })

  it("returns null instead of throwing for a null/malformed config", () => {
    expect(() =>
      autoGrade("SHORT_ANSWER", null, { type: "SHORT_ANSWER", text: "Bern" }, 2)
    ).not.toThrow()
    expect(
      autoGrade("SHORT_ANSWER", null, { type: "SHORT_ANSWER", text: "Bern" }, 2)
    ).toBeNull()
    expect(
      autoGrade(
        "SHORT_ANSWER",
        { acceptedAnswers: "nope" },
        { type: "SHORT_ANSWER", text: "Bern" },
        2
      )
    ).toBeNull()
    expect(
      autoGrade(
        "SHORT_ANSWER",
        { acceptedAnswers: [123] },
        { type: "SHORT_ANSWER", text: "Bern" },
        2
      )
    ).toBeNull()
  })
})

const orderingConfig: OrderingConfig = {
  items: [
    { id: "a", text: "Erstes" },
    { id: "b", text: "Zweites" },
    { id: "c", text: "Drittes" },
    { id: "d", text: "Viertes" },
  ],
  shuffle: true,
}

describe("autoGrade ORDERING", () => {
  it("awards full points for a perfectly ordered submission", () => {
    const result = autoGrade(
      "ORDERING",
      orderingConfig,
      { type: "ORDERING", orderedIds: ["a", "b", "c", "d"] },
      4
    )
    expect(result?.points).toBe(4)
  })

  it("awards proportional points scaled to the fraction of correctly placed items", () => {
    // 2 of 4 positions correct → maxPoints * fraction = 4 * 2/4 = 2, which
    // already sits on the half-point grid so no rounding is involved.
    const result = autoGrade(
      "ORDERING",
      orderingConfig,
      { type: "ORDERING", orderedIds: ["a", "c", "b", "d"] },
      4
    )
    expect(result?.points).toBe(2)
  })

  it("awards zero when no item is in its correct position", () => {
    const result = autoGrade(
      "ORDERING",
      orderingConfig,
      { type: "ORDERING", orderedIds: ["d", "c", "b", "a"] },
      4
    )
    // Position 0: a vs d ✗; position 1: b vs c ✗; position 2: c vs b ✗;
    // position 3: d vs a ✗ — correctCount = 0, fraction = 0.
    expect(result?.points).toBe(0)
  })

  it("ignores extra submitted ids beyond the configured length", () => {
    const result = autoGrade(
      "ORDERING",
      orderingConfig,
      {
        type: "ORDERING",
        orderedIds: ["a", "b", "c", "d", "forged-1", "forged-2"],
      },
      4
    )
    expect(result?.points).toBe(4)
  })

  it("treats a partial submission with the first N correct items as proportional N/total", () => {
    // ["a","b"] → positions 3 and 4 are missing → correctCount = 2 → 2/4 = 0.5 → 2 pts.
    const result = autoGrade(
      "ORDERING",
      orderingConfig,
      { type: "ORDERING", orderedIds: ["a", "b"] },
      4
    )
    expect(result?.points).toBe(2)
  })

  it("rounds to the nearest half point", () => {
    // Only the first position is correct: ["a","c","d","b"] → 1 of 4 → 1/4.
    // With maxPoints = 1 the raw product is 0.25; the half-point grid rounds
    // that to 0.5, still within the maximum.
    const result = autoGrade(
      "ORDERING",
      orderingConfig,
      { type: "ORDERING", orderedIds: ["a", "c", "d", "b"] },
      1
    )
    expect(result?.points).toBe(0.5)
  })

  it("grades a missing answer as zero", () => {
    const result = autoGrade("ORDERING", orderingConfig, null, 4)
    expect(result?.points).toBe(0)
  })

  it("returns null for a malformed config", () => {
    const result = autoGrade("ORDERING", { items: "nope" }, null, 4)
    expect(result).toBeNull()
  })

  it("returns null on answer type mismatch", () => {
    const result = autoGrade(
      "ORDERING",
      orderingConfig,
      { type: "FREE_TEXT", text: "a" },
      4
    )
    expect(result).toBeNull()
  })

  it("handles an empty items array without dividing by zero", () => {
    const config: OrderingConfig = { items: [], shuffle: true }
    const result = autoGrade(
      "ORDERING",
      config,
      { type: "ORDERING", orderedIds: [] },
      4
    )
    expect(result?.points).toBe(0)
  })
})

describe("autoGrade Unicode normalization (NFC)", () => {
  // macOS/iOS keyboards emit decomposed characters (u + U+0308) while a teacher
  // typically stores the composed form (ü, U+00FC). Without NFC both render
  // identically but compare unequal, so a correct answer scored 0.
  const decomposed = "Zürich" // u + combining diaeresis
  const composed = "Zürich" // ü

  it("FILL_IN_THE_BLANK matches a decomposed submission against a composed answer", () => {
    const config: FillBlankConfig = {
      template: "{1}",
      blanks: [{ id: "b1", acceptedAnswers: [composed], caseSensitive: false }],
    }
    const result = autoGrade(
      "FILL_IN_THE_BLANK",
      config,
      { type: "FILL_IN_THE_BLANK", blanks: [{ id: "b1", value: decomposed }] },
      2
    )
    expect(result?.points).toBe(2)
  })

  it("SHORT_ANSWER matches a composed submission against a decomposed answer", () => {
    const result = autoGrade(
      "SHORT_ANSWER",
      { acceptedAnswers: [decomposed], caseSensitive: false, maxLength: 100 },
      { type: "SHORT_ANSWER", text: composed },
      2
    )
    expect(result?.points).toBe(2)
  })

  it("SHORT_ANSWER still fails a genuinely different answer", () => {
    const result = autoGrade(
      "SHORT_ANSWER",
      { acceptedAnswers: [composed], caseSensitive: false, maxLength: 100 },
      { type: "SHORT_ANSWER", text: "Genf" },
      2
    )
    expect(result?.points).toBe(0)
  })
})

describe("fractional question maxima", () => {
  it.each([0.1, 0.25, 0.75, 1.25, 1.8])(
    "preserves full credit and caps partial credit at %s",
    (maximum) => {
      const config: OrderingConfig = {
        items: [
          { id: "a", text: "A" },
          { id: "b", text: "B" },
        ],
        shuffle: false,
      }
      // Full credit is returned exactly, even for maxima below the half-point
      // grid (roundHalf used to award 0.5 for a 0.25 maximum).
      expect(
        autoGrade(
          "ORDERING",
          config,
          { type: "ORDERING", orderedIds: ["a", "b"] },
          maximum
        )?.points
      ).toBe(maximum)
      // Partial credit is rounded to the half-point grid, but the result must
      // stay inside [0, maximum].
      const partial = autoGrade(
        "ORDERING",
        config,
        { type: "ORDERING", orderedIds: ["a"] },
        maximum
      )!.points
      expect(partial).toBeGreaterThanOrEqual(0)
      expect(partial).toBeLessThanOrEqual(maximum)
    }
  )

  it("rounds bounded partial credit down to zero for a 0.25-point maximum", () => {
    // One of two items placed correctly on a 0.25 maximum is 0.125 raw
    // points; the half-point grid rounds that to 0. This pins the intentional
    // behaviour: partial credit keeps the half-point convention, while full
    // credit (asserted below) stays exact — never the 0.5 the old roundHalf
    // awarded for this maximum.
    const config: OrderingConfig = {
      items: [
        { id: "a", text: "A" },
        { id: "b", text: "B" },
      ],
      shuffle: false,
    }
    expect(
      autoGrade(
        "ORDERING",
        config,
        { type: "ORDERING", orderedIds: ["a"] },
        0.25
      )?.points
    ).toBe(0)
    expect(
      autoGrade(
        "ORDERING",
        config,
        { type: "ORDERING", orderedIds: ["a", "b"] },
        0.25
      )?.points
    ).toBe(0.25)
  })
})

it("preserves fractional full credit for matching and fill-in-the-blank too", () => {
  expect(
    autoGrade(
      "FILL_IN_THE_BLANK",
      fillBlankConfig,
      {
        type: "FILL_IN_THE_BLANK",
        blanks: [
          { id: "b1", value: "Schweiz" },
          { id: "b2", value: "Bern" },
        ],
      },
      0.25
    )?.points
  ).toBe(0.25)
  expect(
    autoGrade(
      "MATCHING",
      matchingConfig,
      {
        type: "MATCHING",
        matches: matchingConfig.pairs.map((p) => ({
          leftId: p.id,
          rightId: matchingRightId(seed, p.id),
        })),
      },
      1.25,
      { matchingSeed: seed }
    )?.points
  ).toBe(1.25)
})
