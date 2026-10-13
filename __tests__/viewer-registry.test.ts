import { describe, expect, it, vi } from "vitest"

vi.mock("@/components/questions/viewer/mc-viewer", () => ({
  MCViewer: vi.fn(),
}))
vi.mock("@/components/questions/viewer/free-text-viewer", () => ({
  FreeTextViewer: vi.fn(),
}))
vi.mock("@/components/questions/viewer/fill-blank-viewer", () => ({
  FillBlankViewer: vi.fn(),
}))
vi.mock("@/components/questions/viewer/file-upload-viewer", () => ({
  FileUploadViewer: vi.fn(),
}))
vi.mock("@/components/questions/viewer/code-viewer", () => ({
  CodeViewer: vi.fn(),
}))
vi.mock("@/components/questions/viewer/true-false-viewer", () => ({
  TrueFalseViewer: vi.fn(),
}))
vi.mock("@/components/questions/viewer/short-answer-viewer", () => ({
  ShortAnswerViewer: vi.fn(),
}))

import {
  BASE_VIEWERS,
  renderQuestionViewer,
  type ViewerRegistry,
} from "@/components/questions/viewer/viewer-registry"

const viewers: ViewerRegistry = {
  ...BASE_VIEWERS,
  MATCHING: vi.fn(),
  ORDERING: vi.fn(),
}

describe("true/false viewer radio identifiers", () => {
  it("gives result questions distinct label targets", () => {
    const prefixes = ["question-one", "question-two"].map(
      (id) =>
        renderQuestionViewer(viewers, {
          question: { id, type: "TRUE_FALSE", config: {} },
          answer: { type: "TRUE_FALSE", selected: true },
          readOnly: true,
        }).props.idPrefix
    )
    expect(prefixes).toEqual(["tf-question-one-", "tf-question-two-"])
    expect(new Set(prefixes).size).toBe(2)
  })

  it("preserves explicit prefixes used by exams and previews", () => {
    expect(
      renderQuestionViewer(viewers, {
        question: { id: "q1", type: "TRUE_FALSE", config: {} },
        idPrefix: "preview-",
      }).props.idPrefix
    ).toBe("preview-")
  })
})
