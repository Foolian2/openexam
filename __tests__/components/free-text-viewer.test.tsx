// @vitest-environment happy-dom
import { useState } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it, vi } from "vitest"

import { FreeTextViewer } from "@/components/questions/viewer/free-text-viewer"
import type { FreeTextAnswer } from "@/lib/types/answers"

it.each([100, 500, 501])(
  "accepts line breaks in plain-text answers with a %i-character limit",
  async (maxLength) => {
    const onChange = vi.fn()
    function AnswerField() {
      const [answer, setAnswer] = useState<FreeTextAnswer>({ text: "" })
      return (
        <FreeTextViewer
          config={{ maxLength, richText: false }}
          answer={answer}
          onChange={(next) => {
            onChange(next)
            setAnswer(next)
          }}
        />
      )
    }

    const user = userEvent.setup()
    render(<AnswerField />)
    await user.type(
      screen.getByRole("textbox"),
      "Erste Zeile{Enter}Zweite Zeile"
    )

    const text = "Erste Zeile\nZweite Zeile"
    expect(screen.getByRole("textbox")).toHaveValue(text)
    expect(onChange).toHaveBeenLastCalledWith({ text })
    expect(screen.getByText(`${text.length} / ${maxLength}`)).toBeVisible()
  }
)

it("restores a multiline plain-text answer for read-only viewing", () => {
  const text = "Erste Zeile\nZweite Zeile"
  render(
    <FreeTextViewer
      config={{ maxLength: 500, richText: false }}
      answer={{ text }}
      readOnly
    />
  )

  expect(screen.getByRole("textbox")).toHaveValue(text)
  expect(screen.getByRole("textbox")).toBeDisabled()
})
