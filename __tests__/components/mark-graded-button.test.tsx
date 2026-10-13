// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { MarkGradedButton } from "@/components/grading/mark-graded-button"

function openDialog(incompleteCount: number, submittedCount = 5) {
  render(
    <MarkGradedButton
      examId="exam1"
      showResults={false}
      incompleteCount={incompleteCount}
      submittedCount={submittedCount}
    />
  )
  fireEvent.click(
    screen.getByRole("button", { name: "Als bewertet markieren" })
  )
}

describe("MarkGradedButton", () => {
  it("warns when submissions still have ungraded questions", () => {
    openDialog(2)
    expect(screen.getByRole("alert").textContent).toMatch(
      /2 von 5 Abgaben sind noch nicht vollständig bewertet/
    )
  })

  it("uses the singular for one submission", () => {
    openDialog(1, 1)
    expect(screen.getByRole("alert").textContent).toMatch(
      /1 von 1 Abgabe ist noch nicht/
    )
  })

  it("shows no warning when everything is graded", () => {
    openDialog(0)
    expect(screen.queryByRole("alert")).toBeNull()
  })
})
