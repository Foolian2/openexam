"use client"

import { memo, useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Clock,
  CheckCircle2,
  AlertTriangle,
  Send,
  Lock,
  LayoutGrid,
  X,
  Bookmark,
} from "lucide-react"
import { useTheme } from "next-themes"
import { Spinner } from "@/components/ui/spinner"
import { IconCrossfade } from "@/components/ui/icon-crossfade"
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerTitle,
} from "@/components/ui/drawer"
import { useAccessibility } from "@/components/accessibility-provider"
import {
  ExamSettingsMenu,
  type ExamTextSize,
} from "@/components/exam-taking/exam-settings-menu"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { MatchingViewer } from "@/components/questions/viewer/matching-viewer"
import { OrderingViewer } from "@/components/questions/viewer/ordering-viewer"
import {
  QuestionNavigator,
  QuestionProgressBar,
  type NavigatorQuestionState,
} from "@/components/exam-taking/question-navigator"
import { useExamSocket } from "@/hooks/use-exam-socket"
import { useIntegrityMonitor } from "@/hooks/use-integrity-monitor"
import { ExamSystemStatus } from "@/components/exam-taking/exam-system-status"
import { useClock } from "@/hooks/use-clock"
import { getSebKey, sebFetch } from "@/lib/seb-client"
import { apiMutate } from "@/lib/api-mutate"
import {
  claimExamDevice,
  claimFailureMessage,
  onSessionReplaced,
} from "@/lib/exam-device-client"
import { ensureExclusiveExamTabId, getExamTabId } from "@/lib/exam-tab"
import { sessionGate } from "@/lib/session-state"
import {
  PRE_EXAM_THEME_HEARTBEAT_MS,
  readExamTextSize,
  refreshPreExamThemePin,
  writeExamTextSize,
  writePreExamThemePin,
} from "@/lib/pre-exam-theme"
import {
  createLocalAnswerBuffer,
  type AnswerBuffer,
  type AnswerContent,
} from "@/lib/answer-buffer"
import { createClientSeq } from "@/lib/answer-seq"
import { isAnswerEmpty } from "@/lib/answer-state"
import { readLocal, writeLocal } from "@/lib/safe-storage"
import { SUBMIT_KEY_PREFIX } from "@/lib/storage-keys"
import { prefersReducedMotion } from "@/lib/utils"
import type { StudentQuestionConfig } from "@/lib/types/questions"
import {
  BASE_VIEWERS,
  renderQuestionViewer,
  type ViewerRegistry,
} from "@/components/questions/viewer/viewer-registry"

type SessionQuestion = {
  id: string
  order: number
  title: string
  points: number
  required: boolean
} & StudentQuestionConfig

interface SessionState {
  session: { id: string; status: string; effectiveEndTime: string | null }
  exam: {
    id: string
    title: string
    description: string | null
    timeLimitMin: number
    status: string
  }
  questions: SessionQuestion[]
  answers: {
    questionId: string
    content: AnswerContent
    clientSeq: number | null
  }[]
  bookmarkedQuestionIds: string[]
  serverNow: string
}

type SaveState = "dirty" | "saving" | "saved" | "error"

const AUTOSAVE_DEBOUNCE_MS = 800
const AUTO_SUBMIT_RETRY_MS = 10_000
const MAX_AUTO_SUBMIT_ATTEMPTS = 5
const STATUS_POLL_MS = 15_000
const STATUS_POLL_MS_WS_OPEN = 60_000
const STATUS_REQUEST_TIMEOUT_MS = 10_000
// Each poll interval is drawn from ±25% of the nominal period. A whole class
// enters within the same few seconds, and a fixed period would keep them
// phase-locked for the entire exam: every tick, every retry and every
// reconnect would land as one burst on the same web replicas. Re-rolling the
// jitter per tick (rather than once, as a fixed per-client offset) also
// prevents a shared re-sync — a WS reconnect, a teacher extension — from
// stacking the cohort back up.
const STATUS_POLL_JITTER = 0.25

// Theme chosen inside the exam menu is session-only. The exam runner pins the
// pre-exam theme here (idempotent — the entry survives reloads and tab
// closes); components/session-theme-restore.tsx consumes it on the next
// page that isn't the exam, so the choice never leaks into the rest of the
// app. This intentionally lives in localStorage instead of React state so it
// survives StrictMode effect double-runs, hard reloads and tab death.

const TEXT_FONT_SIZES: Record<ExamTextSize, string> = {
  sm: "14px",
  md: "",
  lg: "18px",
}

export function ExamRunner({
  sessionId,
  examId,
  sebRequired,
}: {
  sessionId: string
  examId: string
  sebRequired: boolean
}) {
  const router = useRouter()
  const { theme: savedTheme } = useTheme()
  const [state, setState] = useState<SessionState | null>(null)
  const sessionLoaded = state !== null
  const [loadError, setLoadError] = useState("")
  const [answers, setAnswers] = useState<Record<string, AnswerContent>>({})
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({})
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [navOpen, setNavOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState("")
  const [sessionLocked, setSessionLocked] = useState(false)
  // Another login or tab took this session over (lib/exam-device.ts). The
  // server refuses this tab's saves from then on, so everything stops until
  // the student explicitly takes the session back.
  const [replaced, setReplaced] = useState(false)
  const [reclaiming, setReclaiming] = useState(false)
  const [textSize, setTextSize] = useState<ExamTextSize>(
    () => readExamTextSize() ?? "md"
  )
  // Gates everything else while we resolve a Config Key token via the SEB JS
  // API — required on macOS/iOS, where SEB's WKWebView can't send the
  // native header at all, so this is the only way to prove SEB there.
  const [sebReady, setSebReady] = useState(!sebRequired)
  const [sebUnavailable, setSebUnavailable] = useState(false)
  const [currentQuestionId, setCurrentQuestionId] = useState<string | null>(
    null
  )
  const [bookmarkedQuestionIds, setBookmarkedQuestionIds] = useState<
    Set<string>
  >(new Set())

  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const [clockOffset, setClockOffset] = useState(0)
  const autoSubmittedRef = useRef(false)
  const autoSubmitAttemptsRef = useRef(0)
  const timeWarnedRef = useRef<{ five: boolean; one: boolean }>({
    five: false,
    one: false,
  })
  const questionRefs = useRef<Record<string, HTMLDivElement | null>>({})
  // Per-question bookmark write queue: chains PUTs so a second toggle fired
  // before the first request lands doesn't race it to the database. Each
  // link reads the *latest* desired value when it runs (not the value it was
  // scheduled with), so rapid toggles coalesce into a single trailing write
  // instead of one request per click.
  const bookmarkChainRef = useRef<Record<string, Promise<void>>>({})
  const bookmarkDesiredRef = useRef<Record<string, boolean>>({})
  // Crash-safe answer buffer: in-memory record persisted to localStorage on a
  // debounced tick and beforeunload, instead of on every keystroke, so typing
  // doesn't JSON-parse/stringify the whole record.
  //
  // Stays null while rendering on the server, and in a browser that denies
  // storage — see createLocalAnswerBuffer. Every use below is inside an effect
  // or an event handler and already optional-chains, so a null buffer costs
  // only crash-recovery, never an answer: saving runs on the network path.
  const bufferRef = useRef<AnswerBuffer<AnswerContent> | null>(null)
  if (bufferRef.current === null)
    bufferRef.current = createLocalAnswerBuffer(sessionId, getExamTabId)
  // Orders this tab's saves against each other and against what the server
  // already holds; seeded from the loaded answers before any save goes out.
  const [saveSeq] = useState(() => createClientSeq())
  // Fallback home for the submit idempotency key when storage is denied.
  const submitKeyRef = useRef<string | null>(null)

  const registerQuestionRef = useCallback(
    (el: HTMLDivElement | null, questionId: string) => {
      questionRefs.current[questionId] = el
    },
    []
  )

  // Session-only theme: pin the pre-exam theme once. The actual restore runs
  // in components/session-theme-restore.tsx on the next non-exam page, so
  // nothing here depends on unmount timing (which React StrictMode in dev
  // would otherwise trigger spuriously via effect cleanup). The pin is
  // tab-owned and heartbeated while the exam runs, so a second tab can't
  // consume it out from under this one (lib/pre-exam-theme.ts).
  const savedThemeRef = useRef(savedTheme)
  useEffect(() => {
    writePreExamThemePin(savedThemeRef.current ?? "system")
    const heartbeat = setInterval(
      refreshPreExamThemePin,
      PRE_EXAM_THEME_HEARTBEAT_MS
    )
    return () => clearInterval(heartbeat)
  }, [])

  // Session-only text size: scale the root rem unit so all Tailwind sizing
  // (text, spacing, icons) scales uniformly. Reset when the runner unmounts.
  // The choice is persisted alongside the theme pin so it survives mid-exam
  // reloads; the restore component clears it once the exam is over.
  useEffect(() => {
    const root = document.documentElement
    const previous = root.style.fontSize
    root.style.fontSize = TEXT_FONT_SIZES[textSize]
    return () => {
      root.style.fontSize = previous
    }
  }, [textSize])

  useEffect(() => {
    writeExamTextSize(textSize)
  }, [textSize])

  // Re-arm the auto-submit with a delay instead of letting the next 1s
  // countdown tick fire immediately — a failing endpoint would otherwise be
  // hammered in a tight loop. Gives up after a few attempts; the server
  // force-submits on close and the grace window covers late retries.
  const scheduleAutoSubmitRetry = useCallback(() => {
    autoSubmitAttemptsRef.current += 1
    if (autoSubmitAttemptsRef.current >= MAX_AUTO_SUBMIT_ATTEMPTS) return
    setTimeout(() => {
      autoSubmittedRef.current = false
    }, AUTO_SUBMIT_RETRY_MS)
  }, [])

  function scrollToQuestion(questionId: string) {
    setConfirmOpen(false)
    questionRefs.current[questionId]?.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "center",
    })
  }

  // Track which question card sits in the upper viewport band so the
  // navigator can highlight it. Questions are static after load, so this
  // only runs when the session state arrives.
  useEffect(() => {
    if (!state) return
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting)
        if (visible.length === 0) return
        const topmost = visible.reduce((a, b) =>
          a.boundingClientRect.top <= b.boundingClientRect.top ? a : b
        )
        const id = (topmost.target as HTMLElement).dataset.questionId
        if (id) setCurrentQuestionId(id)
      },
      { rootMargin: "-20% 0px -60% 0px" }
    )
    for (const el of Object.values(questionRefs.current)) {
      if (el) observer.observe(el)
    }
    return () => observer.disconnect()
  }, [state])

  useEffect(() => {
    if (!sebRequired) return
    let cancelled = false
    void getSebKey().then((key) => {
      if (cancelled) return
      if (key) setSebReady(true)
      else setSebUnavailable(true)
    })
    return () => {
      cancelled = true
    }
  }, [sebRequired])

  const socket = useExamSocket({
    sessionId,
    enabled: sebReady && state !== null && !replaced,
    sebRequired,
    onControl: useCallback(
      (data: { action: string }) => {
        switch (data.action) {
          case "SESSION_LOCKED":
            setSessionLocked(true)
            break
          case "SESSION_UNLOCKED":
            setSessionLocked(false)
            break
          case "SESSION_REPLACED":
            setReplaced(true)
            break
          case "EXAM_CLOSED":
          case "SESSION_SUBMITTED":
            // Not inside a state updater: React 19 forbids side effects
            // (router.push) there. useExamSocket holds this callback in a
            // ref, so reading `state` directly is safe and re-creating the
            // callback does not reconnect the socket.
            if (state) router.push(`/exam/${state.exam.id}/complete`)
            break
          default:
            break
        }
      },
      [router, state]
    ),
    onTimerSync: useCallback(
      (data: { effectiveEndTime: string | null; serverNow: string }) => {
        setClockOffset(new Date(data.serverNow).getTime() - Date.now())
        setState((s) =>
          s
            ? {
                ...s,
                session: {
                  ...s.session,
                  effectiveEndTime: data.effectiveEndTime,
                },
              }
            : s
        )
      },
      []
    ),
    onSebAuthFailed: useCallback(() => setSebUnavailable(true), []),
  })

  // Destructured so saveAnswer can depend on the stable sendAnswer callback
  // instead of the hook's return object — depending on the latter caused an
  // infinite refetch loop via the load effect's saveAnswer dependency.
  const { sendAnswer, sendIntegrityEvent } = socket

  // Browser-behavioral integrity signals (tab switch, window blur,
  // clipboard/devtools attempts) — defense-in-depth alongside SEB, and the
  // only such signal at all for exams that don't require SEB.
  useIntegrityMonitor({
    enabled: sebReady && state !== null,
    onEvent: sendIntegrityEvent,
  })

  const saveAnswer = useCallback(
    async (questionId: string, content: AnswerContent): Promise<boolean> => {
      // Taken before the first await: saves for one question must get their
      // seq in the order they were started, and both transports below carry
      // the same seq so a retry of this save can't outrank a newer edit.
      const clientSeq = saveSeq.next()
      setSaveStates((s) => ({ ...s, [questionId]: "saving" }))

      if (await sendAnswer(questionId, content, clientSeq)) {
        setSaveStates((s) => ({ ...s, [questionId]: "saved" }))
        // discardIfMatch protects against a newer edit that landed while this
        // save was in flight — only clears the entry if it still matches.
        bufferRef.current?.discardIfMatch(questionId, content)
        return true
      }

      const result = await apiMutate(`/api/sessions/${sessionId}/answers`, {
        method: "PUT",
        body: { questionId, content, clientSeq },
        fetcher: sebFetch,
        // Never surfaced: this path reports through saveStates, not a toast.
        fallbackError: "save failed",
      })
      if (!result.ok) {
        // Kept in localStorage; the retry loop picks it up again, or the
        // reload after taking the session back replays it.
        if (result.code === "SESSION_REPLACED") setReplaced(true)
        setSaveStates((s) => ({ ...s, [questionId]: "error" }))
        return false
      }
      setSaveStates((s) => ({ ...s, [questionId]: "saved" }))
      bufferRef.current?.discardIfMatch(questionId, content)
      return true
    },
    [sessionId, sendAnswer, saveSeq]
  )

  // Initial load + replay of answers buffered before a crash/reload. Waits
  // on sebReady so this doesn't fire before a required Config Key token is
  // resolved (the request would otherwise 403 against the guard).
  useEffect(() => {
    if (!sebReady) return
    let cancelled = false
    async function load() {
      try {
        // Claim the session for this login before anything else, so the
        // load below and the socket opened after it are not refused as a
        // replaced login. Loading must stop on a failed claim: an unclaimed
        // legacy row would otherwise admit concurrent clients.
        // A duplicated tab starts with its original's identity; it must
        // claim under its own, or the two would share one claim.
        await ensureExclusiveExamTabId()
        const claim = await claimExamDevice(sessionId)
        if (!claim.ok) {
          if (!cancelled) setLoadError(claimFailureMessage(claim))
          return
        }
        if (cancelled) return
        // This tab owns the session again; its record may be replayed by
        // other tabs of this session once it is gone.
        bufferRef.current?.clearReplaced()
        const res = await sebFetch(`/api/sessions/${sessionId}`)
        const data = await res.json()
        if (!res.ok) {
          if (data.error?.code === "SESSION_REPLACED") {
            setReplaced(true)
            return
          }
          if (data.error?.code === "NOT_STARTED") {
            // Shared start not reached yet (the take page let us through a
            // moment early): wait for it in the waiting room.
            router.replace(`/exam/${examId}/wait`)
            return
          }
          setLoadError(
            data.error?.message ?? "Sitzung konnte nicht geladen werden"
          )
          return
        }
        if (cancelled) return
        const s: SessionState = data
        setClockOffset(new Date(s.serverNow).getTime() - Date.now())
        const restored: Record<string, AnswerContent> = {}
        for (const a of s.answers) {
          restored[a.questionId] = a.content
          saveSeq.observe(a.clientSeq)
        }
        bufferRef.current?.replay((pending) => {
          // Pending answers buffered before a crash/reload win over the
          // server's copy — the buffer's copy is the newer local state.
          for (const [qId, content] of pending) restored[qId] = content
        })
        setAnswers(restored)
        setBookmarkedQuestionIds(new Set(s.bookmarkedQuestionIds))
        setState(s)
        for (const [qId, content] of bufferRef.current?.entries() ?? [])
          void saveAnswer(qId, content)
        // Check lock/submission status immediately instead of leaving a window
        // (up to STATUS_POLL_MS) after a reload where a locked or already-closed
        // session still renders as editable until the first poll tick fires.
        switch (sessionGate(s.session.status, s.exam.status)) {
          case "LOCKED":
            setSessionLocked(true)
            break
          case "COMPLETE":
            router.push(`/exam/${s.exam.id}/complete`)
            break
          case "OPEN":
            setSessionLocked(false)
            break
        }
      } catch {
        setLoadError("Netzwerkfehler. Bitte Seite neu laden.")
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [sessionId, examId, saveAnswer, saveSeq, router, sebReady])

  // A replaced tab's record must not be replayed by the tab that owns the
  // session now: edits made here after the takeover would overwrite newer
  // answers. It stays this tab's own for a reclaim.
  useEffect(() => {
    if (replaced) bufferRef.current?.markReplaced()
  }, [replaced])

  useEffect(
    () => onSessionReplaced(sessionId, () => setReplaced(true)),
    [sessionId]
  )

  // Retry loop for failed saves. Paused once replaced: every retry would be
  // refused, and the buffered answers replay after taking the session back.
  useEffect(() => {
    if (!sebReady || !sessionLoaded || replaced) return
    const stop = bufferRef.current?.startRetryLoop(saveAnswer)
    return () => stop?.()
  }, [sessionId, saveAnswer, sebReady, sessionLoaded, replaced])

  // Poll session/exam status so a teacher lock or exam close is reflected live.
  useEffect(() => {
    if (!sebReady || !sessionLoaded || replaced) return
    let cancelled = false
    let activeRequest: AbortController | null = null
    let requestTimeout: ReturnType<typeof setTimeout> | undefined
    async function checkStatus() {
      const controller = new AbortController()
      activeRequest = controller
      try {
        // Bound the entire read, including its body. The next poll waits for
        // this one to settle, so a half-open connection must not stop status
        // updates for the rest of the exam. Abort also releases the request.
        const data = await Promise.race([
          (async (): Promise<SessionState | "REPLACED" | null> => {
            const res = await sebFetch(`/api/sessions/${sessionId}`, {
              signal: controller.signal,
            })
            if (res.ok) return res.json()
            // The poll never claims: that would let this tab silently take
            // the session back from the login that replaced it.
            if (res.status === 409) {
              const body = await res.json().catch(() => null)
              if (body?.error?.code === "SESSION_REPLACED") return "REPLACED"
            }
            return null
          })(),
          new Promise<never>((_, reject) => {
            requestTimeout = setTimeout(() => {
              controller.abort()
              reject(new Error("Session status request timed out"))
            }, STATUS_REQUEST_TIMEOUT_MS)
          }),
        ])
        if (!data || cancelled) return
        if (data === "REPLACED") {
          setReplaced(true)
          return
        }
        const gate = sessionGate(data.session.status, data.exam.status)
        if (gate === "LOCKED") {
          setSessionLocked(true)
          return
        }
        // Cleared before the COMPLETE check so a session submitted while
        // locked dismisses the dialog on its way to the complete page.
        setSessionLocked(false)
        if (gate === "COMPLETE") {
          router.push(`/exam/${data.exam.id}/complete`)
          return
        }
        // Reconcile the deadline from this authoritative REST read. The WS
        // timer-sync push (onTimerSync above) is the fast path for a teacher
        // extension, but it's best-effort — if the socket is down or the
        // server's publish failed, this poll is what stops the countdown
        // from auto-submitting against a stale deadline.
        const newEndTime = data.session.effectiveEndTime
        setState((s) =>
          s && s.session.effectiveEndTime !== newEndTime
            ? { ...s, session: { ...s.session, effectiveEndTime: newEndTime } }
            : s
        )
      } catch {
        // Transient network failure — next poll retries.
      } finally {
        clearTimeout(requestTimeout)
        activeRequest = null
      }
    }
    const base = socket.connected ? STATUS_POLL_MS_WS_OPEN : STATUS_POLL_MS
    let timer: ReturnType<typeof setTimeout> | null = null
    // Self-rescheduling rather than setInterval: the next poll is measured
    // from the end of the previous one, so a slow server stretches the period
    // instead of queueing overlapping requests behind it.
    const schedule = () => {
      const spread = base * STATUS_POLL_JITTER
      timer = setTimeout(
        async () => {
          await checkStatus()
          if (!cancelled) schedule()
        },
        base - spread + Math.random() * 2 * spread
      )
    }
    schedule()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      clearTimeout(requestTimeout)
      activeRequest?.abort()
    }
  }, [sessionId, router, socket.connected, sebReady, sessionLoaded, replaced])

  const handleSubmit = useCallback(
    async (auto: boolean) => {
      if (submitting) return
      setSubmitting(true)
      setSubmitError("")
      // Flush anything still buffered before submitting.
      const flushResults = await (bufferRef.current?.flush(saveAnswer) ??
        Promise.resolve([]))
      // A manual submit must not silently drop answers that only exist in
      // localStorage. Auto-submit proceeds anyway — the deadline has passed
      // and a partial submission beats losing the whole session.
      if (!auto && flushResults.some(([, saved]) => !saved)) {
        setSubmitError(
          "Einige Antworten konnten nicht gespeichert werden. Bitte erneut versuchen."
        )
        setSubmitting(false)
        return
      }

      // Idempotency key for the submit, so a retry after a network failure
      // cannot create a second submission. Persisted so it survives a
      // reload mid-submit; when storage is unavailable it falls back to a
      // per-mount ref, which still de-duplicates the retries that actually
      // happen inside one page lifetime. Never let storage decide whether a
      // student can submit at all.
      let key =
        readLocal(`${SUBMIT_KEY_PREFIX}:${sessionId}`) ??
        submitKeyRef.current ??
        null
      if (!key) {
        key = crypto.randomUUID()
        writeLocal(`${SUBMIT_KEY_PREFIX}:${sessionId}`, key)
      }
      submitKeyRef.current = key
      const result = await apiMutate(`/api/sessions/${sessionId}/submit`, {
        // "timeout" lets the server label a 0:00 submit as AUTO_TIME even if
        // it lands a moment before the server's deadline (submitKind).
        body: auto
          ? { idempotencyKey: key, reason: "timeout" }
          : { idempotencyKey: key },
        fetcher: sebFetch,
        fallbackError: "Abgabe fehlgeschlagen",
        networkError: "Netzwerkfehler bei der Abgabe. Bitte erneut versuchen.",
      })
      // A CONFLICT envelope means this session was already submitted — the
      // idempotency key did its job, so this is the success path. Requiring
      // the envelope prevents an HTML or unreadable 409 from a proxy from
      // clearing answers as though our API had confirmed the submission.
      const alreadySubmitted =
        !result.ok && result.status === 409 && result.code === "CONFLICT"
      if (!result.ok && result.code === "SESSION_REPLACED") {
        setReplaced(true)
        setSubmitting(false)
        return
      }
      if (!result.ok && !alreadySubmitted) {
        setSubmitError(result.message)
        setSubmitting(false)
        if (auto) scheduleAutoSubmitRetry()
        return
      }
      bufferRef.current?.clearAll()
      if (state) router.push(`/exam/${state.exam.id}/complete`)
    },
    [sessionId, state, submitting, router, saveAnswer, scheduleAutoSubmitRetry]
  )

  // Countdown lives inside <TimerBadge> (a leaf with its own 1s interval), so
  // the per-second tick never re-renders the question list. Warnings and the
  // auto-submit fire through stable callbacks; while the badge sits at 0 it
  // keeps calling onExpired each tick, so a re-armed auto-submit retry
  // (autoSubmittedRef reset) still gets another attempt.
  const onFiveMinLeft = useCallback(() => {
    if (timeWarnedRef.current.five) return
    timeWarnedRef.current.five = true
    toast.warning("Noch 5 Minuten verbleibend")
  }, [])

  const onOneMinLeft = useCallback(() => {
    if (timeWarnedRef.current.one) return
    timeWarnedRef.current.one = true
    toast.warning("Nur noch 1 Minute verbleibend!")
  }, [])

  const onExpired = useCallback(() => {
    if (autoSubmittedRef.current) return
    autoSubmittedRef.current = true
    void handleSubmit(true)
  }, [handleSubmit])

  // Flush the in-memory buffer to localStorage if the tab dies before the
  // next debounced write — same crash-safety as the old per-keystroke write,
  // at ~zero cost.
  useEffect(() => {
    const onUnload = () => bufferRef.current?.persistNow()
    window.addEventListener("beforeunload", onUnload)
    return () => window.removeEventListener("beforeunload", onUnload)
  }, [sessionId])

  const handleChange = useCallback(
    (questionId: string, content: AnswerContent) => {
      setAnswers((a) => ({ ...a, [questionId]: content }))
      setSaveStates((s) => ({ ...s, [questionId]: "dirty" }))
      bufferRef.current?.enqueue(questionId, content)
      clearTimeout(timersRef.current[questionId])
      timersRef.current[questionId] = setTimeout(() => {
        void saveAnswer(questionId, content)
      }, AUTOSAVE_DEBOUNCE_MS)
    },
    [saveAnswer]
  )

  const setBookmark = useCallback(
    (questionId: string, bookmarked: boolean) => {
      setBookmarkedQuestionIds((current) => {
        const next = new Set(current)
        if (bookmarked) next.add(questionId)
        else next.delete(questionId)
        return next
      })

      // Record the latest intent, then chain onto any write already in
      // flight for this question. The chained step re-reads this ref when it
      // actually runs, so a toggle that arrives while a request is pending
      // gets folded into the next write rather than racing it.
      bookmarkDesiredRef.current[questionId] = bookmarked
      const previous = bookmarkChainRef.current[questionId] ?? Promise.resolve()
      bookmarkChainRef.current[questionId] = previous.then(async () => {
        const desired = bookmarkDesiredRef.current[questionId]
        if (desired === undefined) return
        delete bookmarkDesiredRef.current[questionId]
        const result = await apiMutate(`/api/sessions/${sessionId}/bookmarks`, {
          method: "PUT",
          body: { questionId, bookmarked: desired },
          fetcher: sebFetch,
          fallbackError: "Markierung konnte nicht gespeichert werden",
        })
        if (!result.ok) {
          if (result.code === "SESSION_REPLACED") setReplaced(true)
          setBookmarkedQuestionIds((current) => {
            const next = new Set(current)
            if (desired) next.delete(questionId)
            else next.add(questionId)
            return next
          })
          toast.error(result.message)
        }
      })
    },
    [sessionId]
  )

  if (sebUnavailable) {
    return (
      <div className="flex min-h-svh items-center justify-center p-6">
        <div className="flex max-w-md flex-col items-center gap-4 text-center">
          <div className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            Diese Prüfung erfordert den Safe Exam Browser.
          </div>
          <p className="text-sm text-muted-foreground">
            Der Safe Exam Browser konnte nicht erkannt werden. Bitte öffnen Sie
            die Prüfung über die SEB-Konfigurationsdatei, die Sie von Ihrer
            Lehrperson erhalten haben.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button asChild>
              <Link href={`/exam/${examId}/launch-seb`}>SEB starten</Link>
            </Button>
            <Button asChild variant="ghost">
              <Link href="/dashboard/student">Zum Dashboard</Link>
            </Button>
          </div>
        </div>
      </div>
    )
  }

  if (replaced) {
    return (
      <ReplacedScreen
        reclaiming={reclaiming}
        onReclaim={async () => {
          setReclaiming(true)
          // Taking the session back is the same claim the other
          // login made; the reload replays this tab's unsaved answers.
          const claim = await claimExamDevice(sessionId)
          if (claim.ok) {
            window.location.reload()
            return
          }
          setReclaiming(false)
          toast.error(claimFailureMessage(claim))
        }}
      />
    )
  }

  if (loadError) {
    return (
      <div className="flex min-h-svh items-center justify-center p-6">
        <div className="flex max-w-md flex-col items-center gap-4 text-center">
          <div className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            {loadError}
          </div>
          <p className="text-sm text-muted-foreground">
            Ihre bisherigen Antworten bleiben gespeichert.
          </p>
          <Button onClick={() => window.location.reload()}>Neu laden</Button>
        </div>
      </div>
    )
  }
  if (!state) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    )
  }

  // A question counts as answered only when it has a non-empty answer —
  // cleared text or fully unchecked selections must not mark it done.
  const isAnswered = (q: SessionQuestion) => {
    const content = answers[q.id]
    return content !== undefined && !isAnswerEmpty(q.type, content)
  }
  const answeredCount = state.questions.filter(isAnswered).length
  const hasUnsaved = Object.values(saveStates).some(
    (s) => s === "dirty" || s === "saving" || s === "error"
  )
  const unansweredRequired = state.questions.filter(
    (q) => q.required && !isAnswered(q)
  )
  const navItems = state.questions.map((q) => {
    let navState: NavigatorQuestionState
    if (saveStates[q.id] === "error") navState = "error"
    else if (isAnswered(q)) navState = "answered"
    else if (q.required) navState = "required-open"
    else navState = "open"
    return {
      id: q.id,
      state: navState,
      bookmarked: bookmarkedQuestionIds.has(q.id),
    }
  })

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6 pb-28 md:pb-24">
      <header className="sticky top-0 z-10 -mx-6 flex flex-col gap-2 border-b bg-background/95 px-6 py-3 backdrop-blur">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold">
              {state.exam.title}
            </h1>
            <p className="text-xs text-muted-foreground">
              {answeredCount} von {state.questions.length} Fragen beantwortet
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {/* Replaces what SEB's hidden task bar used to provide; renders
                nothing outside SEB, where the OS still has its own. */}
            <ExamSystemStatus
              clockOffsetMs={clockOffset}
              connected={socket.connected}
            />
            {state.session.effectiveEndTime && (
              <TimerControl
                endTimeMs={new Date(state.session.effectiveEndTime).getTime()}
                clockOffsetMs={clockOffset}
                onFiveMinLeft={onFiveMinLeft}
                onOneMinLeft={onOneMinLeft}
                onExpired={onExpired}
              />
            )}
            <ExamSettingsMenu
              textSize={textSize}
              onTextSizeChange={setTextSize}
            />
            <Button
              className="hidden md:inline-flex"
              onClick={() => setConfirmOpen(true)}
              disabled={submitting}
            >
              <Send className="h-4 w-4" />
              Abgeben
            </Button>
          </div>
        </div>
        <QuestionProgressBar
          answeredCount={answeredCount}
          total={state.questions.length}
        />
        <div className="hidden md:block xl:hidden">
          <QuestionNavigator
            variant="dots"
            items={navItems}
            currentId={currentQuestionId}
            onNavigate={scrollToQuestion}
            answeredCount={answeredCount}
          />
        </div>
      </header>

      <div
        className="fixed top-24 z-10 hidden w-40 xl:block"
        style={{ left: "calc(50% + 24rem + 1.5rem)" }}
      >
        <QuestionNavigator
          variant="rail"
          items={navItems}
          currentId={currentQuestionId}
          onNavigate={scrollToQuestion}
          answeredCount={answeredCount}
        />
      </div>

      {state.exam.description && (
        <p className="text-sm text-muted-foreground">
          {state.exam.description}
        </p>
      )}

      {state.questions.map((q, index) => (
        <QuestionCard
          key={q.id}
          sessionId={sessionId}
          question={q}
          index={index}
          answer={answers[q.id]}
          saveState={saveStates[q.id]}
          bookmarked={bookmarkedQuestionIds.has(q.id)}
          onBookmark={setBookmark}
          onChange={handleChange}
          registerRef={registerQuestionRef}
        />
      ))}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Prüfung abgeben?</DialogTitle>
            <DialogDescription>
              Du hast {answeredCount} von {state.questions.length} Fragen
              beantwortet.
              {hasUnsaved &&
                " Nicht gespeicherte Änderungen werden vor der Abgabe gesichert."}{" "}
              Nach der Abgabe sind keine Änderungen mehr möglich.
            </DialogDescription>
          </DialogHeader>
          {unansweredRequired.length > 0 && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
              <p className="mb-2 flex items-center gap-1.5 text-sm font-medium text-destructive">
                <AlertTriangle className="h-4 w-4" />
                {unansweredRequired.length} Pflichtfrage(n) unbeantwortet
              </p>
              <ul className="space-y-1">
                {unansweredRequired.map((q) => {
                  const index = state.questions.findIndex(
                    (sq) => sq.id === q.id
                  )
                  return (
                    <li key={q.id}>
                      <button
                        type="button"
                        onClick={() => scrollToQuestion(q.id)}
                        className="text-sm text-destructive underline underline-offset-2 hover:text-destructive/80"
                      >
                        Frage {index + 1}: {q.title || "(Ohne Titel)"}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
          {submitError && (
            <p className="text-sm text-destructive">{submitError}</p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              disabled={submitting}
            >
              Zurück zur Prüfung
            </Button>
            <Button onClick={() => handleSubmit(false)} disabled={submitting}>
              {submitting && <Spinner data-icon="inline-start" />}
              Endgültig abgeben
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={sessionLocked}>
        <DialogContent
          showCloseButton={false}
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock className="h-4 w-4" />
              Von der Lehrperson gesperrt
            </DialogTitle>
            <DialogDescription>
              Deine Sitzung wurde von der Lehrperson gesperrt. Speichern ist
              vorübergehend nicht möglich. Bitte warte, bis sie wieder
              freigegeben wird.
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>

      <div className="fixed inset-x-0 bottom-0 z-10 border-t bg-background/95 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur md:hidden">
        <div className="mx-auto flex max-w-3xl items-center gap-2">
          <Button
            variant="outline"
            onClick={() => setNavOpen(true)}
            aria-haspopup="dialog"
          >
            <LayoutGrid />
            Fragen
          </Button>
          <Button
            className="flex-1"
            onClick={() => setConfirmOpen(true)}
            disabled={submitting}
          >
            <Send className="h-4 w-4" />
            Abgeben
          </Button>
        </div>
      </div>

      <Drawer open={navOpen} onOpenChange={setNavOpen} dismissible={false}>
        <DrawerContent>
          <DrawerTitle className="sr-only">Fragenübersicht</DrawerTitle>
          {/* Escape and outside-tap are disabled mid-exam, so the overlay
              needs an explicit, keyboard-reachable way out. */}
          <DrawerClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Fragenübersicht schließen"
              className="absolute top-3 right-3 z-10"
            >
              <X />
            </Button>
          </DrawerClose>
          <div className="px-4 pb-6">
            <QuestionNavigator
              variant="dots"
              items={navItems}
              currentId={currentQuestionId}
              onNavigate={(id) => {
                scrollToQuestion(id)
                setNavOpen(false)
              }}
              answeredCount={answeredCount}
            />
          </div>
        </DrawerContent>
      </Drawer>
    </div>
  )
}

function TimerBadge({
  endTimeMs,
  clockOffsetMs,
  visible = true,
  onFiveMinLeft,
  onOneMinLeft,
  onExpired,
}: {
  endTimeMs: number
  clockOffsetMs: number
  visible?: boolean
  onFiveMinLeft: () => void
  onOneMinLeft: () => void
  onExpired: () => void
}) {
  const nowMs = useClock() + clockOffsetMs
  const warnedFive = useRef(false)
  const warnedOne = useRef(false)

  const remaining = Math.max(0, Math.floor((endTimeMs - nowMs) / 1000))

  useEffect(() => {
    if (remaining <= 60) {
      if (remaining > 0 && !warnedOne.current) {
        warnedOne.current = true
        onOneMinLeft()
      } else if (remaining === 0) {
        onExpired()
      }
    } else if (remaining <= 300 && !warnedFive.current) {
      warnedFive.current = true
      onFiveMinLeft()
    }
  }, [remaining, onFiveMinLeft, onOneMinLeft, onExpired])

  if (!visible) return null

  const h = Math.floor(remaining / 3600)
  const m = Math.floor((remaining % 3600) / 60)
  const s = remaining % 60
  const critical = remaining <= 300
  return (
    <Badge
      variant={critical ? "destructive" : "secondary"}
      className="gap-1 font-mono text-sm tabular-nums"
    >
      <Clock className="h-3.5 w-3.5" />
      {h > 0 && `${h}:`}
      {String(m).padStart(2, "0")}:{String(s).padStart(2, "0")}
    </Badge>
  )
}

function TimerControl({
  endTimeMs,
  clockOffsetMs,
  onFiveMinLeft,
  onOneMinLeft,
  onExpired,
}: {
  endTimeMs: number
  clockOffsetMs: number
  onFiveMinLeft: () => void
  onOneMinLeft: () => void
  onExpired: () => void
}) {
  const { prefs } = useAccessibility()
  const [peek, setPeek] = useState(false)
  const hideable = prefs.hideExamTimer
  const visible = !hideable || peek
  const badge = (
    <TimerBadge
      endTimeMs={endTimeMs}
      clockOffsetMs={clockOffsetMs}
      visible={visible}
      onFiveMinLeft={onFiveMinLeft}
      onOneMinLeft={onOneMinLeft}
      onExpired={onExpired}
    />
  )
  if (!hideable) return badge
  // The badge stays mounted while hidden so the warning/auto-submit callbacks
  // keep firing; only its visual output is suppressed.
  return (
    <div className="flex items-center gap-2">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setPeek((value) => !value)}
        aria-pressed={peek}
        aria-label={peek ? "Countdown ausblenden" : "Countdown anzeigen"}
        className="text-muted-foreground"
      >
        <Clock className="h-4 w-4" />
      </Button>
      {badge}
    </div>
  )
}

const QuestionCard = memo(function QuestionCard({
  sessionId,
  question,
  index,
  answer,
  saveState,
  bookmarked,
  onBookmark,
  onChange,
  registerRef,
}: {
  sessionId: string
  question: SessionQuestion
  index: number
  answer?: AnswerContent
  saveState?: SaveState
  bookmarked: boolean
  onBookmark: (questionId: string, bookmarked: boolean) => void
  onChange: (questionId: string, content: AnswerContent) => void
  registerRef: (el: HTMLDivElement | null, questionId: string) => void
}) {
  return (
    <Card
      data-question-id={question.id}
      ref={(el) => registerRef(el, question.id)}
    >
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <CardTitle className="text-base leading-relaxed font-medium">
          <span className="mr-2 text-muted-foreground">{index + 1}.</span>
          {question.title}
          {question.required && (
            <span className="ml-1 text-destructive">*</span>
          )}
        </CardTitle>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-pressed={bookmarked}
            aria-label={bookmarked ? "Markierung entfernen" : "Frage markieren"}
            onClick={() => void onBookmark(question.id, !bookmarked)}
          >
            <Bookmark
              className={bookmarked ? "fill-warning text-warning" : ""}
            />
          </Button>
          <SaveIndicator saveState={saveState} />
          <Badge variant="outline">{question.points} P.</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <QuestionInput
          sessionId={sessionId}
          question={question}
          answer={answer}
          onChange={(content) => onChange(question.id, content)}
        />
      </CardContent>
    </Card>
  )
})

function SaveIndicator({ saveState }: { saveState?: SaveState }) {
  // "dirty" and "saving" share one spinner, so collapse them into a single
  // phase — otherwise the fade would replay when dirty flips to saving.
  const phase =
    saveState === "saving" || saveState === "dirty"
      ? "pending"
      : (saveState ?? "none")

  // The box holds its size in every phase, "none" included, so the points
  // badge beside it stops jumping sideways each time a save starts or ends.
  return (
    <IconCrossfade active={phase}>
      {phase === "pending" && (
        <Spinner className="size-4 text-muted-foreground" />
      )}
      {phase === "saved" && <CheckCircle2 className="h-4 w-4 text-green-600" />}
      {phase === "error" && (
        <Tooltip>
          <TooltipTrigger asChild>
            <AlertTriangle className="h-4 w-4 text-amber-500" tabIndex={0} />
          </TooltipTrigger>
          <TooltipContent>
            Speichern fehlgeschlagen. Wird automatisch erneut versucht…
          </TooltipContent>
        </Tooltip>
      )}
    </IconCrossfade>
  )
}

// Eager, unlike the lazy registry behind QuestionViewer: a student must
// never wait on (or lose, offline) a chunk fetch for the drag & drop viewers
// in the middle of an exam.
const EXAM_VIEWERS: ViewerRegistry = {
  ...BASE_VIEWERS,
  MATCHING: MatchingViewer,
  ORDERING: OrderingViewer,
}

function QuestionInput({
  sessionId,
  question,
  answer,
  onChange,
}: {
  sessionId: string
  question: SessionQuestion
  answer?: AnswerContent
  onChange: (content: AnswerContent) => void
}) {
  return renderQuestionViewer(EXAM_VIEWERS, {
    question,
    answer,
    onChange,
    sessionId,
    idPrefix: `tf-${question.id}-`,
  })
}

/**
 * Shown once another tab or login took the session over. Announced as an
 * alert, with focus moved to the reclaim button: the editor that held focus
 * is gone.
 */
function ReplacedScreen({
  reclaiming,
  onReclaim,
}: {
  reclaiming: boolean
  onReclaim: () => void
}) {
  const reclaimRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    reclaimRef.current?.focus()
  }, [])
  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <div
        role="alert"
        className="flex max-w-md flex-col items-center gap-4 text-center"
      >
        <h1 className="flex items-center gap-2 text-base font-normal text-destructive">
          <AlertTriangle className="h-5 w-5" aria-hidden="true" />
          Diese Prüfung wurde auf einem anderen Gerät oder in einem anderen
          Fenster geöffnet.
        </h1>
        <p className="text-sm text-muted-foreground">
          Hier können keine Antworten mehr gespeichert werden. Die Lehrperson
          wurde informiert. Wenn Sie selbst das Gerät gewechselt haben, arbeiten
          Sie dort weiter. Wenn Sie hier weiterarbeiten, werden Eingaben aus
          diesem Fenster, die noch nicht gespeichert waren, übernommen.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button ref={reclaimRef} disabled={reclaiming} onClick={onReclaim}>
            {reclaiming && <Spinner data-icon="inline-start" />}
            Hier weiterarbeiten
          </Button>
          <Button asChild variant="ghost">
            <Link href="/dashboard/student">Zum Dashboard</Link>
          </Button>
        </div>
      </div>
    </div>
  )
}
