// @vitest-environment happy-dom
import { act, fireEvent, render, screen, cleanup } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
const m = vi.hoisted(() => ({
  mutate: vi.fn(),
  push: vi.fn(),
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: m.push }) }))
vi.mock("@/lib/api-mutate", () => ({ apiMutate: m.mutate }))
vi.mock("@/components/ui/sidebar", () => ({ SidebarTrigger: () => null }))
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
import { SessionGrader } from "@/components/grading/session-grader"
import { TooltipProvider } from "@/components/ui/tooltip"
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
it("sends an explicit empty feedback value when a comment is cleared", async () => {
  vi.useFakeTimers()
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        session: {
          id: "s",
          submissionType: "MANUAL",
          submittedAt: null,
          sebIntegrityFlaggedAt: null,
          sebIntegrityReason: null,
        },
        student: { name: "Student", email: "student@example.test" },
        exam: { id: "e", title: "Exam", status: "CLOSED" },
        questions: [
          {
            id: "q",
            type: "FREE_TEXT",
            title: "Question",
            points: 4,
            config: { richText: false, maxLength: 100 },
          },
        ],
        answers: [],
        grades: [
          {
            questionId: "q",
            points: 2,
            feedback: "Old comment",
            autoGraded: false,
          },
        ],
      }),
    })
  )
  m.mutate.mockResolvedValue({ ok: true, data: {} })
  await act(async () => {
    render(
      <TooltipProvider>
        <SessionGrader
          sessionId="s"
          examId="e"
          position={{ index: 1, total: 1 }}
          prevSessionId={null}
          nextSessionId={null}
        />
      </TooltipProvider>
    )
  })
  fireEvent.change(screen.getByPlaceholderText("Feedback (optional)"), {
    target: { value: "" },
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1600)
  })
  expect(m.mutate).toHaveBeenCalled()
  const payload = JSON.parse(
    JSON.stringify(m.mutate.mock.calls.at(-1)![1].body)
  )
  expect(payload.grades[0].feedback).toBe("")
})
