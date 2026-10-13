import { describe, expect, it } from "vitest"
import { createExamSchema, updateExamSchema } from "@/lib/validators/exam"

describe("createExamSchema", () => {
  it("defaults the boolean flags to false when omitted", () => {
    const parsed = createExamSchema.parse({ title: "T", timeLimitMin: 30 })
    expect(parsed.shuffleQuestions).toBe(false)
    expect(parsed.shuffleOptions).toBe(false)
    expect(parsed.showResults).toBe(false)
    expect(parsed.sebRequired).toBe(false)
  })
})

describe("updateExamSchema (partial PATCH)", () => {
  it("does NOT inject boolean flags that were not sent", () => {
    // Regression: a partial update that omits sebRequired must not reset it.
    // Previously `.partial()` on a schema with `.default(false)` materialized
    // every flag as false, silently turning SEB (and showResults/shuffle) off
    // on any PATCH that only changed e.g. the title.
    const parsed = updateExamSchema.parse({ title: "Renamed" })
    expect("sebRequired" in parsed).toBe(false)
    expect("showResults" in parsed).toBe(false)
    expect("shuffleQuestions" in parsed).toBe(false)
    expect("shuffleOptions" in parsed).toBe(false)
    expect(parsed.sebRequired).toBeUndefined()
  })

  it("still accepts and preserves flags that ARE sent", () => {
    const parsed = updateExamSchema.parse({ sebRequired: true })
    expect(parsed.sebRequired).toBe(true)
    expect("showResults" in parsed).toBe(false)
  })

  it("still rejects scheduledEnd before scheduledStart", () => {
    const res = updateExamSchema.safeParse({
      scheduledStart: "2026-01-02T10:00:00.000Z",
      scheduledEnd: "2026-01-01T10:00:00.000Z",
    })
    expect(res.success).toBe(false)
  })
})

describe("shared start (waitingRoom)", () => {
  it("defaults to off on create and stays absent from a partial PATCH", () => {
    expect(
      createExamSchema.parse({ title: "T", timeLimitMin: 30 }).waitingRoom
    ).toBe(false)
    expect("waitingRoom" in updateExamSchema.parse({ title: "T" })).toBe(false)
  })

  it("rejects a scheduled end together with the waiting room", () => {
    const body = {
      waitingRoom: true,
      scheduledStart: "2030-01-01T10:00:00.000Z",
      scheduledEnd: "2030-01-01T11:00:00.000Z",
    }
    const result = updateExamSchema.safeParse(body)
    expect(result.success).toBe(false)
    expect(result.error?.issues[0].path).toEqual(["scheduledEnd"])
    expect(
      updateExamSchema.safeParse({ ...body, scheduledEnd: null }).success
    ).toBe(true)
  })
})
