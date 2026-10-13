import { describe, expect, it } from "vitest"
import {
  MAX_QUESTION_POINTS,
  configSchemaByType,
  createQuestionSchema,
  validateQuestionUpdate,
} from "@/lib/validators/question"

function messages(result: {
  success: boolean
  error?: { issues: { message: string }[] }
}) {
  return result.success ? [] : result.error!.issues.map((i) => i.message)
}

describe("MULTIPLE_CHOICE config", () => {
  const opts = (correct: boolean[], ids = ["a", "b", "c"]) =>
    correct.map((isCorrect, i) => ({ id: ids[i]!, text: `O${i}`, isCorrect }))

  it("accepts single select with one correct option", () => {
    const r = configSchemaByType.MULTIPLE_CHOICE.safeParse({
      multiSelect: false,
      options: opts([true, false, false]),
    })
    expect(r.success).toBe(true)
  })

  it("rejects single select with two correct options", () => {
    const r = configSchemaByType.MULTIPLE_CHOICE.safeParse({
      multiSelect: false,
      options: opts([true, true, false]),
    })
    expect(messages(r).join()).toMatch(/Einfachauswahl/)
  })

  it("accepts multi select with two correct options", () => {
    const r = configSchemaByType.MULTIPLE_CHOICE.safeParse({
      multiSelect: true,
      options: opts([true, true, false]),
    })
    expect(r.success).toBe(true)
  })

  it("rejects duplicate option ids", () => {
    const r = configSchemaByType.MULTIPLE_CHOICE.safeParse({
      multiSelect: false,
      options: opts([true, false], ["d", "d"]),
    })
    expect(r.success).toBe(false)
    expect(r.error!.issues[0]!.path).toEqual(["options", 1, "id"])
  })
})

describe("FILL_IN_THE_BLANK config", () => {
  const blank = (id: string) => ({
    id,
    acceptedAnswers: ["x"],
    caseSensitive: false,
  })

  it("accepts matching placeholders and blanks", () => {
    const r = configSchemaByType.FILL_IN_THE_BLANK.safeParse({
      template: "A {1} B {3}",
      blanks: [blank("1"), blank("3")],
    })
    expect(r.success).toBe(true)
  })

  it("rejects a template without placeholders", () => {
    const r = configSchemaByType.FILL_IN_THE_BLANK.safeParse({
      template: "Kein Platzhalter hier.",
      blanks: [blank("1")],
    })
    expect(messages(r).join()).toMatch(/Lücke 1 kommt in der Vorlage nicht vor/)
  })

  it("rejects a repeated placeholder", () => {
    const r = configSchemaByType.FILL_IN_THE_BLANK.safeParse({
      template: "Eins {1}, drei {3}. {3}",
      blanks: [blank("1"), blank("3")],
    })
    expect(messages(r).join()).toMatch(/\{3\} kommt mehrfach vor/)
  })

  it("rejects a placeholder without a blank", () => {
    const r = configSchemaByType.FILL_IN_THE_BLANK.safeParse({
      template: "{1} {2}",
      blanks: [blank("1")],
    })
    expect(messages(r).join()).toMatch(/\{2\} gibt es keine Lücke/)
  })

  it("rejects duplicate blank ids", () => {
    const r = configSchemaByType.FILL_IN_THE_BLANK.safeParse({
      template: "{1}",
      blanks: [blank("1"), blank("1")],
    })
    expect(r.success).toBe(false)
  })
})

describe("ORDERING and MATCHING configs", () => {
  it("rejects duplicate ordering item ids", () => {
    const r = configSchemaByType.ORDERING.safeParse({
      shuffle: true,
      items: [
        { id: "i", text: "eins" },
        { id: "i", text: "zwei" },
      ],
    })
    expect(r.success).toBe(false)
  })

  const pair = (id: string, right: string) => ({
    id,
    left: id.toUpperCase(),
    right,
  })

  it("rejects identical definitions, ignoring case and spacing", () => {
    const r = configSchemaByType.MATCHING.safeParse({
      shuffleSides: true,
      pairs: [pair("a", "gleich"), pair("b", " Gleich "), pair("c", "anders")],
    })
    expect(r.success).toBe(false)
    expect(r.error!.issues[0]!.path).toEqual(["pairs", 1, "right"])
  })

  it("rejects duplicate pair ids", () => {
    const r = configSchemaByType.MATCHING.safeParse({
      shuffleSides: true,
      pairs: [pair("a", "1"), pair("a", "2"), pair("c", "3")],
    })
    expect(r.success).toBe(false)
  })
})

describe("question points", () => {
  const tf = (points: number) => ({
    title: "T",
    points,
    type: "TRUE_FALSE" as const,
    config: { isCorrect: true },
  })

  it("accepts decimals up to the maximum", () => {
    expect(createQuestionSchema.safeParse(tf(0.3)).success).toBe(true)
    expect(
      createQuestionSchema.safeParse(tf(MAX_QUESTION_POINTS)).success
    ).toBe(true)
  })

  it("rejects points above the maximum on create and update", () => {
    expect(createQuestionSchema.safeParse(tf(1e9)).success).toBe(false)
    expect(validateQuestionUpdate("TRUE_FALSE", { points: 1001 }).success).toBe(
      false
    )
  })
})
