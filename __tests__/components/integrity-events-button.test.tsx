// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { IntegrityEventsButton } from "@/components/monitor/integrity-events-button"

describe("integrity event summaries", () => {
  it("keeps informational focus loss accessible without warning styling", () => {
    const onClick = vi.fn()
    render(
      <IntegrityEventsButton
        integrityEventCount={0}
        focusLossEventCount={2}
        onClick={onClick}
      />
    )
    const button = screen.getByRole("button", { name: "2 Hinweise" })
    expect(button.className).not.toContain("text-destructive")
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledOnce()
  })

  it("keeps warnings visible alongside informational focus loss", () => {
    render(
      <IntegrityEventsButton
        integrityEventCount={1}
        focusLossEventCount={2}
        onClick={vi.fn()}
      />
    )
    expect(
      screen.getByRole("button", { name: "1 Auffälligkeit · 2 Hinweise" })
        .className
    ).toContain("text-destructive")
  })

  it("supports snapshots from before informational counts existed", () => {
    render(<IntegrityEventsButton integrityEventCount={3} onClick={vi.fn()} />)
    expect(
      screen.getByRole("button", { name: "3 Auffälligkeiten" })
    ).toBeInTheDocument()
  })

  it("shows no warning or button without events", () => {
    render(<IntegrityEventsButton integrityEventCount={0} onClick={vi.fn()} />)
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
    expect(screen.getByText("Keine Auffälligkeiten")).toBeInTheDocument()
  })

  it("keeps the compact table cell narrow but fully labelled", () => {
    render(
      <IntegrityEventsButton
        integrityEventCount={1}
        focusLossEventCount={2}
        compact
        onClick={vi.fn()}
      />
    )
    const button = screen.getByRole("button", {
      name: "1 Auffälligkeit · 2 Hinweise",
    })
    expect(button).toHaveTextContent(/^12$/)
    expect(button.className).toContain("text-destructive")
  })

  it("shows a dash in the compact cell without events", () => {
    render(
      <IntegrityEventsButton
        integrityEventCount={0}
        compact
        onClick={vi.fn()}
      />
    )
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
    expect(screen.getByText("—")).toBeInTheDocument()
  })
})
