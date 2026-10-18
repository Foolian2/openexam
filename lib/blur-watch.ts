/**
 * Confirms sustained focus loss while the exam stays visible, rather than
 * reacting to the raw `blur` event. The caller classifies the signal.
 *
 * Two false positives made the raw event unusable as a signal, both observed in
 * production on 2026-08-20:
 *
 *  - `blur` fires BEFORE `document.hidden` flips, so a plain tab switch or
 *    minimise produced a WINDOW_BLUR *and* a TAB_HIDDEN for one action. The gap
 *    measured 3ms in one session and 1.6s in another, which is why testing
 *    `document.hidden` at blur time could not tell the two apart.
 *  - Inside SEB, focus moves to SEB's own chrome — the task bar, the reload
 *    button, its dialogs — whenever the student touches it, while the document
 *    stays perfectly visible.
 *
 * Waiting `confirmMs` and re-checking filters brief transfers: a tab switch has set
 * `hidden` by then and is reported once, as TAB_HIDDEN; a glance at SEB's task
 * bar has given focus back. Switching to another application keeps focus away
 * and still reports. Native controls can also retain focus indefinitely; on
 * macOS SEB the caller therefore treats this as informational PAGE_FOCUS_LOST.
 *
 * Kept free of the DOM so the rule itself is testable without one; the caller
 * (hooks/use-integrity-monitor.ts) supplies the event wiring.
 */
export interface BlurWatchOptions {
  /** How long focus must stay away before it is reported. */
  confirmMs: number
  /** Reads `document.hidden` at the moment the timer fires, not at blur time. */
  isHidden: () => boolean
  /** Reads `document.hasFocus()` at the moment the timer fires. */
  hasFocus: () => boolean
  /** Invoked at most once per confirmed focus loss. */
  onLeave: () => void
}

export interface BlurWatch {
  /** The window lost focus. Starts (or restarts) the confirmation window. */
  onBlur(): void
  /** The window got focus back. Cancels a pending confirmation. */
  onFocus(): void
  /**
   * The document became hidden. Cancels a pending confirmation: the blur that
   * preceded it is the same action, and the caller reports that as TAB_HIDDEN.
   */
  onHidden(): void
  /** Cancels anything pending; safe to call more than once. */
  dispose(): void
}

export function createBlurWatch(options: BlurWatchOptions): BlurWatch {
  const { confirmMs, isHidden, hasFocus, onLeave } = options
  let timer: ReturnType<typeof setTimeout> | undefined

  function cancel() {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
  }

  return {
    onBlur() {
      cancel()
      timer = setTimeout(() => {
        timer = undefined
        // Re-read both, rather than trusting what was true at blur time —
        // that ordering is the entire bug this exists to fix.
        if (isHidden()) return
        if (hasFocus()) return
        onLeave()
      }, confirmMs)
    },
    onFocus: cancel,
    onHidden: cancel,
    dispose: cancel,
  }
}
