import { describe, expect, it } from "vitest"
import {
  answerContentSchema,
  submitAnswerSchema,
} from "@/lib/validators/answer"

describe("answerContentSchema", () => {
  it("accepts a valid answer for each question type", () => {
    const valid = [
      { type: "MULTIPLE_CHOICE", selectedOptionIds: ["a", "b"] },
      { type: "FREE_TEXT", text: "Meine Antwort" },
      { type: "FILL_IN_THE_BLANK", blanks: [{ id: "b1", value: "Bern" }] },
      // Must be a key the upload route could have minted — see answer-file-key.test.ts.
      {
        type: "FILE_UPLOAD",
        fileKey:
          "sessions/clx1session/clx1question/3f2504e0-4f89-41d3-9a0c-0305e82c3301.pdf",
        fileName: "x.pdf",
      },
      { type: "MATCHING", matches: [{ leftId: "p1", rightId: "abc123" }] },
      { type: "CODE", code: "print('hi')", language: "python" },
      { type: "TRUE_FALSE", selected: true },
      { type: "SHORT_ANSWER", text: "Bern" },
      { type: "ORDERING", orderedIds: ["a", "b", "c"] },
    ]
    for (const content of valid) {
      expect(answerContentSchema.safeParse(content).success).toBe(true)
    }
  })

  it("rejects a TRUE_FALSE answer with a non-boolean selected", () => {
    expect(
      answerContentSchema.safeParse({ type: "TRUE_FALSE", selected: "true" })
        .success
    ).toBe(false)
  })

  it("caps SHORT_ANSWER text length at 1000 characters", () => {
    expect(
      answerContentSchema.safeParse({
        type: "SHORT_ANSWER",
        text: "x".repeat(1000),
      }).success
    ).toBe(true)
    expect(
      answerContentSchema.safeParse({
        type: "SHORT_ANSWER",
        text: "x".repeat(1001),
      }).success
    ).toBe(false)
  })

  it("caps the number of ORDERING ids so autosave payloads stay bounded", () => {
    const orderedIds = Array.from({ length: 201 }, (_, i) => `i${i}`)
    expect(
      answerContentSchema.safeParse({ type: "ORDERING", orderedIds }).success
    ).toBe(false)
  })

  it("rejects unknown answer types", () => {
    expect(
      answerContentSchema.safeParse({ type: "ESSAY", text: "x" }).success
    ).toBe(false)
  })

  it("rejects payloads shaped for a different type", () => {
    expect(
      answerContentSchema.safeParse({
        type: "FREE_TEXT",
        selectedOptionIds: [],
      }).success
    ).toBe(false)
  })

  it("caps free-text length at 30000 characters", () => {
    expect(
      answerContentSchema.safeParse({
        type: "FREE_TEXT",
        text: "x".repeat(30000),
      }).success
    ).toBe(true)
    expect(
      answerContentSchema.safeParse({
        type: "FREE_TEXT",
        text: "x".repeat(30001),
      }).success
    ).toBe(false)
  })

  it("caps the number of matches so autosave payloads stay bounded", () => {
    const matches = Array.from({ length: 201 }, (_, i) => ({
      leftId: `l${i}`,
      rightId: `r${i}`,
    }))
    expect(
      answerContentSchema.safeParse({ type: "MATCHING", matches }).success
    ).toBe(false)
  })

  it("rejects oversized opaque ids", () => {
    expect(
      answerContentSchema.safeParse({
        type: "MULTIPLE_CHOICE",
        selectedOptionIds: ["x".repeat(129)],
      }).success
    ).toBe(false)
  })
})

describe("submitAnswerSchema clientSeq", () => {
  const base = {
    questionId: "clx1question0000000000000",
    content: { type: "TRUE_FALSE", selected: true },
  }

  it("is optional, so clients from before the field keep saving", () => {
    expect(submitAnswerSchema.safeParse(base).success).toBe(true)
  })

  it("accepts a positive safe integer", () => {
    for (const clientSeq of [1, 1_790_000_000_123, Number.MAX_SAFE_INTEGER]) {
      expect(submitAnswerSchema.safeParse({ ...base, clientSeq }).success).toBe(
        true
      )
    }
  })

  it("rejects values the double-precision column can't order exactly", () => {
    for (const clientSeq of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "5"]) {
      expect(submitAnswerSchema.safeParse({ ...base, clientSeq }).success).toBe(
        false
      )
    }
  })
})
