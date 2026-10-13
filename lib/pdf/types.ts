import type { QuestionType } from "@/lib/validators/question"

/** Serializable (string/number only) metadata for a printed exam. */
export interface PdfExamMeta {
  id: string
  title: string
  description: string | null
  accessCode: string
  timeLimitMin: number
  totalPoints: number
}

/**
 * One question for the exam-questions section of a printout. `config` is
 * always student-safe (sanitized); `solution` is the raw config with the
 * answer key, only present when the teacher printed with `withSolutions`.
 */
export interface PdfQuestionData {
  index: number
  type: QuestionType
  title: string
  points: number
  config: unknown
  solution?: unknown
}

/** One student's answer sheet inside the teacher's bulk printout. */
export interface PdfAnswerSheetData {
  studentName: string
  studentEmail: string
  status: string
  submittedAt: string | null
  totalPoints: number
  maxPoints: number
  answers: PdfAnswerData[]
}

/**
 * A question plus the student's answer and grade. `config` matches the shape
 * the answer was recorded against (sanitized for students, raw for teacher
 * answer sheets) so answer ids resolve to display text.
 */
export interface PdfAnswerData {
  index: number
  type: QuestionType
  title: string
  points: number
  config: unknown
  answer: unknown
  grade?: { points: number; maxPoints: number; feedback: string | null }
}
