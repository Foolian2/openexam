// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const loaderInit = vi.hoisted(() => vi.fn())

vi.mock("@monaco-editor/react", () => ({
  loader: { init: loaderInit },
  default: () => null,
}))
// The real dynamic() needs the Next.js runtime; render the loading state,
// which is what a student sees while Monaco is still coming from the CDN.
vi.mock("next/dynamic", () => ({
  default: () =>
    function MonacoStub(props: { loading?: React.ReactNode }) {
      return <>{props.loading}</>
    },
}))

const { CodeInput } = await import("@/components/shared/code-input")

beforeEach(() => {
  loaderInit.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
})

describe("CodeInput", () => {
  it("falls back to a textarea when Monaco fails to load", async () => {
    loaderInit.mockRejectedValue(new Event("error"))
    const onChange = vi.fn()
    render(
      <CodeInput
        language="python"
        value="def add(a, b):"
        onChange={onChange}
        ariaLabel="Code-Antwort"
      />
    )
    const textarea = await screen.findByLabelText("Code-Antwort")
    expect((textarea as HTMLTextAreaElement).value).toBe("def add(a, b):")
    fireEvent.change(textarea, { target: { value: "return a + b" } })
    expect(onChange).toHaveBeenCalledWith("return a + b")
  })

  it("falls back after a timeout when Monaco never finishes loading", async () => {
    vi.useFakeTimers()
    loaderInit.mockReturnValue(new Promise(() => {}))
    render(
      <CodeInput
        language="python"
        value=""
        onChange={() => {}}
        ariaLabel="Code-Antwort"
      />
    )
    expect(screen.getByText(/Editor wird geladen/)).toBeTruthy()
    await act(async () => {
      vi.advanceTimersByTime(8000)
    })
    expect(screen.getByLabelText("Code-Antwort").tagName).toBe("TEXTAREA")
  })
})
