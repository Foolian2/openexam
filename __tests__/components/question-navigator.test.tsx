// @vitest-environment happy-dom
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import {
  QuestionNavigator,
  type NavigatorQuestionState,
} from "@/components/exam-taking/question-navigator"

const items: {
  id: string
  state: NavigatorQuestionState
  bookmarked: boolean
}[] = [
  { id: "q1", state: "answered", bookmarked: false },
  { id: "q2", state: "open", bookmarked: true },
  { id: "q3", state: "required-open", bookmarked: false },
  { id: "q4", state: "error", bookmarked: true },
]

function renderNav(
  props: Partial<Parameters<typeof QuestionNavigator>[0]> = {}
) {
  const onNavigate = vi.fn()
  const utils = render(
    <QuestionNavigator
      items={items}
      currentId="q2"
      onNavigate={onNavigate}
      variant="rail"
      answeredCount={2}
      {...props}
    />
  )
  return { ...utils, onNavigate }
}

describe.each(["rail", "dots"] as const)("variant %s", (variant) => {
  it("labels every question with its number and state for screen readers", () => {
    renderNav({ variant })
    const nav = screen.getByRole("navigation", { name: "Fragenübersicht" })
    for (const name of [
      "Frage 1, beantwortet",
      "Frage 2, unbeantwortet",
      "Frage 3, Pflichtfrage, unbeantwortet",
      "Frage 4, beantwortet, Speichern fehlgeschlagen",
    ]) {
      expect(within(nav).getByRole("button", { name })).toBeInTheDocument()
    }
  })

  it("marks only the current question with aria-current", () => {
    renderNav({ variant })
    expect(screen.getByRole("button", { name: /^Frage 2,/ })).toHaveAttribute(
      "aria-current",
      "true"
    )
    expect(
      screen.getByRole("button", { name: /^Frage 1,/ })
    ).not.toHaveAttribute("aria-current")
  })

  it("navigates to the clicked question", async () => {
    const { onNavigate } = renderNav({ variant })
    await userEvent.click(screen.getByRole("button", { name: /^Frage 3,/ }))
    expect(onNavigate).toHaveBeenCalledWith("q3")
  })

  it("filters to bookmarked questions, keeping their original numbers", async () => {
    renderNav({ variant })
    await userEvent.click(screen.getByRole("button", { name: "Markiert (2)" }))
    const questions = screen.getAllByRole("button", { name: /^Frage / })
    expect(questions.map((b) => b.textContent)).toEqual(["2", "4"])
    await userEvent.click(screen.getByRole("button", { name: "Alle Fragen" }))
    expect(screen.getAllByRole("button", { name: /^Frage / })).toHaveLength(4)
  })

  it("explains how to bookmark when the filter matches nothing", async () => {
    renderNav({
      variant,
      items: items.map((i) => ({ ...i, bookmarked: false })),
    })
    expect(screen.queryByText(/Keine Fragen markiert/)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Markiert (0)" }))
    expect(screen.getByText(/Keine Fragen markiert/)).toBeInTheDocument()
  })
})

it("shows answered progress in the rail", () => {
  renderNav({ variant: "rail" })
  expect(screen.getByText("2 von 4 Fragen beantwortet")).toBeInTheDocument()
  expect(
    screen.getByRole("progressbar", { name: "Beantwortete Fragen" })
  ).toHaveAttribute("aria-valuenow", "50")
})

it("omits the progress summary in the compact dots variant", () => {
  renderNav({ variant: "dots" })
  expect(screen.queryByText(/Fragen beantwortet/)).not.toBeInTheDocument()
})

it("renders nothing without questions", () => {
  const { container } = renderNav({ items: [] })
  expect(container).toBeEmptyDOMElement()
})
