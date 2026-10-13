import type { ComponentType } from "react"
import type { AnswerContent } from "@/lib/answer-buffer"
import type {
  QuestionType,
  ViewerConfigByType,
  ViewerQuestionConfig,
} from "@/lib/types/questions"
import { MCViewer } from "./mc-viewer"
import { FreeTextViewer } from "./free-text-viewer"
import { FillBlankViewer } from "./fill-blank-viewer"
import { FileUploadViewer } from "./file-upload-viewer"
import { CodeViewer } from "./code-viewer"
import { TrueFalseViewer } from "./true-false-viewer"
import { ShortAnswerViewer } from "./short-answer-viewer"

/** The answer payload of one question type, without its `type` tag. */
export type AnswerOf<T extends QuestionType> = Omit<
  Extract<AnswerContent, { type: T }>,
  "type"
>

/** Props every per-type viewer accepts; each one ignores what it doesn't use. */
export interface ViewerProps<T extends QuestionType> {
  config: ViewerConfigByType[T]
  answer?: AnswerOf<T>
  onChange?: (answer: AnswerOf<T>) => void
  readOnly?: boolean
  /** FILE_UPLOAD: where uploads and downloads are scoped. */
  sessionId?: string
  questionId?: string
  /** TRUE_FALSE: prefix for radio ids when several render on one page. */
  idPrefix?: string
}

/** One viewer per question type — a missing type is a compile error. */
export type ViewerRegistry = {
  [T in QuestionType]: ComponentType<ViewerProps<T>>
}

/**
 * Every viewer except the dnd-kit ones. MATCHING and ORDERING are left to
 * each registry because the choice matters: the exam runner loads them
 * eagerly (no chunk fetch mid-exam), read-only pages lazily.
 */
export const BASE_VIEWERS: Omit<ViewerRegistry, "MATCHING" | "ORDERING"> = {
  MULTIPLE_CHOICE: MCViewer,
  FREE_TEXT: FreeTextViewer,
  FILL_IN_THE_BLANK: FillBlankViewer,
  FILE_UPLOAD: FileUploadViewer,
  CODE: CodeViewer,
  TRUE_FALSE: TrueFalseViewer,
  SHORT_ANSWER: ShortAnswerViewer,
}

export interface QuestionViewerProps {
  question: ViewerQuestionConfig & { id?: string }
  /**
   * Stored answer content. Anything that isn't an answer of this question's
   * type (none yet, or a stale one) renders as unanswered.
   */
  answer?: unknown
  onChange?: (answer: AnswerContent) => void
  readOnly?: boolean
  sessionId?: string
  idPrefix?: string
}

function isAnswerFor<T extends QuestionType>(
  answer: unknown,
  type: T
): answer is Extract<AnswerContent, { type: T }> {
  return (
    typeof answer === "object" &&
    answer !== null &&
    (answer as { type?: unknown }).type === type
  )
}

/**
 * Renders the viewer for `question.type` from `viewers`, handling the parts
 * every call site used to repeat: picking the answer of the matching type
 * and re-tagging `onChange` payloads with it.
 */
export function renderQuestionViewer<T extends QuestionType>(
  viewers: ViewerRegistry,
  {
    question,
    answer,
    onChange,
    readOnly,
    sessionId,
    idPrefix,
  }: QuestionViewerProps & { question: { type: T } }
) {
  const type = question.type
  // TypeScript can't correlate `viewers[type]`, `question.config` and the
  // answer payload through a generic index, so this is where they are
  // re-joined; the per-type registry above is what keeps them consistent.
  const Viewer = viewers[type] as ComponentType<ViewerProps<T>>
  return (
    <Viewer
      config={question.config as ViewerConfigByType[T]}
      answer={isAnswerFor(answer, type) ? answer : undefined}
      onChange={
        onChange &&
        ((a: AnswerOf<T>) =>
          onChange({ ...a, type } as unknown as AnswerContent))
      }
      readOnly={readOnly}
      sessionId={sessionId}
      questionId={question.id}
      idPrefix={idPrefix ?? (question.id ? `tf-${question.id}-` : undefined)}
    />
  )
}
