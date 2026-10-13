// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
  // The ticker is module state; start each test from a fresh module.
  vi.resetModules()
})
afterEach(() => vi.useRealTimers())

async function load() {
  return (await import("@/hooks/use-clock")).useClock
}

it("ticks once per second", async () => {
  const useClock = await load()
  const { result } = renderHook(() => useClock())
  const start = result.current
  act(() => vi.advanceTimersByTime(1_000))
  expect(result.current).toBe(start + 1_000)
  act(() => vi.advanceTimersByTime(3_000))
  expect(result.current).toBe(start + 4_000)
})

it("shares a single interval between every subscriber and stops after the last", async () => {
  const useClock = await load()
  const a = renderHook(() => useClock())
  const b = renderHook(() => useClock())
  expect(vi.getTimerCount()).toBe(1)

  act(() => vi.advanceTimersByTime(1_000))
  expect(a.result.current).toBe(b.result.current)

  a.unmount()
  expect(vi.getTimerCount()).toBe(1)
  b.unmount()
  expect(vi.getTimerCount()).toBe(0)

  // Re-subscribing restarts the ticker.
  renderHook(() => useClock())
  expect(vi.getTimerCount()).toBe(1)
})

it("does not hand a new subscriber a stale time after the ticker was idle", async () => {
  const useClock = await load()
  renderHook(() => useClock()).unmount()
  vi.setSystemTime(new Date("2026-01-01T01:00:00Z"))
  const { result } = renderHook(() => useClock())
  expect(result.current).toBe(Date.parse("2026-01-01T01:00:00Z"))
})

it("returns a stable value between ticks (no render loop)", async () => {
  const useClock = await load()
  let renders = 0
  const { result } = renderHook(() => {
    renders++
    return useClock()
  })
  const first = result.current
  vi.setSystemTime(new Date("2026-01-01T00:00:00.500Z"))
  expect(result.current).toBe(first)
  expect(renders).toBeLessThan(3)
})
