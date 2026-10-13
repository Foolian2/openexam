import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { FILE_NAME_RE, fileKeyBelongsTo } from "@/lib/answer-file-key"
import { answerContentSchema } from "@/lib/validators/answer"

interface AnswerVector {
  name: string
  type: string
  content: unknown
  sessionId: string
  questionId: string
  schemaValid: boolean
  ownershipValid: boolean
}

interface AnswerVectorFixture {
  fileNamePattern: string
  vectors: AnswerVector[]
}

/**
 * The other half of ws-backend/internal/hub/answer_validation_test.go's
 * TestAnswerContractVectors. Both read the same table, so the zod schema
 * (lib/validators/answer.ts) and the Go validator (answer_validation.go)
 * cannot drift apart without one of these two suites going red.
 *
 * schemaValid mirrors Go's validAnswerContent: the content must parse against
 * answerContentSchema *and* its type must match the question's expected type
 * (the fixture's `type` field) — Go rejects a content whose type differs from
 * the question type, and the zod schema alone cannot see the question.
 * ownershipValid is the exact fileKeyBelongsTo result; it is only asserted
 * when the content carries a string fileKey (other vectors have no ownership
 * dimension).
 */
const fixture = JSON.parse(
  readFileSync(join(process.cwd(), "testdata", "answer-vectors.json"), "utf8")
) as AnswerVectorFixture

function schemaValidFor(content: unknown, expectedType: string): boolean {
  const parsed = answerContentSchema.safeParse(content)
  if (!parsed.success) return false
  return parsed.data.type === expectedType
}

/** null = no fileKey in content, so the ownership check does not apply. */
function ownershipValidFor(
  content: unknown,
  sessionId: string,
  questionId: string
): boolean | null {
  if (
    typeof content !== "object" ||
    content === null ||
    !("fileKey" in content)
  )
    return null
  const fileKey = (content as { fileKey: unknown }).fileKey
  if (typeof fileKey !== "string") return null
  return fileKeyBelongsTo(fileKey, sessionId, questionId)
}

describe("shared answer contract vectors", () => {
  it("has vectors to check", () => {
    expect(fixture.vectors.length).toBeGreaterThan(0)
  })

  it("pins the file-name regex to the fixture literal", () => {
    expect(FILE_NAME_RE.source).toBe(fixture.fileNamePattern)
  })

  it.each(fixture.vectors)(
    "$name",
    ({ type, content, sessionId, questionId, schemaValid, ownershipValid }) => {
      const schemaOk = schemaValidFor(content, type)
      expect(schemaOk).toBe(schemaValid)

      const ownershipOk = ownershipValidFor(content, sessionId, questionId)
      if (ownershipOk !== null) {
        expect(ownershipOk).toBe(ownershipValid)
      }

      // A vector is accepted end-to-end iff both checks pass.
      expect(schemaOk && (ownershipOk ?? true)).toBe(
        schemaValid && ownershipValid
      )
    }
  )
})

describe("boundary cases kept out of the fixture", () => {
  // The fixture is static JSON, so count/length limits are exercised here
  // (mirroring Go's hardcoded boundary cases in answer_validation_test.go).

  it("rejects a MULTIPLE_CHOICE with more than 200 option ids", () => {
    expect(
      answerContentSchema.safeParse({
        type: "MULTIPLE_CHOICE",
        selectedOptionIds: Array.from({ length: 201 }, (_, i) => `id-${i}`),
      }).success
    ).toBe(false)
  })

  it("accepts a MULTIPLE_CHOICE with exactly 200 option ids", () => {
    expect(
      answerContentSchema.safeParse({
        type: "MULTIPLE_CHOICE",
        selectedOptionIds: Array.from({ length: 200 }, (_, i) => `id-${i}`),
      }).success
    ).toBe(true)
  })

  it("rejects FREE_TEXT longer than 30000 characters", () => {
    expect(
      answerContentSchema.safeParse({
        type: "FREE_TEXT",
        text: "x".repeat(30001),
      }).success
    ).toBe(false)
  })

  it("accepts FREE_TEXT of exactly 30000 characters", () => {
    expect(
      answerContentSchema.safeParse({
        type: "FREE_TEXT",
        text: "x".repeat(30000),
      }).success
    ).toBe(true)
  })
})
