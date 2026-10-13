import { describe, expect, it } from "vitest"
import { matchingRightId, sanitizeQuestion } from "@/lib/exam-session"
import { asTypedQuestion, rubricOf } from "@/lib/types/questions"

const rubric = [{ id: "r1", criterion: "Begründung", points: 2 }]

describe("rubricOf", () => {
  it("returns the rubric of FREE_TEXT and SHORT_ANSWER questions", () => {
    expect(
      rubricOf({
        type: "FREE_TEXT",
        config: { maxLength: 500, richText: false, rubric },
      })
    ).toEqual(rubric)
    expect(
      rubricOf({
        type: "SHORT_ANSWER",
        config: {
          acceptedAnswers: ["Bern"],
          caseSensitive: false,
          maxLength: 100,
          rubric,
        },
      })
    ).toEqual(rubric)
  })

  it("is undefined for types without a rubric", () => {
    expect(rubricOf({ type: "TRUE_FALSE", config: { isCorrect: true } })).toBe(
      undefined
    )
  })
})

describe("asTypedQuestion", () => {
  it("keeps the row's other fields untouched", () => {
    const row = {
      id: "q1",
      title: "Frage",
      type: "TRUE_FALSE",
      config: { isCorrect: false },
    }
    expect(asTypedQuestion(row)).toBe(row)
  })
})

describe("sanitizeQuestion", () => {
  it("replaces the config with the student view and keeps the row", () => {
    const q = sanitizeQuestion({
      id: "q1",
      title: "Wahr oder falsch?",
      type: "TRUE_FALSE" as const,
      config: { isCorrect: true },
    })
    expect(q).toEqual({
      id: "q1",
      title: "Wahr oder falsch?",
      type: "TRUE_FALSE",
      config: {},
    })
  })

  it("hides MATCHING pairs behind per-session right ids", () => {
    const seed = "session1:q2"
    const q = sanitizeQuestion(
      {
        id: "q2",
        type: "MATCHING" as const,
        config: {
          pairs: [
            { id: "p1", left: "CH", right: "Bern" },
            { id: "p2", left: "DE", right: "Berlin" },
          ],
          shuffleSides: false,
        },
      },
      seed
    )
    if (q.type !== "MATCHING") throw new Error("type lost")
    expect(q.config.left.map((l) => l.id)).toEqual(["p1", "p2"])
    // The right side is keyed-shuffled, so compare ids as a SET — asserting a
    // fixed order would re-encode the pairing leak the shuffle prevents.
    expect(new Set(q.config.right.map((r) => r.id))).toEqual(
      new Set([matchingRightId(seed, "p1"), matchingRightId(seed, "p2")])
    )
    expect(JSON.stringify(q)).not.toContain('"pairs"')
  })

  it("never leaks MULTIPLE_CHOICE solutions", () => {
    const q = sanitizeQuestion({
      type: "MULTIPLE_CHOICE" as const,
      config: {
        multiSelect: false,
        options: [
          { id: "a", text: "Ja", isCorrect: true },
          { id: "b", text: "Nein", isCorrect: false },
        ],
      },
    })
    if (q.type !== "MULTIPLE_CHOICE") throw new Error("type lost")
    expect(q.config.options.every((o) => o.isCorrect === false)).toBe(true)
  })
})
