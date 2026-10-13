import { QuestionViewer } from "@/components/questions/viewer/question-viewer"
import type { QuestionConfig } from "@/lib/types/questions"

/** Shared shape for a question as seen by grading UIs (by-session and
 * by-question) — unsanitized config, incl. solutions. */
export type GradedQuestion = {
  id: string
  order: number
  title: string
  points: number
  required: boolean
} & QuestionConfig

/** Read-only rendering of one student's answer against the full config. */
export function AnswerDisplay({
  sessionId,
  question,
  answer,
}: {
  sessionId: string
  question: GradedQuestion
  answer: unknown
}) {
  return (
    <QuestionViewer
      question={question}
      answer={answer}
      sessionId={sessionId}
      readOnly
    />
  )
}
