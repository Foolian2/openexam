// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FakeWebSocket } from "./helpers/fake-websocket"
import { useMonitorSocket } from "@/hooks/use-monitor-socket"

type Props = Parameters<typeof useMonitorSocket<{ id: string }>>[0]

function setup(overrides: Partial<Props> = {}) {
  const props: Props = {
    examId: "exam-1",
    enabled: true,
    onSnapshot: vi.fn(),
    onUpdate: vi.fn(),
    ...overrides,
  }
  const hook = renderHook((p: Props) => useMonitorSocket(p), {
    initialProps: props,
  })
  return { ...hook, props }
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeWebSocket.reset()
  vi.stubGlobal("WebSocket", FakeWebSocket)
  vi.spyOn(Math, "random").mockReturnValue(0)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it("does not open a socket while disabled", () => {
  setup({ enabled: false })
  expect(FakeWebSocket.instances).toHaveLength(0)
})

it("connects to the exam's monitor channel", () => {
  vi.stubEnv("NEXT_PUBLIC_WS_URL", "wss://ws.example.test")
  const { result } = setup()
  expect(FakeWebSocket.last.url).toBe("wss://ws.example.test/ws/monitor/exam-1")
  expect(result.current.connected).toBe(false)
  act(() => FakeWebSocket.last.open())
  expect(result.current.connected).toBe(true)
})

describe("message routing", () => {
  it("routes snapshots and updates to the latest callbacks", () => {
    const { rerender, props } = setup()
    const ws = FakeWebSocket.last
    act(() => ws.open())
    const onSnapshot = vi.fn()
    const onUpdate = vi.fn()
    rerender({ ...props, onSnapshot, onUpdate })
    expect(FakeWebSocket.instances).toHaveLength(1)

    act(() => ws.receive({ type: "monitor:snapshot", data: [{ id: "s1" }] }))
    const update = { sessionId: "s1", patch: { status: "SUBMITTED" } }
    act(() => ws.receive({ type: "monitor:update", data: update }))

    expect(onSnapshot).toHaveBeenCalledWith([{ id: "s1" }])
    expect(onUpdate).toHaveBeenCalledWith(update)
    expect(props.onSnapshot).not.toHaveBeenCalled()
  })

  it("ignores malformed frames and unknown types", () => {
    const { props } = setup()
    const ws = FakeWebSocket.last
    act(() => ws.open())
    act(() => ws.receiveRaw("nope"))
    act(() => ws.receive({ type: "pong" }))
    expect(props.onSnapshot).not.toHaveBeenCalled()
    expect(props.onUpdate).not.toHaveBeenCalled()
  })
})

describe("reconnect backoff", () => {
  it("doubles the delay from 1s up to a 30s cap", () => {
    setup()
    const expected = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]
    for (const [i, delay] of expected.entries()) {
      act(() => FakeWebSocket.last.close())
      act(() => vi.advanceTimersByTime(delay - 1))
      expect(FakeWebSocket.instances).toHaveLength(i + 1)
      act(() => vi.advanceTimersByTime(1))
      expect(FakeWebSocket.instances).toHaveLength(i + 2)
    }
  })

  it("resets the delay after a successful open", () => {
    setup()
    act(() => FakeWebSocket.last.close())
    act(() => vi.advanceTimersByTime(1_000))
    act(() => FakeWebSocket.last.close())
    act(() => vi.advanceTimersByTime(2_000))
    act(() => FakeWebSocket.last.open())
    act(() => FakeWebSocket.last.close())
    act(() => vi.advanceTimersByTime(1_000))
    expect(FakeWebSocket.instances).toHaveLength(4)
  })

  it("treats an error as a close", () => {
    const { result } = setup()
    act(() => FakeWebSocket.last.open())
    act(() => FakeWebSocket.last.error())
    expect(result.current.connected).toBe(false)
    act(() => vi.advanceTimersByTime(1_000))
    expect(FakeWebSocket.instances).toHaveLength(2)
  })
})

it("closes and stops reconnecting on unmount", () => {
  const { unmount } = setup()
  const ws = FakeWebSocket.last
  act(() => ws.close())
  unmount()
  vi.advanceTimersByTime(120_000)
  expect(FakeWebSocket.instances).toHaveLength(1)
})

it("reconnects to the new exam when examId changes", () => {
  const { rerender, props } = setup()
  const first = FakeWebSocket.last
  rerender({ ...props, examId: "exam-2" })
  expect(first.readyState).toBe(FakeWebSocket.CLOSED)
  expect(FakeWebSocket.last.url).toMatch(/\/ws\/monitor\/exam-2$/)
  act(() => vi.advanceTimersByTime(60_000))
  expect(FakeWebSocket.instances).toHaveLength(2)
})
