// @vitest-environment happy-dom
import { act, render, screen } from "@testing-library/react"
import { Storage as BrowserStorage } from "happy-dom"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { ClaimOutcome } from "@/lib/exam-device-client"

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  claim: vi.fn<() => Promise<ClaimOutcome>>(async () => ({ ok: true })),
  router: { push: vi.fn() },
  socket: {
    connected: false,
    sendAnswer: vi.fn(async () => false),
    sendIntegrityEvent: vi.fn(),
  },
}))

vi.mock("next/navigation", () => ({ useRouter: () => mocks.router }))
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "light" }) }))
vi.mock("@/lib/seb-client", () => ({
  sebFetch: mocks.fetch,
  getSebKey: vi.fn(async () => null),
}))
vi.mock("@/lib/exam-device-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exam-device-client")>()),
  claimExamDevice: mocks.claim,
}))
vi.mock("@/hooks/use-exam-socket", () => ({
  useExamSocket: () => mocks.socket,
}))
vi.mock("@/hooks/use-integrity-monitor", () => ({
  useIntegrityMonitor: vi.fn(),
}))
vi.mock("@/components/exam-taking/exam-settings-menu", () => ({
  ExamSettingsMenu: () => null,
}))
vi.mock("@/components/exam-taking/exam-system-status", () => ({
  ExamSystemStatus: () => null,
}))
vi.mock("@/components/questions/viewer/viewer-registry", () => ({
  BASE_VIEWERS: {},
  renderQuestionViewer: vi.fn(),
}))

import { ExamRunner } from "@/components/exam-taking/exam-runner"

function response(status = "IN_PROGRESS") {
  return new Response(
    JSON.stringify({
      session: { id: "s1", status, effectiveEndTime: null },
      exam: {
        id: "e1",
        title: "Test exam",
        description: null,
        timeLimitMin: 60,
        status: "ACTIVE",
      },
      questions: [],
      answers: [],
      bookmarkedQuestionIds: [],
      serverNow: new Date().toISOString(),
    }),
    { status: 200 }
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, "random").mockReturnValue(0.5)
  mocks.fetch.mockReset()
  mocks.claim.mockReset().mockResolvedValue({ ok: true })
  mocks.router.push.mockReset()
  // Node 26 also exposes Web Storage globals; use this test browser's
  // storage so the simulated runner exercises browser persistence.
  vi.stubGlobal("localStorage", new BrowserStorage())
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      // next/link's prefetch observer unobserves on unmount.
      unobserve() {}
      disconnect() {}
    }
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function mount() {
  const view = render(
    <ExamRunner sessionId="s1" examId="e1" sebRequired={false} />
  )
  await act(async () => {})
  return view
}

it("waits for the initial claim and load before starting status polls", async () => {
  let finishClaim!: (claim: ClaimOutcome) => void
  mocks.claim.mockImplementationOnce(
    () => new Promise<ClaimOutcome>((resolve) => (finishClaim = resolve))
  )
  mocks.fetch.mockResolvedValue(response())
  const view = await mount()
  await act(async () => vi.advanceTimersByTimeAsync(60_000))
  expect(mocks.fetch).not.toHaveBeenCalled()

  await act(async () => finishClaim({ ok: true }))
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
  await act(async () => vi.advanceTimersByTimeAsync(15_000))
  expect(mocks.fetch).toHaveBeenCalledTimes(2)
  view.unmount()
})

it.each(["request", "body"])(
  "recovers from a stalled status %s and receives a teacher lock",
  async (stalledPart) => {
    // Initial load succeeds. The first poll hangs even if aborted, modelling
    // a transport that never settles; only a bounded read can recover.
    const pending = new Promise<Response>(() => {})
    mocks.fetch
      .mockResolvedValueOnce(response())
      .mockImplementationOnce(() =>
        stalledPart === "request"
          ? pending
          : Promise.resolve({
              ok: true,
              json: () => new Promise(() => {}),
            })
      )
      .mockResolvedValue(response("LOCKED"))
    const view = await mount()
    await act(async () => vi.advanceTimersByTimeAsync(15_000))
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    await act(async () => vi.advanceTimersByTimeAsync(15_000))
    expect(mocks.fetch).toHaveBeenCalledTimes(3)
    const signal = mocks.fetch.mock.calls[1][1].signal as AbortSignal
    expect(signal.aborted).toBe(true)
    expect(screen.getByText("Von der Lehrperson gesperrt")).toBeInTheDocument()
    view.unmount()
  }
)

it("ignores a timed-out response that arrives after a newer status read", async () => {
  let resolve!: (response: Response) => void
  mocks.fetch
    .mockResolvedValueOnce(response())
    .mockImplementationOnce(() => new Promise<Response>((r) => (resolve = r)))
    .mockResolvedValue(response())
  const view = await mount()
  await act(async () => vi.advanceTimersByTimeAsync(40_000))
  expect(mocks.fetch).toHaveBeenCalledTimes(3)
  await act(async () => resolve(response("LOCKED")))
  expect(
    screen.queryByText("Von der Lehrperson gesperrt")
  ).not.toBeInTheDocument()
  view.unmount()
})

it("aborts an active status read and cancels further polling on unmount", async () => {
  mocks.fetch
    .mockResolvedValueOnce(response())
    .mockImplementation(() => new Promise(() => {}))
  const view = await mount()
  await act(async () => vi.advanceTimersByTimeAsync(15_000))
  const signal = mocks.fetch.mock.calls[1][1].signal as AbortSignal
  view.unmount()
  expect(signal.aborted).toBe(true)
  await act(async () => vi.advanceTimersByTimeAsync(60_000))
  expect(mocks.fetch).toHaveBeenCalledTimes(2)
})

it("shows the takeover screen and stops polling once another login took over", async () => {
  mocks.fetch.mockResolvedValueOnce(response()).mockResolvedValue(
    new Response(
      JSON.stringify({
        error: { code: "SESSION_REPLACED", message: "replaced" },
      }),
      { status: 409 }
    )
  )
  const view = await mount()
  await act(async () => vi.advanceTimersByTimeAsync(15_000))
  expect(mocks.fetch).toHaveBeenCalledTimes(2)
  expect(
    screen.getByRole("button", { name: "Hier weiterarbeiten" })
  ).toBeInTheDocument()
  await act(async () => vi.advanceTimersByTimeAsync(120_000))
  expect(mocks.fetch).toHaveBeenCalledTimes(2)
  view.unmount()
})

it("does not load an editable exam or poll after a failed initial claim", async () => {
  mocks.claim.mockResolvedValue({
    ok: false,
    status: 409,
    code: "CONFLICT",
    message: "Sitzung ist nicht mehr aktiv",
  })
  mocks.fetch.mockResolvedValue(response())
  const view = await mount()
  await act(async () => vi.advanceTimersByTimeAsync(60_000))
  expect(mocks.fetch).not.toHaveBeenCalled()
  expect(screen.getByText("Sitzung ist nicht mehr aktiv")).toBeInTheDocument()
  view.unmount()
})

it("explains a rate-limited claim instead of only asking for a reload", async () => {
  mocks.claim.mockResolvedValue({
    ok: false,
    status: 429,
    code: "RATE_LIMITED",
    message: "Zu viele Anfragen. Bitte später erneut versuchen.",
  })
  const view = await mount()
  await act(async () => vi.advanceTimersByTimeAsync(1_000))
  expect(
    screen.getByText(
      "Zu viele Versuche. Bitte warten Sie eine Minute und laden Sie dann neu."
    )
  ).toBeInTheDocument()
  view.unmount()
})

it("shows the takeover screen when an upload reports a takeover", async () => {
  mocks.fetch.mockResolvedValue(response())
  const view = await mount()
  const { reportSessionReplaced } = await import("@/lib/exam-device-client")
  await act(async () => reportSessionReplaced("s1"))
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Diese Prüfung wurde auf einem anderen Gerät"
  )
  expect(
    screen.getByRole("button", { name: "Hier weiterarbeiten" })
  ).toHaveFocus()
  view.unmount()
})
