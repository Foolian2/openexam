// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { OrderingViewer } from "@/components/questions/viewer/ordering-viewer"
import { MatchingViewer } from "@/components/questions/viewer/matching-viewer"

const viewers = [
  {
    name: "ordering",
    handle: "Element 1 verschieben",
    render: () =>
      render(
        <OrderingViewer
          config={{
            shuffle: false,
            items: [
              { id: "a", text: "First item" },
              { id: "b", text: "Second item" },
            ],
          }}
        />
      ),
  },
  {
    name: "matching",
    handle: "Zuordnung 1 verschieben",
    render: () =>
      render(
        <MatchingViewer
          config={{
            shuffleSides: false,
            pairs: [
              { id: "a", left: "One", right: "First item" },
              { id: "b", left: "Two", right: "Second item" },
              { id: "c", left: "Three", right: "Third item" },
            ],
          }}
        />
      ),
  },
]

describe.each(viewers)("$name dragging", (viewer) => {
  it("allows a touch swipe on the row without picking up the item", () => {
    viewer.render()
    const handle = screen.getByRole("button", { name: viewer.handle })
    fireEvent.pointerDown(handle.parentElement!, {
      pointerType: "touch",
      isPrimary: true,
      button: 0,
    })
    expect(handle).not.toHaveAttribute("aria-pressed", "true")
  })

  it("starts a touch drag from the grip icon", () => {
    viewer.render()
    const handle = screen.getByRole("button", { name: viewer.handle })
    fireEvent.pointerDown(handle.querySelector("svg")!, {
      pointerType: "touch",
      isPrimary: true,
      button: 0,
    })
    expect(handle).toHaveAttribute("aria-pressed", "true")
    fireEvent.pointerUp(document)
  })

  it("keeps mouse dragging from the row text", () => {
    viewer.render()
    const handle = screen.getByRole("button", { name: viewer.handle })
    fireEvent.pointerDown(handle.parentElement!, {
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
    })
    expect(handle).toHaveAttribute("aria-pressed", "true")
    fireEvent.pointerUp(document)
  })

  it("lets the keyboard pick up and cancel from the handle", async () => {
    viewer.render()
    const handle = screen.getByRole("button", { name: viewer.handle })
    handle.focus()
    fireEvent.keyDown(handle, { code: "Space" })
    expect(handle).toHaveAttribute("aria-pressed", "true")
    // dnd-kit defers the document key listener until after the pickup key.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    fireEvent.keyDown(document, { code: "Escape" })
    expect(handle).not.toHaveAttribute("aria-pressed", "true")
  })
})
