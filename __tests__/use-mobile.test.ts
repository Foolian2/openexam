// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { useIsMobile } from "@/hooks/use-mobile"

let listeners: Array<() => void>
let queries: string[]

beforeEach(() => {
  listeners = []
  queries = []
  vi.stubGlobal("matchMedia", (query: string) => {
    queries.push(query)
    return {
      addEventListener: (_: string, l: () => void) => listeners.push(l),
      removeEventListener: (_: string, l: () => void) => {
        listeners = listeners.filter((x) => x !== l)
      },
    }
  })
})
afterEach(() => vi.unstubAllGlobals())

function setWidth(width: number) {
  vi.spyOn(window, "innerWidth", "get").mockReturnValue(width)
}

it("is true below the 768px breakpoint", () => {
  setWidth(767)
  const { result } = renderHook(() => useIsMobile())
  expect(result.current).toBe(true)
  expect(queries).toEqual(["(max-width: 767px)"])
})

it("is false at and above the breakpoint", () => {
  setWidth(768)
  const { result } = renderHook(() => useIsMobile())
  expect(result.current).toBe(false)
})

it("follows media-query changes and unsubscribes on unmount", () => {
  setWidth(1024)
  const { result, unmount } = renderHook(() => useIsMobile())
  expect(result.current).toBe(false)
  setWidth(400)
  act(() => listeners.forEach((l) => l()))
  expect(result.current).toBe(true)
  unmount()
  expect(listeners).toHaveLength(0)
})
