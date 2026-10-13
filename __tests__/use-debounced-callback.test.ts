// @vitest-environment happy-dom
import { renderHook } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { useDebouncedCallback } from "@/hooks/use-debounced-callback"

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function setup(delayMs = 300) {
  const cb = vi.fn()
  const hook = renderHook(
    ({ cb, delayMs }: { cb: (...a: unknown[]) => void; delayMs: number }) =>
      useDebouncedCallback(cb, delayMs),
    { initialProps: { cb, delayMs } }
  )
  return { ...hook, cb }
}

it("calls once, delayMs after the last invocation, with the last arguments", () => {
  const { result, cb } = setup()
  result.current("a")
  vi.advanceTimersByTime(200)
  result.current("b")
  vi.advanceTimersByTime(299)
  expect(cb).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(cb).toHaveBeenCalledTimes(1)
  expect(cb).toHaveBeenCalledWith("b")
})

it("invokes the latest callback even if it changed after scheduling", () => {
  const { result, rerender, cb } = setup()
  result.current(1)
  const next = vi.fn()
  rerender({ cb: next, delayMs: 300 })
  vi.advanceTimersByTime(300)
  expect(cb).not.toHaveBeenCalled()
  expect(next).toHaveBeenCalledWith(1)
})

it("returns a stable function until the delay changes", () => {
  const { result, rerender, cb } = setup()
  const first = result.current
  rerender({ cb: vi.fn(), delayMs: 300 })
  expect(result.current).toBe(first)
  rerender({ cb, delayMs: 500 })
  expect(result.current).not.toBe(first)
})

it("drops a pending call on unmount", () => {
  const { result, unmount, cb } = setup()
  result.current()
  unmount()
  vi.advanceTimersByTime(1_000)
  expect(cb).not.toHaveBeenCalled()
})
