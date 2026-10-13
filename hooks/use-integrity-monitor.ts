"use client"

import { useEffect, useRef } from "react"
import type { IntegrityEventKind } from "@/generated/prisma/client"
import { createBlurWatch } from "@/lib/blur-watch"

// Re-exported so importers keep working unchanged; the single source of
// truth is the IntegrityEventKind DB enum (prisma/schema.prisma), pinned to
// the rest of the contract by testdata/integrity-event-vectors.json.
export type { IntegrityEventKind }

const REPORT_THROTTLE_MS = 2_000
const DEVTOOLS_POLL_MS = 1_000
const DEVTOOLS_SIZE_THRESHOLD = 160

/**
 * How long the window must stay unfocused before a blur counts as leaving it.
 * Long enough to outlast both the blur/visibilitychange race and a click on
 * SEB's own chrome — see lib/blur-watch.ts for what each of those looked like
 * in production.
 */
const BLUR_CONFIRM_MS = 1_500

/**
 * How long after a reload key (F5, Ctrl/Cmd+R) the next unload still counts
 * as that reload. Generous, because a slow network delays the unload.
 */
const RELOAD_INTENT_MS = 10_000

/**
 * Best-effort, client-side behavioral signals for exam integrity: tab
 * switches, window blur, clipboard/context-menu/devtools attempts. Ported
 * from the cheatdectection prototype (app/page.tsx) into a reusable hook.
 * These are heuristics, not proof — a student can defeat most of them
 * with enough effort — so this is defense-in-depth alongside SEB, not a
 * replacement for it, and every signal is only ever surfaced to the teacher
 * as a flag to look into, never used to auto-fail a session.
 *
 * Throttles reporting per kind client-side (in addition to the server's own
 * rate limit) so a flaky window doesn't spam the socket; the blocking
 * behavior (preventDefault) itself is never throttled.
 */
export function useIntegrityMonitor({
  enabled,
  onEvent,
}: {
  enabled: boolean
  onEvent: (kind: IntegrityEventKind, detail?: string) => void
}) {
  const onEventRef = useRef(onEvent)
  const lastReportedRef = useRef<Partial<Record<IntegrityEventKind, number>>>(
    {}
  )

  useEffect(() => {
    onEventRef.current = onEvent
  })

  useEffect(() => {
    if (!enabled) return

    function report(kind: IntegrityEventKind, detail?: string) {
      const now = Date.now()
      const last = lastReportedRef.current[kind]
      if (last !== undefined && now - last < REPORT_THROTTLE_MS) return
      lastReportedRef.current[kind] = now
      onEventRef.current(kind, detail)
    }

    // Clipboard use inside the student's own answer fields is legitimate
    // editing (moving a sentence around in a long free-text answer), so it
    // is neither blocked nor reported; only clipboard activity against the
    // exam content itself is.
    function isAnswerField(target: EventTarget | null) {
      if (!(target instanceof HTMLElement)) return false
      return (
        target.isContentEditable ||
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement
      )
    }

    const blurWatch = createBlurWatch({
      confirmMs: BLUR_CONFIRM_MS,
      isHidden: () => document.hidden,
      hasFocus: () => document.hasFocus(),
      onLeave: () => report("WINDOW_BLUR"),
    })

    // A reload (F5 in SEB) also hides the document on its way out, which is
    // not leaving the exam. Nothing in pagehide tells a reload apart from
    // closing the tab or navigating away, so the signal is the reload key
    // itself: SEB hides its reload button, leaving F5 as the only way to
    // reload there. Only right after such a key is TAB_HIDDEN deferred a
    // tick; the unload steps fire pagehide and visibilitychange back to back
    // in one task (order differs by browser), so a non-persisted pagehide
    // cancels it, and once the document is gone the timer never runs.
    // Everything else reports synchronously, because timers scheduled during
    // an unload never run before the page and its socket are gone.
    let reloadKeyAt: number | undefined
    let unloading = false
    let leaving = false
    let pendingHidden: ReturnType<typeof setTimeout> | undefined

    function reloadIntended() {
      return (
        reloadKeyAt !== undefined && Date.now() - reloadKeyAt < RELOAD_INTENT_MS
      )
    }

    function flushHidden() {
      if (pendingHidden === undefined) return
      clearTimeout(pendingHidden)
      pendingHidden = undefined
      report("TAB_HIDDEN")
    }

    function handleVisibilityChange() {
      if (!document.hidden) return
      // The blur that precedes a tab switch is the same action as this event,
      // not a second one — drop it rather than reporting both.
      blurWatch.onHidden()
      if (unloading) return
      if (leaving || !reloadIntended()) {
        report("TAB_HIDDEN")
        return
      }
      clearTimeout(pendingHidden)
      pendingHidden = setTimeout(() => {
        pendingHidden = undefined
        report("TAB_HIDDEN")
      }, 0)
    }

    function handlePageHide(e: PageTransitionEvent) {
      // Only the browser's own pagehide: a script-dispatched one (devtools in
      // a non-SEB exam) would otherwise switch reporting off for good.
      if (!e.isTrusted) return
      if (!e.persisted && reloadIntended()) {
        unloading = true
        clearTimeout(pendingHidden)
        pendingHidden = undefined
        blurWatch.dispose()
        return
      }
      // Closing the tab, navigating away, or entering the back/forward cache
      // (persisted, where timers are suspended until a restore): report now,
      // while the socket is still open.
      leaving = true
      flushHidden()
    }

    function handlePageShow(e: PageTransitionEvent) {
      if (!e.persisted) return
      // Restored from the back/forward cache: the earlier reload key and
      // departure belong to the previous visit.
      leaving = false
      unloading = false
      reloadKeyAt = undefined
    }

    function handleBlur() {
      blurWatch.onBlur()
    }

    function handleFocus() {
      blurWatch.onFocus()
    }

    function handleCopy(e: ClipboardEvent) {
      if (isAnswerField(e.target)) return
      e.preventDefault()
      report("COPY_BLOCKED")
    }

    function handlePaste(e: ClipboardEvent) {
      if (isAnswerField(e.target)) return
      e.preventDefault()
      report("PASTE_BLOCKED")
    }

    function handleCut(e: ClipboardEvent) {
      if (isAnswerField(e.target)) return
      e.preventDefault()
      report("COPY_BLOCKED", "cut")
    }

    function handleContextMenu(e: MouseEvent) {
      e.preventDefault()
      report("CONTEXT_MENU_BLOCKED")
    }

    function handleKeyDown(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey
      const inAnswer = isAnswerField(e.target)

      // Not blocked: answers survive a reload. Trusted only, for the same
      // reason as pagehide.
      if (
        e.isTrusted &&
        (e.key === "F5" || (mod && (e.key === "r" || e.key === "R")))
      ) {
        reloadKeyAt = Date.now()
      }

      if (mod && (e.key === "c" || e.key === "C") && !e.shiftKey) {
        if (inAnswer) return
        e.preventDefault()
        report("COPY_BLOCKED", "shortcut")
        return
      }
      if (mod && (e.key === "v" || e.key === "V")) {
        if (inAnswer) return
        e.preventDefault()
        report("PASTE_BLOCKED", "shortcut")
        return
      }
      if (mod && (e.key === "x" || e.key === "X")) {
        if (inAnswer) return
        e.preventDefault()
        report("COPY_BLOCKED", "cut-shortcut")
        return
      }
      if (e.key === "F12") {
        e.preventDefault()
        report("SHORTCUT_BLOCKED", "F12")
        return
      }
      if (mod && e.shiftKey && ["i", "I", "c", "C", "j", "J"].includes(e.key)) {
        e.preventDefault()
        report("SHORTCUT_BLOCKED", `devtools:${e.key.toLowerCase()}`)
        return
      }
      if (mod && (e.key === "u" || e.key === "U")) {
        e.preventDefault()
        report("SHORTCUT_BLOCKED", "view-source")
        return
      }
      // No Alt/Cmd+Tab branch: the OS intercepts app switching before the
      // page sees a keydown — the blur/visibilitychange handlers above are
      // what actually catch it.
    }

    document.addEventListener("visibilitychange", handleVisibilityChange)
    window.addEventListener("pagehide", handlePageHide)
    window.addEventListener("pageshow", handlePageShow)
    window.addEventListener("blur", handleBlur)
    window.addEventListener("focus", handleFocus)
    document.addEventListener("copy", handleCopy)
    document.addEventListener("paste", handlePaste)
    document.addEventListener("cut", handleCut)
    document.addEventListener("contextmenu", handleContextMenu)
    document.addEventListener("keydown", handleKeyDown)

    // Heuristic only (outer/inner size delta) — false positives happen on
    // e.g. mobile keyboards or unusual browser chrome, which is why this
    // only ever produces a "suspected" flag for a teacher to weigh, not a
    // hard block. Skipped inside SEB: the outer/inner delta is meaningless
    // in an embedded WKWebView (it would flag every SEB student on every
    // poll, drowning the real signals) and SEB blocks devtools natively
    // anyway.
    const inSeb = window.SafeExamBrowser !== undefined
    const devtoolsInterval = inSeb
      ? undefined
      : setInterval(() => {
          const widthDelta =
            window.outerWidth - window.innerWidth > DEVTOOLS_SIZE_THRESHOLD
          const heightDelta =
            window.outerHeight - window.innerHeight > DEVTOOLS_SIZE_THRESHOLD
          if (widthDelta || heightDelta) report("DEVTOOLS_SUSPECTED")
        }, DEVTOOLS_POLL_MS)

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      window.removeEventListener("pagehide", handlePageHide)
      window.removeEventListener("pageshow", handlePageShow)
      clearTimeout(pendingHidden)
      window.removeEventListener("blur", handleBlur)
      window.removeEventListener("focus", handleFocus)
      blurWatch.dispose()
      document.removeEventListener("copy", handleCopy)
      document.removeEventListener("paste", handlePaste)
      document.removeEventListener("cut", handleCut)
      document.removeEventListener("contextmenu", handleContextMenu)
      document.removeEventListener("keydown", handleKeyDown)
      clearInterval(devtoolsInterval)
    }
  }, [enabled])
}
