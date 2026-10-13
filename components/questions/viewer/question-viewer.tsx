"use client"

import { DynamicMatchingViewer, DynamicOrderingViewer } from "./dynamic-viewers"
import {
  BASE_VIEWERS,
  renderQuestionViewer,
  type QuestionViewerProps,
  type ViewerRegistry,
} from "./viewer-registry"

const VIEWERS: ViewerRegistry = {
  ...BASE_VIEWERS,
  MATCHING: DynamicMatchingViewer,
  ORDERING: DynamicOrderingViewer,
}

/**
 * Renders any question type for results, grading and authoring previews.
 * The drag & drop viewers load lazily here; the exam runner has its own
 * eager registry (components/exam-taking/exam-runner.tsx).
 */
export function QuestionViewer(props: QuestionViewerProps) {
  return renderQuestionViewer(VIEWERS, props)
}
