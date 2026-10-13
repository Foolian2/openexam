// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"
import { RubricChecklist } from "@/components/grading/rubric-checklist"

const rubric = [
  { id: "r1", criterion: "Korrekte Formel", points: 2 },
  { id: "r2", criterion: "Einheiten angegeben", points: 1 },
  { id: "r3", criterion: "Begründung", points: 3 },
]

function setup() {
  const onApply = vi.fn()
  render(<RubricChecklist rubric={rubric} maxPoints={6} onApply={onApply} />)
  return { onApply }
}

it("starts with nothing checked and a zero suggestion", () => {
  setup()
  for (const box of screen.getAllByRole("checkbox")) {
    expect(box).toHaveAttribute("aria-checked", "false")
  }
  expect(screen.getByText("Vorschlag: 0 / 6 P.")).toBeInTheDocument()
})

it("exposes each criterion as exactly one accessible checkbox", () => {
  setup()
  expect(screen.getAllByRole("checkbox")).toHaveLength(3)
  expect(
    screen.getByRole("checkbox", { name: /Korrekte Formel/ })
  ).toBeInTheDocument()
})

it("sums the points of checked criteria and applies the total", async () => {
  const { onApply } = setup()
  await userEvent.click(
    screen.getByRole("checkbox", { name: /Korrekte Formel/ })
  )
  await userEvent.click(screen.getByRole("checkbox", { name: /Begründung/ }))
  expect(screen.getByText("Vorschlag: 5 / 6 P.")).toBeInTheDocument()

  await userEvent.click(screen.getByRole("button", { name: "Übernehmen" }))
  expect(onApply).toHaveBeenCalledWith(5)
})

it("unchecks on a second click", async () => {
  setup()
  const box = screen.getByRole("checkbox", { name: /Einheiten/ })
  await userEvent.click(box)
  expect(box).toHaveAttribute("aria-checked", "true")
  await userEvent.click(box)
  expect(box).toHaveAttribute("aria-checked", "false")
  expect(screen.getByText("Vorschlag: 0 / 6 P.")).toBeInTheDocument()
})

it("toggles from the keyboard with Space and Enter", async () => {
  setup()
  const user = userEvent.setup()
  await user.tab()
  expect(
    screen.getByRole("checkbox", { name: /Korrekte Formel/ })
  ).toHaveFocus()
  await user.keyboard(" ")
  await user.tab()
  await user.keyboard("{Enter}")
  expect(screen.getByText("Vorschlag: 3 / 6 P.")).toBeInTheDocument()
})
