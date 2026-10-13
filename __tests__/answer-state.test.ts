import { describe, expect, it } from "vitest"
import { isAnswerEmpty } from "@/lib/answer-state"

describe("isAnswerEmpty", () => {
  it("returns true when no answer exists", () => {
    expect(isAnswerEmpty("FREE_TEXT", undefined)).toBe(true)
    expect(isAnswerEmpty("FREE_TEXT", null)).toBe(true)
  })

  it("MULTIPLE_CHOICE is empty without selected options", () => {
    expect(
      isAnswerEmpty("MULTIPLE_CHOICE", {
        type: "MULTIPLE_CHOICE",
        selectedOptionIds: [],
      })
    ).toBe(true)
    expect(
      isAnswerEmpty("MULTIPLE_CHOICE", {
        type: "MULTIPLE_CHOICE",
        selectedOptionIds: ["a"],
      })
    ).toBe(false)
  })

  it("FREE_TEXT and SHORT_ANSWER are empty when the trimmed text is empty", () => {
    expect(isAnswerEmpty("FREE_TEXT", { text: "" })).toBe(true)
    expect(isAnswerEmpty("FREE_TEXT", { text: "   " })).toBe(true)
    expect(isAnswerEmpty("FREE_TEXT", { text: "Antwort" })).toBe(false)
    expect(isAnswerEmpty("SHORT_ANSWER", { text: "" })).toBe(true)
    expect(isAnswerEmpty("SHORT_ANSWER", { text: "42" })).toBe(false)
  })

  it("FILL_IN_THE_BLANK is empty when every blank is empty", () => {
    expect(
      isAnswerEmpty("FILL_IN_THE_BLANK", {
        blanks: [
          { id: "1", value: "" },
          { id: "2", value: "x" },
        ],
      })
    ).toBe(false)
    expect(
      isAnswerEmpty("FILL_IN_THE_BLANK", {
        blanks: [
          { id: "1", value: "" },
          { id: "2", value: "" },
        ],
      })
    ).toBe(true)
    expect(isAnswerEmpty("FILL_IN_THE_BLANK", { blanks: [] })).toBe(true)
  })

  it("FILE_UPLOAD is empty when the file was removed", () => {
    expect(isAnswerEmpty("FILE_UPLOAD", { fileKey: "", fileName: "" })).toBe(
      true
    )
    expect(
      isAnswerEmpty("FILE_UPLOAD", {
        fileKey: "sessions/x/q/f.pdf",
        fileName: "f.pdf",
      })
    ).toBe(false)
  })

  it("structure-based types are never empty once saved", () => {
    expect(isAnswerEmpty("MATCHING", { matches: [] })).toBe(false)
    expect(isAnswerEmpty("ORDERING", { orderedIds: [] })).toBe(false)
    expect(isAnswerEmpty("TRUE_FALSE", { selected: true })).toBe(false)
    expect(isAnswerEmpty("CODE", { code: "x", language: "py" })).toBe(false)
  })
})
