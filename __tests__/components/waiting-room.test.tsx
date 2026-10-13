// @vitest-environment happy-dom
import { act, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

const replace = vi.fn()
// Stable, like Next's: the room re-renders every second (countdown clock).
const router = { replace }
vi.mock("next/navigation", () => ({ useRouter: () => router }))

import {
  ENTER_SPREAD_MS,
  WAITING_POLL_MS,
  WaitingRoom,
} from "@/components/exam-taking/waiting-room"

const fetchMock = vi.fn()
const NOW = new Date("2030-01-01T10:00:00Z")

function status(body: Record<string, unknown>) {
  return new Response(
    JSON.stringify({
      status: "WAITING",
      examStatus: "PUBLISHED",
      startedAt: null,
      serverNow: new Date(Date.now()).toISOString(),
      ...body,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  )
}

function renderRoom(initialStartedAt: string | null = null) {
  render(
    <WaitingRoom
      sessionId="s1"
      examId="exam"
      title="Mathe"
      timeLimitMin={60}
      initialStartedAt={initialStartedAt}
      initialServerNow={new Date(Date.now()).toISOString()}
    />
  )
}

/** Advance past one jittered poll and let its fetch settle. */
async function nextPoll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(WAITING_POLL_MS * 1.3)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  replace.mockReset()
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it("waits, then counts down to the shared start and opens the exam", async () => {
  fetchMock.mockResolvedValueOnce(status({}))
  renderRoom()
  expect(screen.getByText(/Du bist im Warteraum/)).toBeInTheDocument()

  await nextPoll()
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/sessions/s1/start-status",
    expect.anything()
  )
  expect(replace).not.toHaveBeenCalled()

  // The teacher presses Start: the clock begins 10 s from now.
  const startedAt = new Date(Date.now() + 10_000).toISOString()
  fetchMock.mockResolvedValueOnce(
    status({ status: "IN_PROGRESS", examStatus: "ACTIVE", startedAt })
  )
  await nextPoll()
  expect(screen.getByText(/Die Prüfung beginnt in \d+ s/)).toBeInTheDocument()
  const polls = fetchMock.mock.calls.length

  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000 + ENTER_SPREAD_MS)
  })
  expect(replace).toHaveBeenCalledWith("/exam/exam/take")
  // Polling stops once the start is known.
  expect(fetchMock.mock.calls.length).toBe(polls)
})

it("follows the server's clock, not the device's", async () => {
  // The device runs 30 s fast; the server says the start is 5 s away.
  const serverNow = new Date(Date.now() - 30_000)
  render(
    <WaitingRoom
      sessionId="s1"
      examId="exam"
      title="Mathe"
      timeLimitMin={60}
      initialStartedAt={new Date(serverNow.getTime() + 5_000).toISOString()}
      initialServerNow={serverNow.toISOString()}
    />
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4_000)
  })
  expect(replace).not.toHaveBeenCalled()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000 + ENTER_SPREAD_MS)
  })
  expect(replace).toHaveBeenCalledWith("/exam/exam/take")
})

it("says so when the exam is taken away before Start", async () => {
  fetchMock.mockResolvedValueOnce(status({ examStatus: "ARCHIVED" }))
  renderRoom()
  await nextPoll()
  expect(
    screen.getByText("Diese Prüfung ist nicht mehr verfügbar.")
  ).toBeInTheDocument()
})

it("warns after repeated failed polls and keeps trying", async () => {
  fetchMock.mockRejectedValue(new Error("offline"))
  renderRoom()
  await nextPoll()
  await nextPoll()
  expect(screen.queryByText(/Keine Verbindung/)).not.toBeInTheDocument()
  await nextPoll()
  expect(screen.getByText(/Keine Verbindung zum Server/)).toBeInTheDocument()
})
