import { describe, expect, it } from "vitest"
import {
  buildAnswerSheets,
  buildExamMeta,
  buildExamQuestions,
  buildStudentPrintData,
  toTeacherAnswerContent,
} from "@/lib/pdf/builders"
import { matchingRightId } from "@/lib/exam-session"
import type {
  MCConfig,
  MatchingConfig,
  OrderingConfig,
  ShortAnswerConfig,
  TrueFalseConfig,
} from "@/lib/types/questions"

const exam = {
  id: "exam1",
  title: "Klausur",
  description: "Beschreibung",
  accessCode: "ABC123",
  timeLimitMin: 60,
  questions: [
    {
      id: "q1",
      type: "MULTIPLE_CHOICE",
      title: "Welche Farbe hat der Himmel?",
      points: 2,
      config: {
        multiSelect: false,
        options: [
          { id: "o1", text: "Blau", isCorrect: true },
          { id: "o2", text: "Grün", isCorrect: false },
        ],
      },
    },
    {
      id: "q2",
      type: "TRUE_FALSE",
      title: "Die Erde ist eine Scheibe.",
      points: 1,
      config: { isCorrect: false },
    },
    {
      id: "q3",
      type: "SHORT_ANSWER",
      title: "Hauptstadt von Frankreich?",
      points: 1,
      config: {
        acceptedAnswers: ["Paris"],
        caseSensitive: false,
        maxLength: 80,
      },
    },
    {
      id: "q4",
      type: "MATCHING",
      title: "Ordne zu.",
      points: 3,
      config: {
        shuffleSides: true,
        pairs: [
          { id: "p1", left: "DE", right: "Berlin" },
          { id: "p2", left: "FR", right: "Paris" },
        ],
      },
    },
    {
      id: "q5",
      type: "ORDERING",
      title: "Sortiere die Zahlen.",
      points: 2,
      config: {
        shuffle: true,
        items: [
          { id: "i1", text: "Eins" },
          { id: "i2", text: "Zwei" },
        ],
      },
    },
  ],
}

const session = {
  id: "s1",
  status: "SUBMITTED",
  submittedAt: new Date("2026-07-13T10:00:00Z"),
  user: { name: "Ada Lovelace", email: "ada@example.com" },
  answers: [
    {
      questionId: "q1",
      content: { type: "MULTIPLE_CHOICE", selectedOptionIds: ["o1"] },
    },
    {
      questionId: "q2",
      content: { type: "TRUE_FALSE", selected: true },
    },
    {
      questionId: "q3",
      content: { type: "SHORT_ANSWER", text: "paris" },
    },
    {
      questionId: "q4",
      content: {
        type: "MATCHING",
        matches: [
          { leftId: "p1", rightId: matchingRightId("s1:q4", "p1") },
          { leftId: "p2", rightId: matchingRightId("s1:q4", "p2") },
        ],
      },
    },
    {
      questionId: "q5",
      content: { type: "ORDERING", orderedIds: ["i2", "i1"] },
    },
  ],
  grades: [
    { questionId: "q1", points: 2, maxPoints: 2, feedback: null },
    { questionId: "q2", points: 0, maxPoints: 1, feedback: "Falsch" },
  ],
}

describe("buildExamMeta", () => {
  it("sums the total points", () => {
    expect(buildExamMeta(exam).totalPoints).toBe(9)
    expect(buildExamMeta(exam).accessCode).toBe("ABC123")
  })
})

describe("buildExamQuestions", () => {
  it("sanitizes configs when printing without solutions", () => {
    const questions = buildExamQuestions(exam, false)
    expect(questions[0].solution).toBeUndefined()
    expect(questions[0].config).not.toEqual(exam.questions[0].config)

    const mc = questions[0].config as MCConfig
    expect(mc.options.every((o) => o.isCorrect === false)).toBe(true)

    const tf = questions[1].config as TrueFalseConfig
    expect(tf).toEqual({})

    const sa = questions[2].config as ShortAnswerConfig
    expect(sa.acceptedAnswers).toBeUndefined()

    const matching = questions[3].config as {
      left: { id: string; text: string }[]
      right: { id: string; text: string }[]
    }
    // Decoupled columns, opaque right ids — pairing must not be visible.
    expect(matching.left.map((l) => l.id)).toEqual(["p1", "p2"])
    expect(matching.right.some((r) => r.id === "p1" || r.id === "p2")).toBe(
      false
    )
    expect(
      matching.right.every((r) => r.text === "Berlin" || r.text === "Paris")
    ).toBe(true)

    const ordering = questions[4].config as OrderingConfig
    // Sanitized ORDERING must always be a permutation of the items — the
    // stored order is the solution, so it may only ever appear by chance
    // (1/n!); assert permutation + a differently-keyed seed.
    expect(ordering.items.map((i) => i.id).sort()).toEqual(["i1", "i2"])
    const other = buildExamQuestions(exam, false)[4].config as OrderingConfig
    expect(ordering.items.map((i) => i.id)).toEqual(
      other.items.map((i) => i.id)
    )
  })

  it("keeps raw configs and adds solutions when printing with solutions", () => {
    const questions = buildExamQuestions(exam, true)
    expect(questions[0].config).toEqual(exam.questions[0].config)
    expect(questions[0].solution).toEqual(exam.questions[0].config)
    const mc = questions[0].solution as MCConfig
    expect(mc.options[0].isCorrect).toBe(true)
  })
})

describe("buildAnswerSheets", () => {
  it("computes totals and attaches grades per question", () => {
    const sheets = buildAnswerSheets(exam, [session])
    expect(sheets).toHaveLength(1)
    expect(sheets[0].totalPoints).toBe(2)
    expect(sheets[0].maxPoints).toBe(9)
    expect(sheets[0].studentName).toBe("Ada Lovelace")

    const q1 = sheets[0].answers.find((a) => a.index === 1)!
    expect(q1.grade).toEqual({ points: 2, maxPoints: 2, feedback: null })
    expect(q1.answer).toEqual({
      type: "MULTIPLE_CHOICE",
      selectedOptionIds: ["o1"],
    })
  })

  it("translates MATCHING right ids back to pair ids", () => {
    const sheets = buildAnswerSheets(exam, [session])
    const q4 = sheets[0].answers.find((a) => a.index === 4)!
    const matches = (
      q4.answer as { matches: { leftId: string; rightId: string }[] }
    ).matches
    expect(matches.map((m) => m.rightId)).toEqual(["p1", "p2"])
  })

  it("uses the raw config on teacher answer sheets", () => {
    const sheets = buildAnswerSheets(exam, [session])
    const q4 = sheets[0].answers.find((a) => a.index === 4)!
    expect((q4.config as MatchingConfig).pairs).toHaveLength(2)
    const q5 = sheets[0].answers.find((a) => a.index === 5)!
    expect((q5.config as OrderingConfig).items.map((i) => i.id)).toEqual([
      "i1",
      "i2",
    ])
  })
})

describe("buildStudentPrintData", () => {
  const data = buildStudentPrintData({ ...session, exam })

  it("uses per-session sanitized configs", () => {
    const q1 = data.questions.find((q) => q.index === 1)!
    const mc = q1.config as MCConfig
    expect(mc.options.every((o) => o.isCorrect === false)).toBe(true)

    const q4 = data.questions.find((q) => q.index === 4)!
    const matching = q4.config as {
      left: { id: string; text: string }[]
      right: { id: string; text: string }[]
    }
    // Opaque right ids match the answer's recorded right ids.
    const match = (
      q4.answer as { matches: { leftId: string; rightId: string }[] }
    ).matches
    expect(matching.right.map((r) => r.id)).toContain(match[0].rightId)
  })

  it("keeps the student's own total and grade", () => {
    expect(data.totalPoints).toBe(2)
    expect(data.maxPoints).toBe(9)
    expect(data.studentName).toBe("Ada Lovelace")
  })
})

describe("toTeacherAnswerContent", () => {
  it("passes through non-MATCHING answers untouched", () => {
    expect(
      toTeacherAnswerContent({ type: "FREE_TEXT", text: "hi" }, undefined, "s1")
    ).toEqual({
      type: "FREE_TEXT",
      text: "hi",
    })
  })

  it("resolves opaque right ids via the HMAC", () => {
    const q4 = exam.questions[3]
    const opaque = matchingRightId("s1:q4", "p2")
    const translated = toTeacherAnswerContent(
      { type: "MATCHING", matches: [{ leftId: "p1", rightId: opaque }] },
      q4,
      "s1"
    )
    expect(
      (translated as { matches: { rightId: string }[] }).matches[0].rightId
    ).toBe("p2")
  })
})
