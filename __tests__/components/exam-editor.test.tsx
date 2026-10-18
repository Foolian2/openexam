// @vitest-environment happy-dom
import { act, fireEvent, render, screen, cleanup } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
const m = vi.hoisted(() => ({
  toastMutate: vi.fn(),
  push: vi.fn(),
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: m.push }) }))
vi.mock("@/lib/api-mutate-toast", () => ({ apiMutateToast: m.toastMutate }))
vi.mock("@/components/questions/question-builder", () => ({
  QuestionBuilder: () => null,
}))
vi.mock("@/components/questions/viewer/question-viewer", () => ({
  QuestionViewer: () => null,
}))
vi.mock("@/components/grading/ensure-graded", () => ({ ensureGraded: vi.fn() }))
vi.mock("@/components/grading/answer-display", () => ({
  AnswerDisplay: () => null,
}))
vi.mock("@/components/grading/solution-hint", () => ({
  SolutionHint: () => null,
}))
vi.mock("@/components/grading/rubric-checklist", () => ({
  RubricChecklist: () => null,
}))
import { ExamEditor } from "@/components/exams/exam-editor"
import { TooltipProvider } from "@/components/ui/tooltip"

const exam = {
  id: "e",
  title: "Before",
  description: null,
  timeLimitMin: 60,
  shuffleQuestions: false,
  shuffleOptions: false,
  showResults: false,
  sebRequired: false,
  waitingRoom: false,
  scheduledStart: null,
  scheduledEnd: null,
  status: "DRAFT",
  accessCode: "ABCDEF",
} as const

function renderEditor() {
  render(
    <TooltipProvider>
      <ExamEditor exam={exam} />
    </TooltipProvider>
  )
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  m.toastMutate.mockReset()
  m.push.mockReset()
})

it("reports a rejected metadata PATCH and clears the error on the next save", async () => {
  vi.useFakeTimers()
  m.toastMutate.mockResolvedValue({
    ok: false,
    status: 409,
    message: "Rejected",
  })
  renderEditor()
  fireEvent.change(screen.getByLabelText(/Titel/), {
    target: { value: "After" },
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(700)
  })
  expect(m.toastMutate).toHaveBeenCalled()
  const status = screen.getByTestId("metadata-save-status")
  expect(status).toHaveTextContent("Fehler beim Speichern")
  expect(status).not.toHaveTextContent("Gespeichert")

  m.toastMutate.mockResolvedValue({
    ok: true,
    status: 200,
    data: { exam: { ...exam, title: "After again" } },
  })
  fireEvent.change(screen.getByLabelText(/Titel/), {
    target: { value: "After again" },
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(700)
  })
  expect(screen.getByTestId("metadata-save-status")).toHaveTextContent(
    "Gespeichert"
  )
  expect(m.toastMutate).toHaveBeenCalledTimes(2)
})

it("does not report a failed save for a validation-only failure", async () => {
  vi.useFakeTimers()
  renderEditor()
  fireEvent.change(screen.getByLabelText(/Titel/), { target: { value: "" } })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(700)
  })
  expect(m.toastMutate).not.toHaveBeenCalled()
  expect(screen.queryByTestId("metadata-save-status")).toBeNull()
  expect(screen.queryByText("Fehler beim Speichern")).toBeNull()
  expect(screen.getByText("Titel ist erforderlich")).toBeTruthy()
})
