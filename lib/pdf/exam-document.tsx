import React from "react"
import { Document, Page, View, Text } from "@react-pdf/renderer"
import type {
  PdfAnswerData,
  PdfAnswerSheetData,
  PdfExamMeta,
  PdfQuestionData,
} from "./types"
import { pdfStyles } from "./styles"
import { PdfQuestion } from "./question"
import { PdfSolution } from "./solution"
import { PdfAnswer } from "./answer"
import { formatDateTime } from "@/lib/format-date"

function ExamHeader({ exam }: { exam: PdfExamMeta }) {
  return (
    <View>
      <Text style={pdfStyles.title}>{exam.title}</Text>
      {exam.description && (
        <Text style={[pdfStyles.subtitle, { marginBottom: 6 }]}>
          {exam.description}
        </Text>
      )}
      <View style={pdfStyles.metaRow}>
        <Text>Zugangscode: {exam.accessCode}</Text>
        <Text>Zeitlimit: {exam.timeLimitMin} Min.</Text>
        <Text>Gesamt: {exam.totalPoints} Punkte</Text>
      </View>
      <View style={pdfStyles.rule} />
    </View>
  )
}

function PdfFooter({ exam }: { exam: PdfExamMeta }) {
  return (
    <Text
      fixed
      style={pdfStyles.footer}
      render={({ pageNumber, totalPages }) =>
        `${exam.title} — Seite ${pageNumber} / ${totalPages}`
      }
    />
  )
}

function QuestionsSection({
  questions,
  withSolutions,
}: {
  questions: PdfQuestionData[]
  withSolutions: boolean
}) {
  return (
    <View>
      <Text style={pdfStyles.sectionTitle}>Prüfungsfragen</Text>
      {questions.map((q) => (
        <View key={q.index} wrap={false}>
          <PdfQuestion q={q} />
          {withSolutions && <PdfSolution q={q} />}
        </View>
      ))}
    </View>
  )
}

function AnswerSheetPage({
  exam,
  sheet,
}: {
  exam: PdfExamMeta
  sheet: PdfAnswerSheetData
}) {
  return (
    <Page size="A4" style={pdfStyles.page} wrap>
      <PdfFooter exam={exam} />
      <View style={pdfStyles.sheetHeader}>
        <Text style={pdfStyles.sheetName}>{sheet.studentName}</Text>
        <Text style={pdfStyles.gradePill}>
          {sheet.totalPoints} / {sheet.maxPoints} P.
        </Text>
      </View>
      <Text style={pdfStyles.sheetMeta}>{sheet.studentEmail}</Text>
      <Text style={pdfStyles.sheetMeta}>
        Status: {sheet.status}
        {sheet.submittedAt
          ? ` — Abgegeben am ${formatDateTime(sheet.submittedAt)}`
          : ""}
      </Text>
      <View style={pdfStyles.rule} />
      {sheet.answers.map((a) => (
        <View key={a.index} wrap={false}>
          <PdfQuestion q={a} />
          <PdfAnswer a={a} />
        </View>
      ))}
    </Page>
  )
}

/**
 * Teacher bulk printout: the exam questions (optionally with a solution key)
 * followed by one page (or more) per submitted student's answer sheet.
 */
export function ExamPrintDocument({
  exam,
  questions,
  answerSheets,
  withSolutions,
}: {
  exam: PdfExamMeta
  questions: PdfQuestionData[]
  answerSheets: PdfAnswerSheetData[]
  withSolutions: boolean
}) {
  return (
    <Document
      title={`${exam.title} — Druckausgabe`}
      author="OpenExam"
      creator="OpenExam"
      producer="OpenExam"
    >
      <Page size="A4" style={pdfStyles.page} wrap>
        <PdfFooter exam={exam} />
        <ExamHeader exam={exam} />
        <QuestionsSection questions={questions} withSolutions={withSolutions} />
        {answerSheets.length > 0 && (
          <>
            <Text style={[pdfStyles.sectionTitle, { marginTop: 20 }]}>
              Abgaben ({answerSheets.length})
            </Text>
            <View style={pdfStyles.rule} />
          </>
        )}
      </Page>
      {answerSheets.map((sheet, si) => (
        <AnswerSheetPage key={si} exam={exam} sheet={sheet} />
      ))}
    </Document>
  )
}

/**
 * Student's own-exam printout: the exam with their answers filled in and
 * their per-question and total grades.
 */
export function StudentResultDocument({
  exam,
  studentName,
  studentEmail,
  status,
  submittedAt,
  totalPoints,
  maxPoints,
  questions,
}: {
  exam: PdfExamMeta
  studentName: string
  studentEmail: string
  status: string
  submittedAt: string | null
  totalPoints: number
  maxPoints: number
  questions: PdfAnswerData[]
}) {
  return (
    <Document
      title={`${exam.title} — Ergebnis ${studentName}`}
      author="OpenExam"
      creator="OpenExam"
      producer="OpenExam"
    >
      <Page size="A4" style={pdfStyles.page} wrap>
        <PdfFooter exam={exam} />
        <ExamHeader exam={exam} />
        <View style={pdfStyles.sheetHeader}>
          <Text style={pdfStyles.sheetName}>{studentName}</Text>
          <Text style={pdfStyles.gradePill}>
            Ergebnis: {totalPoints} / {maxPoints} P.
          </Text>
        </View>
        <Text style={pdfStyles.sheetMeta}>{studentEmail}</Text>
        <Text style={pdfStyles.sheetMeta}>
          Status: {status}
          {submittedAt ? ` — Abgegeben am ${formatDateTime(submittedAt)}` : ""}
        </Text>
        <View style={pdfStyles.rule} />
        {questions.map((a) => (
          <View key={a.index} wrap={false}>
            <PdfQuestion q={a} />
            <PdfAnswer a={a} />
          </View>
        ))}
      </Page>
    </Document>
  )
}
