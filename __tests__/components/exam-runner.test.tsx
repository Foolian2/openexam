// @vitest-environment happy-dom
import { act, fireEvent, render, screen, cleanup } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
const m = vi.hoisted(() => ({
  push: vi.fn(),
  sendAnswer: vi.fn(),
  sendIntegrityEvent: vi.fn(),
  fetch: vi.fn(),
  api: vi.fn(),
}))
const router = { push: m.push }
const socket = {
  connected: false,
  sendAnswer: m.sendAnswer,
  sendIntegrityEvent: m.sendIntegrityEvent,
}
vi.mock("next/navigation", () => ({ useRouter: () => router }))
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "system" }) }))
vi.mock("@/hooks/use-exam-socket", () => ({ useExamSocket: () => socket }))
vi.mock("@/hooks/use-integrity-monitor", () => ({
  useIntegrityMonitor: () => {},
}))
vi.mock("@/lib/seb-client", () => ({ sebFetch: m.fetch, getSebKey: vi.fn() }))
vi.mock("@/lib/api-mutate", () => ({ apiMutate: m.api }))
vi.mock("@/components/accessibility-provider", () => ({
  useAccessibility: () => ({ prefs: { hideExamTimer: false } }),
}))
vi.mock("@/components/exam-taking/exam-settings-menu", () => ({
  ExamSettingsMenu: () => null,
}))
vi.mock("@/components/exam-taking/exam-system-status", () => ({
  ExamSystemStatus: () => null,
}))
vi.mock("@/components/exam-taking/question-navigator", () => ({
  QuestionNavigator: () => null,
  QuestionProgressBar: () => null,
}))
vi.mock("@/components/questions/viewer/matching-viewer", () => ({
  MatchingViewer: () => null,
}))
vi.mock("@/components/questions/viewer/ordering-viewer", () => ({
  OrderingViewer: () => null,
}))
vi.mock("@/components/questions/viewer/viewer-registry", () => ({
  BASE_VIEWERS: {},
  renderQuestionViewer: (
    _registry: unknown,
    p: {
      answer?: { text?: string }
      onChange: (content: { type: "FREE_TEXT"; text: string }) => void
    }
  ) => (
    <textarea
      aria-label="answer"
      value={p.answer?.text ?? ""}
      onChange={(e) => p.onChange({ type: "FREE_TEXT", text: e.target.value })}
    />
  ),
}))
import { ExamRunner } from "@/components/exam-taking/exam-runner"
import { TooltipProvider } from "@/components/ui/tooltip"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function setup(expired = false, storage?: unknown) {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    }
  )
  vi.stubGlobal("localStorage", storage)
  // Captured once: the json() body below re-evaluates on every fetch, and a
  // deadline computed per call would keep sliding out on each status poll —
  // the countdown could then never reach zero.
  const endTime = new Date(
    Date.now() + (expired ? -1000 : 3600000)
  ).toISOString()
  const serverNow = new Date().toISOString()
  m.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      session: {
        id: "s",
        status: "IN_PROGRESS",
        effectiveEndTime: endTime,
      },
      exam: {
        id: "e",
        title: "Audit exam",
        description: null,
        status: "ACTIVE",
        timeLimitMin: 60,
      },
      questions: [
        {
          id: "q",
          type: "FREE_TEXT",
          title: "Question",
          order: 0,
          points: 1,
          required: false,
          config: {},
        },
      ],
      answers: [],
      bookmarkedQuestionIds: [],
      serverNow,
    }),
  })
  m.api.mockResolvedValue(
    expired
      ? { ok: false, status: 503, message: "Unavailable" }
      : { ok: true, data: {} }
  )
  m.sendAnswer.mockResolvedValue(true)
  await act(async () => {
    render(
      <TooltipProvider>
        <ExamRunner sessionId="s" examId="e" sebRequired={false} />
      </TooltipProvider>
    )
  })
}
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function typeAnswer(value: string) {
  fireEvent.change(screen.getByLabelText("answer"), {
    target: { value },
  })
}

function openConfirmDialog() {
  fireEvent.click(screen.getAllByRole("button", { name: "Abgeben" })[0])
}

function confirmSubmit() {
  fireEvent.click(screen.getByRole("button", { name: "Endgültig abgeben" }))
}

it("flushes an edited answer before submitting when storage is unavailable", async () => {
  await setup()
  const saved = deferred<boolean>()
  m.sendAnswer.mockReturnValue(saved.promise)
  typeAnswer("Important answer")
  openConfirmDialog()
  confirmSubmit()
  // The submit POST must wait for the save to land: a submit that wins the
  // race lets the server finalize a session whose latest answer is still
  // only in the browser buffer.
  expect(m.sendAnswer).toHaveBeenCalledWith(
    "q",
    { type: "FREE_TEXT", text: "Important answer" },
    expect.any(Number)
  )
  expect(m.api).not.toHaveBeenCalled()
  await act(async () => {
    saved.resolve(true)
  })
  expect(m.api.mock.calls.map(([url]) => url)).toEqual([
    "/api/sessions/s/submit",
  ])
  expect(m.sendAnswer.mock.invocationCallOrder[0]).toBeLessThan(
    m.api.mock.invocationCallOrder[0]
  )
  expect(m.push).toHaveBeenCalledWith("/exam/e/complete")
})

it("drains an answer typed during the flush before the submit POST", async () => {
  await setup()
  const first = deferred<boolean>()
  const second = deferred<boolean>()
  m.sendAnswer
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
  typeAnswer("first")
  openConfirmDialog()
  confirmSubmit()
  // The flush for "first" is still in flight; this edit lands during it.
  typeAnswer("second")
  expect(m.api).not.toHaveBeenCalled()
  await act(async () => {
    first.resolve(true)
  })
  await act(async () => {
    second.resolve(true)
  })
  // "second" was only in the buffer when the first drain round ran — it
  // must be caught by a follow-up round before the submit POST goes out.
  expect(m.sendAnswer).toHaveBeenCalledWith(
    "q",
    { type: "FREE_TEXT", text: "second" },
    expect.any(Number)
  )
  expect(m.sendAnswer.mock.invocationCallOrder[1]).toBeLessThan(
    m.api.mock.invocationCallOrder[0]
  )
  expect(m.push).toHaveBeenCalledWith("/exam/e/complete")
})

it("retains an answer that failed to flush when the auto submit succeeds", async () => {
  await setup(true)
  typeAnswer("Unsaved gem")
  m.sendAnswer.mockResolvedValue(false)
  m.api.mockImplementation((url: string) =>
    url.endsWith("/submit")
      ? Promise.resolve({ ok: true, data: {} })
      : Promise.resolve({ ok: false, status: 503, message: "Unavailable" })
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(11000)
  })
  // The auto submit went through although the flush failed ...
  expect(m.push).toHaveBeenCalledWith("/exam/e/complete")
  const before = m.sendAnswer.mock.calls.filter(
    (call) => (call[1] as { text?: string }).text === "Unsaved gem"
  ).length
  expect(before).toBeGreaterThan(0)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20000)
  })
  // ... and the answer is not destroyed with it: the retry loop keeps
  // offering it for delivery instead of it surviving nowhere at all.
  const after = m.sendAnswer.mock.calls.filter(
    (call) => (call[1] as { text?: string }).text === "Unsaved gem"
  ).length
  expect(after).toBeGreaterThan(before)
})

it("re-arms the auto-submit retry when it fires during an in-flight submit", async () => {
  await setup(true)
  const manual = deferred<unknown>()
  m.api.mockReturnValueOnce(manual.promise)
  openConfirmDialog()
  confirmSubmit()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(11000)
  })
  // The armed retry landed while the manual submit was in flight and was
  // swallowed by the submitting guard — it must re-arm, not die silently.
  expect(m.api).toHaveBeenCalledTimes(2)
  await act(async () => {
    manual.resolve({ ok: false, status: 503, message: "Unavailable" })
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(11000)
  })
  expect(m.api).toHaveBeenCalledTimes(3)
})

it("auto-submits after expiry once a concurrent submit settles, without stacking retries", async () => {
  await setup()
  const manual = deferred<unknown>()
  m.api
    .mockReturnValueOnce(manual.promise)
    .mockResolvedValue({ ok: false, status: 503, message: "Unavailable" })
  openConfirmDialog()
  confirmSubmit()
  // The deadline passes while the manual submit is still in flight.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3603000)
  })
  // The expiry auto-submit early-returned on `submitting` and re-armed
  // instead of claiming the run and never retrying.
  expect(m.api).toHaveBeenCalledTimes(1)
  await act(async () => {
    manual.resolve({ ok: false, status: 503, message: "Unavailable" })
  })
  // Once that submit settles, the still-unclaimed expiry starts a real
  // auto-submit attempt.
  expect(m.api).toHaveBeenCalledTimes(2)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8000)
  })
  // The re-armed retry replaced the earlier pending timer: a second,
  // stacked timer would have fired a duplicate submission here.
  expect(m.api).toHaveBeenCalledTimes(2)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000)
  })
  expect(m.api).toHaveBeenCalledTimes(3)
})

it("does not fire a scheduled retry after a successful submission", async () => {
  await setup(true)
  // The failed expiry submit has a retry armed; this submit succeeds.
  m.api.mockResolvedValue({ ok: true, data: {} })
  openConfirmDialog()
  // Counted after the dialog opens (Radix arms timers of its own there) so
  // the delta below brackets the submission only.
  const timersBefore = vi.getTimerCount()
  await act(async () => {
    confirmSubmit()
  })
  expect(m.api).toHaveBeenCalledTimes(2)
  expect(m.push).toHaveBeenCalledWith("/exam/e/complete")
  // The armed retry is cancelled with the submission — this is the only
  // direct handle on it: a fired retry would early-return on `submitting`
  // anyway (it stays set after a successful submit), so the api count below
  // alone cannot tell a cancelled timer from a swallowed one.
  expect(vi.getTimerCount()).toBe(timersBefore - 1)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(13000)
  })
  expect(m.api).toHaveBeenCalledTimes(2)
})

it("persists the pending buffer on unmount before tearing it down", async () => {
  const store = new Map<string, string>()
  await setup(false, {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
  typeAnswer("Typed late")
  cleanup()
  // The debounced write has not fired yet (800ms); unmount must flush the
  // record so the pending answer survives for crash-recovery replay.
  expect(JSON.parse(store.get("openexam:pending:s") ?? "null")).toEqual({
    q: { type: "FREE_TEXT", text: "Typed late" },
  })
})

it("retries automatic submission after ten seconds without user interaction", async () => {
  await setup(true)
  expect(m.api).toHaveBeenCalledTimes(1)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(11000)
  })
  expect(m.api).toHaveBeenCalledTimes(2)
})

it("stops automatic submission retries after five attempts", async () => {
  await setup(true)
  for (let attempt = 0; attempt < 7; attempt++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11000)
    })
  }
  expect(m.api).toHaveBeenCalledTimes(5)
})

it("cancels a scheduled submission retry on unmount", async () => {
  await setup(true)
  cleanup()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(11000)
  })
  expect(m.api).toHaveBeenCalledTimes(1)
})
