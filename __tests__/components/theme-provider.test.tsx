// @vitest-environment happy-dom
import type { ReactNode } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ThemeProvider } from "@/components/theme-provider"

const { setTheme } = vi.hoisted(() => ({ setTheme: vi.fn() }))

vi.mock("next-themes", () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
  useTheme: () => ({ resolvedTheme: "light", setTheme }),
}))

beforeEach(() => setTheme.mockClear())

describe("theme keyboard shortcut", () => {
  it("toggles the theme when pressing d outside an editor", () => {
    render(
      <ThemeProvider>
        <button>Page action</button>
      </ThemeProvider>
    )
    fireEvent.keyDown(screen.getByRole("button"), { key: "d" })
    expect(setTheme).toHaveBeenCalledExactlyOnceWith("dark")
  })

  it.each(["d", "D"])("ignores %s inside Monaco's div-based input", (key) => {
    render(
      <ThemeProvider>
        <div className="monaco-editor">
          <div
            className="native-edit-context"
            tabIndex={0}
            data-testid="code-input"
          />
        </div>
      </ThemeProvider>
    )
    const input = screen.getByTestId("code-input")
    input.focus()
    fireEvent.keyDown(input, { key })
    expect(setTheme).not.toHaveBeenCalled()
  })

  it("ignores d while Monaco has focus even if the event targets the window", () => {
    render(
      <ThemeProvider>
        <div className="monaco-editor">
          <div tabIndex={0} data-testid="code-input" />
        </div>
      </ThemeProvider>
    )
    screen.getByTestId("code-input").focus()
    fireEvent.keyDown(window, { key: "d" })
    expect(setTheme).not.toHaveBeenCalled()
    screen.getByTestId("code-input").blur()
    fireEvent.keyDown(window, { key: "d" })
    expect(setTheme).toHaveBeenCalledExactlyOnceWith("dark")
  })

  it("ignores d in text fields and rich-text editors", () => {
    render(
      <ThemeProvider>
        <input aria-label="Title" />
        <textarea aria-label="Answer" />
        <select aria-label="Language">
          <option>Python</option>
        </select>
        <div contentEditable data-testid="rich-text" />
      </ThemeProvider>
    )
    for (const target of [
      screen.getByRole("textbox", { name: "Title" }),
      screen.getByRole("textbox", { name: "Answer" }),
      screen.getByRole("combobox"),
      screen.getByTestId("rich-text"),
    ]) {
      fireEvent.keyDown(target, { key: "d" })
    }
    expect(setTheme).not.toHaveBeenCalled()
  })

  it.each([
    { key: "d", ctrlKey: true },
    { key: "d", metaKey: true },
    { key: "d", altKey: true },
    { key: "d", repeat: true },
    { key: "a" },
  ])("ignores other keys, modifiers and repeats: %j", (event) => {
    render(<ThemeProvider />)
    fireEvent.keyDown(window, event)
    expect(setTheme).not.toHaveBeenCalled()
  })
})
