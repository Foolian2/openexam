import { sanitizeQuestionConfig } from "@/lib/exam-session"
import { toTeacherAnswerContent } from "@/lib/grading/teacher-answer-content"
import type { QuestionType } from "@/lib/validators/question"
import type {
  PdfAnswerData,
  PdfAnswerSheetData,
  PdfExamMeta,
  PdfQuestionData,
} from "./types"

export interface PrintQuestionRow {
  id: string
  type: string
  title: string
  points: number
  config: unknown
}

export interface PrintAnswerRow {
  questionId: string
  content: unknown
}

export interface PrintSessionRow {
  id: string
  status: string
  submittedAt: Date | null
  user: { name: string | null; email: string | null }
  answers: PrintAnswerRow[]
  grades: {
    questionId: string
    points: number
    maxPoints: number
    feedback: string | null
  }[]
}

export interface PrintExamRow {
  id: string
  title: string
  description: string | null
  accessCode: string
  timeLimitMin: number
  questions: PrintQuestionRow[]
}

/**
 * Stored MATCHING answers reference opaque per-session right ids. Translate
 * them back to pair ids so teacher-facing output (which works with the raw
 * config) can render the student's ordering — same logic as the review route.
 */
export { toTeacherAnswerContent }

function sanitizedForPrint(question: PrintQuestionRow, seed: string): unknown {
  return sanitizeQuestionConfig(
    question.type as QuestionType,
    question.config,
    seed
  )
}

export function buildExamQuestions(
  exam: PrintExamRow,
  withSolutions: boolean
): PdfQuestionData[] {
  return exam.questions.map((q, i) => ({
    index: i + 1,
    type: q.type as QuestionType,
    title: q.title,
    points: q.points,
    config: withSolutions ? q.config : sanitizedForPrint(q, `${exam.id}:print`),
    ...(withSolutions ? { solution: q.config } : {}),
  }))
}

function buildAnswerData(
  session: PrintSessionRow,
  question: PrintQuestionRow,
  index: number,
  config: unknown,
  grade: PdfAnswerData["grade"] | undefined,
  translateMatching: boolean
): PdfAnswerData {
  const raw = session.answers.find((a) => a.questionId === question.id)
  return {
    index,
    type: question.type as QuestionType,
    title: question.title,
    points: question.points,
    config,
    answer: raw
      ? translateMatching
        ? toTeacherAnswerContent(raw.content, question, session.id)
        : raw.content
      : undefined,
    grade,
  }
}

export function buildAnswerSheets(
  exam: PrintExamRow,
  sessions: PrintSessionRow[]
): PdfAnswerSheetData[] {
  const maxTotal = exam.questions.reduce((sum, q) => sum + q.points, 0)
  return sessions.map((s) => {
    const gradeByQuestion = new Map(s.grades.map((g) => [g.questionId, g]))
    const total = s.grades.reduce((sum, g) => sum + g.points, 0)
    return {
      studentName: s.user.name ?? "Unbekannt",
      studentEmail: s.user.email ?? "",
      status: s.status,
      submittedAt: s.submittedAt?.toISOString() ?? null,
      totalPoints: total,
      maxPoints: maxTotal,
      answers: exam.questions.map((q, i) => {
        const grade = gradeByQuestion.get(q.id)
        return buildAnswerData(
          s,
          q,
          i + 1,
          // Teacher sheets work against the raw config (same as the review
          // UI): matching pairs and item order are visible to the grader.
          q.config,
          grade
            ? {
                points: grade.points,
                maxPoints: grade.maxPoints,
                feedback: grade.feedback,
              }
            : undefined,
          true
        )
      }),
    }
  })
}

export function buildExamMeta(exam: PrintExamRow): PdfExamMeta {
  return {
    id: exam.id,
    title: exam.title,
    description: exam.description,
    accessCode: exam.accessCode,
    timeLimitMin: exam.timeLimitMin,
    totalPoints: exam.questions.reduce((sum, q) => sum + q.points, 0),
  }
}

export interface StudentPrintRow {
  id: string
  status: string
  submittedAt: Date | null
  exam: PrintExamRow
  user: { name: string | null; email: string | null }
  answers: PrintAnswerRow[]
  grades: {
    questionId: string
    points: number
    maxPoints: number
    feedback: string | null
  }[]
}

/**
 * Data for the student's own-exam printout. Question configs are sanitized
 * per-session (same as the results page) and MATCHING answers keep their
 * opaque per-session right ids, which resolve through the sanitized config.
 */
export function buildStudentPrintData(session: StudentPrintRow): {
  exam: PdfExamMeta
  studentName: string
  studentEmail: string
  status: string
  submittedAt: string | null
  totalPoints: number
  maxPoints: number
  questions: PdfAnswerData[]
} {
  const { exam } = session
  const gradeByQuestion = new Map(session.grades.map((g) => [g.questionId, g]))
  const total = session.grades.reduce((sum, g) => sum + g.points, 0)
  return {
    exam: buildExamMeta(exam),
    studentName: session.user.name ?? "Unbekannt",
    studentEmail: session.user.email ?? "",
    status: session.status,
    submittedAt: session.submittedAt?.toISOString() ?? null,
    totalPoints: total,
    maxPoints: exam.questions.reduce((sum, q) => sum + q.points, 0),
    questions: exam.questions.map((q, i) => {
      const grade = gradeByQuestion.get(q.id)
      return buildAnswerData(
        session,
        q,
        i + 1,
        sanitizedForPrint(q, `${session.id}:${q.id}`),
        grade
          ? {
              points: grade.points,
              maxPoints: grade.maxPoints,
              feedback: grade.feedback,
            }
          : undefined,
        // Student output keeps the opaque per-session right ids — they
        // resolve through the sanitized config's right column.
        false
      )
    }),
  }
}
