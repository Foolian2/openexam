// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FakeWebSocket } from "./helpers/fake-websocket"

const sebClientMock = vi.hoisted(() => ({
  getSebKey: vi.fn(),
  getSebRequestHash: vi.fn(),
}))
vi.mock("@/lib/seb-client", () => sebClientMock)

import { useExamSocket } from "@/hooks/use-exam-socket"

type Props = Parameters<typeof useExamSocket>[0]

function setup(overrides: Partial<Props> = {}) {
  const props: Props = {
    sessionId: "sess-1",
    enabled: true,
    sebRequired: false,
    onControl: vi.fn(),
    onTimerSync: vi.fn(),
    onSebAuthFailed: vi.fn(),
    ...overrides,
  }
  const hook = renderHook((p: Props) => useExamSocket(p), {
    initialProps: props,
  })
  return { ...hook, props }
}

/** Let the async connect() (awaiting the SEB keys) run to completion. */
// The first connect is scattered over up to 500 ms (INITIAL_CONNECT_JITTER_MS
// in the hook) so a cohort admitted together doesn't handshake in lockstep.
async function flushConnect() {
  await act(async () => vi.advanceTimersByTime(500))
}

let uuid = 0

beforeEach(() => {
  vi.useFakeTimers()
  FakeWebSocket.reset()
  vi.stubGlobal("WebSocket", FakeWebSocket)
  vi.spyOn(Math, "random").mockReturnValue(0)
  uuid = 0
  vi.spyOn(crypto, "randomUUID").mockImplementation(
    () => `id-${++uuid}` as `${string}-${string}-${string}-${string}-${string}`
  )
  sebClientMock.getSebKey.mockResolvedValue("seb-key")
  sebClientMock.getSebRequestHash.mockResolvedValue("bek-key")
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("connection", () => {
  it("does not open a socket while disabled", async () => {
    setup({ enabled: false })
    await flushConnect()
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it("derives the ws URL from the page origin", async () => {
    setup()
    await flushConnect()
    expect(FakeWebSocket.last.url).toBe(
      `${window.location.origin.replace(/^http/, "ws")}/ws/exam/sess-1`
    )
  })

  it("prefers NEXT_PUBLIC_WS_URL when set", async () => {
    vi.stubEnv("NEXT_PUBLIC_WS_URL", "wss://ws.example.test")
    setup()
    await flushConnect()
    expect(FakeWebSocket.last.url).toBe("wss://ws.example.test/ws/exam/sess-1")
  })

  it("is connected on open without SEB and pings every 20s", async () => {
    const { result } = setup()
    await flushConnect()
    const ws = FakeWebSocket.last
    expect(result.current.connected).toBe(false)

    act(() => ws.open())
    expect(result.current.connected).toBe(true)
    expect(ws.sent).toHaveLength(0)

    act(() => vi.advanceTimersByTime(20_000))
    expect(ws.sentJson).toEqual([{ type: "ping" }])
    act(() => vi.advanceTimersByTime(40_000))
    expect(ws.sentJson).toHaveLength(3)
  })

  it("reconnects when the session changes", async () => {
    const { rerender, props } = setup()
    await flushConnect()
    const first = FakeWebSocket.last
    rerender({ ...props, sessionId: "sess-2" })
    await flushConnect()
    expect(first.readyState).toBe(FakeWebSocket.CLOSED)
    expect(FakeWebSocket.last.url).toMatch(/\/ws\/exam\/sess-2$/)
    // The old socket's close must not schedule a reconnect of its own.
    act(() => vi.advanceTimersByTime(60_000))
    expect(FakeWebSocket.instances).toHaveLength(2)
  })
})

describe("SEB handshake", () => {
  it("authenticates with both keys as the first message, never in the URL", async () => {
    const { result } = setup({ sebRequired: true })
    await flushConnect()
    const ws = FakeWebSocket.last
    expect(ws.url).not.toContain("seb-key")

    act(() => ws.open())
    expect(ws.sentJson).toEqual([
      { type: "seb_auth", sebKey: "seb-key", bekKey: "bek-key" },
    ])
    // Not connected, and no pings, until the server confirms.
    expect(result.current.connected).toBe(false)
    act(() => vi.advanceTimersByTime(60_000))
    expect(ws.sent).toHaveLength(1)
  })

  it("becomes connected and starts pinging on seb_auth_ok", async () => {
    const { result } = setup({ sebRequired: true })
    await flushConnect()
    const ws = FakeWebSocket.last
    act(() => ws.open())
    act(() => ws.receive({ type: "seb_auth_ok" }))
    expect(result.current.connected).toBe(true)
    act(() => vi.advanceTimersByTime(20_000))
    expect(ws.sentJson.at(-1)).toEqual({ type: "ping" })
  })

  it("stops reconnecting and reports once on seb_auth_failed", async () => {
    const { props } = setup({ sebRequired: true })
    await flushConnect()
    const ws = FakeWebSocket.last
    act(() => ws.open())
    act(() => ws.receive({ type: "seb_auth_failed" }))

    expect(props.onSebAuthFailed).toHaveBeenCalledTimes(1)
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED)
    // Async: a reconnect in SEB mode awaits the keys before opening.
    await act(() => vi.advanceTimersByTimeAsync(120_000))
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it("re-authenticates on every reconnect after an ordinary drop", async () => {
    setup({ sebRequired: true })
    await flushConnect()
    act(() => FakeWebSocket.last.open())
    act(() => FakeWebSocket.last.close())
    await act(() => vi.advanceTimersByTimeAsync(1_000))
    expect(FakeWebSocket.instances).toHaveLength(2)
    act(() => FakeWebSocket.last.open())
    expect(FakeWebSocket.last.sentJson[0]).toMatchObject({ type: "seb_auth" })
  })

  it("closes the socket when the auth frame cannot be sent", async () => {
    setup({ sebRequired: true })
    await flushConnect()
    const ws = FakeWebSocket.last
    ws.throwOnSend = true
    act(() => ws.open())
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED)
  })

  it("does not open a socket if unmounted while the keys resolve", async () => {
    let resolveKey!: (v: string) => void
    sebClientMock.getSebKey.mockReturnValue(
      new Promise<string>((r) => (resolveKey = r))
    )
    const { unmount } = setup({ sebRequired: true })
    unmount()
    await act(async () => resolveKey("seb-key"))
    expect(FakeWebSocket.instances).toHaveLength(0)
  })
})

describe("reconnect backoff", () => {
  it("doubles the delay from 1s up to a 30s cap", async () => {
    setup()
    await flushConnect()
    const expected = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]

    for (const [i, delay] of expected.entries()) {
      act(() => FakeWebSocket.last.close())
      act(() => vi.advanceTimersByTime(delay - 1))
      expect(FakeWebSocket.instances).toHaveLength(i + 1)
      act(() => vi.advanceTimersByTime(1))
      expect(FakeWebSocket.instances).toHaveLength(i + 2)
    }
  })

  it("adds random jitter of up to 20% of the delay", async () => {
    vi.mocked(Math.random).mockReturnValue(0.5)
    setup()
    await flushConnect()
    act(() => FakeWebSocket.last.close())
    act(() => vi.advanceTimersByTime(1_099))
    expect(FakeWebSocket.instances).toHaveLength(1)
    act(() => vi.advanceTimersByTime(1))
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it("never waits more than 1.2x the delay, even at maximum jitter", async () => {
    vi.mocked(Math.random).mockReturnValue(0.9999)
    setup()
    await flushConnect()
    act(() => FakeWebSocket.last.close())
    act(() => vi.advanceTimersByTime(1_200))
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it("resets the delay to 1s after a successful open", async () => {
    setup()
    await flushConnect()
    // Two failures push the next delay to 4s...
    act(() => FakeWebSocket.last.close())
    act(() => vi.advanceTimersByTime(1_000))
    act(() => FakeWebSocket.last.close())
    act(() => vi.advanceTimersByTime(2_000))
    expect(FakeWebSocket.instances).toHaveLength(3)
    // ...but a successful open brings it back to 1s.
    act(() => FakeWebSocket.last.open())
    act(() => FakeWebSocket.last.close())
    act(() => vi.advanceTimersByTime(1_000))
    expect(FakeWebSocket.instances).toHaveLength(4)
  })

  it("treats a socket error as a close and reconnects", async () => {
    const { result } = setup()
    await flushConnect()
    act(() => FakeWebSocket.last.open())
    act(() => FakeWebSocket.last.error())
    expect(result.current.connected).toBe(false)
    act(() => vi.advanceTimersByTime(1_000))
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it("stops pinging once the socket closes", async () => {
    setup()
    await flushConnect()
    const ws = FakeWebSocket.last
    act(() => ws.open())
    act(() => ws.close())
    // Would throw in FakeWebSocket.send if the interval were still alive;
    // the hook swallows that, so assert on the frame count instead.
    act(() => vi.advanceTimersByTime(20_000))
    expect(ws.sent).toHaveLength(0)
  })

  it("does not reconnect or ping after unmount", async () => {
    const { unmount } = setup()
    await flushConnect()
    const ws = FakeWebSocket.last
    act(() => ws.open())
    unmount()
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED)
    vi.advanceTimersByTime(120_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(ws.sent).toHaveLength(0)
  })

  it("cancels a pending reconnect on unmount", async () => {
    const { unmount } = setup()
    await flushConnect()
    act(() => FakeWebSocket.last.close())
    unmount()
    vi.advanceTimersByTime(120_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})

describe("sendAnswer acks", () => {
  async function connected() {
    const hook = setup()
    await flushConnect()
    const ws = FakeWebSocket.last
    act(() => ws.open())
    return { ...hook, ws }
  }

  it("sends answer:save with a fresh id and resolves true on ack", async () => {
    const { result, ws } = await connected()
    const p = result.current.sendAnswer("q1", { text: "hi" }, 1)
    expect(ws.sentJson).toEqual([
      {
        type: "answer:save",
        id: "id-1",
        data: { questionId: "q1", content: { text: "hi" }, clientSeq: 1 },
      },
    ])
    act(() => ws.receive({ type: "answer:ack", id: "id-1" }))
    await expect(p).resolves.toBe(true)
  })

  it("resolves false on answer:error", async () => {
    const { result, ws } = await connected()
    const p = result.current.sendAnswer("q1", "x", 1)
    act(() => ws.receive({ type: "answer:error", id: "id-1" }))
    await expect(p).resolves.toBe(false)
  })

  it("matches acks to their own request when several are in flight", async () => {
    const { result, ws } = await connected()
    const a = result.current.sendAnswer("q1", "a", 1)
    const b = result.current.sendAnswer("q2", "b", 1)
    act(() => ws.receive({ type: "answer:error", id: "id-2" }))
    act(() => ws.receive({ type: "answer:ack", id: "id-1" }))
    await expect(a).resolves.toBe(true)
    await expect(b).resolves.toBe(false)
  })

  it("resolves false after the 5s ack timeout, and ignores a late ack", async () => {
    const { result, ws } = await connected()
    let settled: boolean | undefined
    void result.current.sendAnswer("q1", "x", 1).then((v) => (settled = v))

    await act(async () => vi.advanceTimersByTime(4_999))
    expect(settled).toBeUndefined()
    await act(async () => vi.advanceTimersByTime(1))
    expect(settled).toBe(false)

    expect(() =>
      act(() => ws.receive({ type: "answer:ack", id: "id-1" }))
    ).not.toThrow()
  })

  it("resolves every pending answer false when the socket drops", async () => {
    const { result, ws } = await connected()
    const a = result.current.sendAnswer("q1", "a", 1)
    const b = result.current.sendAnswer("q2", "b", 1)
    act(() => ws.close())
    await expect(a).resolves.toBe(false)
    await expect(b).resolves.toBe(false)
  })

  it("resolves false immediately when the socket isn't open", async () => {
    const { result } = setup()
    await flushConnect()
    await expect(result.current.sendAnswer("q1", "x", 1)).resolves.toBe(false)
    expect(FakeWebSocket.last.sent).toHaveLength(0)
  })

  it("resolves false immediately when disabled", async () => {
    const { result } = setup({ enabled: false })
    await expect(result.current.sendAnswer("q1", "x", 1)).resolves.toBe(false)
  })

  it("resolves false when send throws, without leaking a timer", async () => {
    const { result, ws } = await connected()
    ws.throwOnSend = true
    await expect(result.current.sendAnswer("q1", "x", 1)).resolves.toBe(false)
    expect(vi.getTimerCount()).toBe(1) // only the ping interval remains
  })

  it("ignores acks without an id or for unknown ids", async () => {
    const { result, ws } = await connected()
    let settled: boolean | undefined
    void result.current.sendAnswer("q1", "x", 1).then((v) => (settled = v))
    act(() => ws.receive({ type: "answer:ack" }))
    act(() => ws.receive({ type: "answer:error" }))
    act(() => ws.receive({ type: "answer:ack", id: "nope" }))
    await act(async () => {})
    expect(settled).toBeUndefined()
  })
})

describe("message routing", () => {
  it("routes exam:control and timer:sync to the latest callbacks", async () => {
    const { rerender, props } = setup()
    await flushConnect()
    const ws = FakeWebSocket.last
    act(() => ws.open())

    const onControl = vi.fn()
    const onTimerSync = vi.fn()
    rerender({ ...props, onControl, onTimerSync })
    // New callbacks must not tear the connection down.
    expect(FakeWebSocket.instances).toHaveLength(1)

    act(() =>
      ws.receive({
        type: "exam:control",
        data: { action: "pause", sessionId: "sess-1" },
      })
    )
    const sync = { effectiveEndTime: null, serverNow: "2026-01-01T00:00:00Z" }
    act(() => ws.receive({ type: "timer:sync", data: sync }))

    expect(onControl).toHaveBeenCalledWith({
      action: "pause",
      sessionId: "sess-1",
    })
    expect(onTimerSync).toHaveBeenCalledWith(sync)
    expect(props.onControl).not.toHaveBeenCalled()
  })

  it("ignores malformed frames and unknown types", async () => {
    const { props, result } = setup()
    await flushConnect()
    const ws = FakeWebSocket.last
    act(() => ws.open())
    act(() => ws.receiveRaw("{not json"))
    act(() => ws.receive({ type: "something:else" }))
    expect(props.onControl).not.toHaveBeenCalled()
    expect(props.onTimerSync).not.toHaveBeenCalled()
    expect(result.current.connected).toBe(true)
  })
})

describe("sendIntegrityEvent", () => {
  it("sends a fire-and-forget integrity:event with the client time", async () => {
    const { result } = setup()
    await flushConnect()
    const ws = FakeWebSocket.last
    act(() => ws.open())
    vi.setSystemTime(new Date("2026-03-01T10:00:00Z"))
    result.current.sendIntegrityEvent("TAB_HIDDEN", "detail")
    expect(ws.sentJson).toEqual([
      {
        type: "integrity:event",
        data: {
          kind: "TAB_HIDDEN",
          detail: "detail",
          clientTime: "2026-03-01T10:00:00.000Z",
        },
      },
    ])
  })

  it("silently drops the event when the socket isn't open or send throws", async () => {
    const { result } = setup()
    await flushConnect()
    const ws = FakeWebSocket.last
    expect(() => result.current.sendIntegrityEvent("TAB_HIDDEN")).not.toThrow()
    act(() => ws.open())
    ws.throwOnSend = true
    expect(() => result.current.sendIntegrityEvent("TAB_HIDDEN")).not.toThrow()
    expect(ws.sent).toHaveLength(0)
  })
})

it("returns a referentially stable object while connection state is unchanged", async () => {
  const { result, rerender, props } = setup()
  await flushConnect()
  const before = result.current
  rerender({ ...props, onControl: vi.fn() })
  expect(result.current).toBe(before)
  act(() => FakeWebSocket.last.open())
  expect(result.current).not.toBe(before)
  expect(result.current.sendAnswer).toBe(before.sendAnswer)
})
