import { describe, expect, it } from "vitest"
import { Font, renderToBuffer } from "@react-pdf/renderer"
import { inflateSync } from "node:zlib"
import { pdfStyles } from "@/lib/pdf/styles"
import {
  ExamPrintDocument,
  StudentResultDocument,
} from "@/lib/pdf/exam-document"
import {
  buildAnswerSheets,
  buildExamQuestions,
  buildExamMeta,
} from "@/lib/pdf/builders"

const exam = {
  id: "exam1",
  title: "Klausur π — Mathematik",
  description: "α β Δ Ω θ √ ∞ ≠ ≤ ≥ ± × ÷ ∑ ∫ → ² ₁ ä ö ü ß €",
  accessCode: "ABC123",
  timeLimitMin: 60,
  questions: [
    {
      id: "q1",
      type: "MULTIPLE_CHOICE",
      title: "Welche Periode hat die Funktion f(x) = sin(2x)?",
      points: 2,
      config: {
        multiSelect: false,
        options: [
          { id: "o1", text: "π", isCorrect: true },
          { id: "o2", text: "2π", isCorrect: false },
          { id: "o3", text: "π/2", isCorrect: false },
        ],
      },
    },
    {
      id: "q2",
      type: "CODE",
      title: "Schreibe hello world.",
      points: 3,
      config: {
        language: "python",
        starterCode: "π = 3.14\nprint('α ≤ β → ∞')",
        testCases: [
          { input: "", expectedOutput: "1\n2", hidden: false, points: 3 },
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
      content: { type: "CODE", code: "print('π ≠ Ω')", language: "python" },
    },
  ],
  grades: [
    {
      questionId: "q1",
      points: 2,
      maxPoints: 2,
      feedback: "π ist richtig → 2π ≠ π",
    },
  ],
}

// Verify the generated PDF embeds fonts and Unicode mappings, rather than
// merely producing a valid PDF with missing or corrupted characters.
function expectUnicodeFonts(pdf: Buffer) {
  const source = pdf.toString("latin1")
  expect(source).toContain("/FontFile2")
  const unicodeMaps = [
    ...source.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g),
  ]
    .map((match) => inflateSync(Buffer.from(match[1], "latin1")).toString())
    .filter((stream) => stream.includes("begincmap"))
    .join("\n")
  for (const symbol of `π ${exam.description}`.replaceAll(" ", "")) {
    const hex = symbol.codePointAt(0)!.toString(16).padStart(4, "0")
    expect(unicodeMaps.toLowerCase(), symbol).toContain(`<${hex}>`)
  }
}

describe("PDF rendering smoke tests", () => {
  it.each([
    { fontFamily: pdfStyles.page.fontFamily },
    { fontFamily: pdfStyles.page.fontFamily, fontWeight: 700 },
    { fontFamily: pdfStyles.page.fontFamily, fontStyle: "italic" as const },
    {
      fontFamily: pdfStyles.page.fontFamily,
      fontWeight: 700,
      fontStyle: "italic" as const,
    },
    { fontFamily: pdfStyles.code.fontFamily },
  ])(
    "provides glyphs for math symbols in $fontFamily $fontWeight $fontStyle",
    async (descriptor) => {
      await Font.load(descriptor)
      const font = Font.getFont(descriptor).data!
      for (const symbol of `π ${exam.description}`.replaceAll(" ", "")) {
        expect(font.hasGlyphForCodePoint(symbol.codePointAt(0)!), symbol).toBe(
          true
        )
      }
    }
  )

  it("renders the teacher print document to a PDF buffer", async () => {
    const meta = buildExamMeta(exam)
    const pdf = await renderToBuffer(
      <ExamPrintDocument
        exam={meta}
        questions={buildExamQuestions(exam, true)}
        answerSheets={buildAnswerSheets(exam, [session])}
        withSolutions
      />
    )
    expect(pdf.byteLength).toBeGreaterThan(1000)
    expect(Buffer.from(pdf).subarray(0, 5).toString()).toBe("%PDF-")
    expectUnicodeFonts(pdf)
  })

  it("renders the student result document to a PDF buffer", async () => {
    const meta = buildExamMeta(exam)
    const pdf = await renderToBuffer(
      <StudentResultDocument
        exam={meta}
        studentName="Ada Lovelace"
        studentEmail="ada@example.com"
        status="SUBMITTED"
        submittedAt={session.submittedAt.toISOString()}
        totalPoints={2}
        maxPoints={5}
        questions={buildAnswerSheets(exam, [session])[0].answers}
      />
    )
    expect(pdf.byteLength).toBeGreaterThan(1000)
    expect(Buffer.from(pdf).subarray(0, 5).toString()).toBe("%PDF-")
    expectUnicodeFonts(pdf)
  })
})
