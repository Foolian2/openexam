import { useCallback, useEffect, useRef } from "react"

export interface DebouncedCallbackOptions {
  /**
   * Run a call still pending at unmount instead of dropping it. For callers
   * whose pending call is work the UI already promised would happen (an
   * autosave showing "saving"): dropping it loses the edit it captured.
   */
  flushOnUnmount?: boolean
}

/** Returns a stable function that calls `callback` `delayMs` after the last invocation. */
export function useDebouncedCallback<Args extends unknown[]>(
  callback: (...args: Args) => void,
  delayMs: number,
  { flushOnUnmount = false }: DebouncedCallbackOptions = {}
): (...args: Args) => void {
  const callbackRef = useRef(callback)
  const flushRef = useRef(flushOnUnmount)
  useEffect(() => {
    callbackRef.current = callback
    flushRef.current = flushOnUnmount
  })

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingArgsRef = useRef<Args | null>(null)
  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      // Only the newest scheduled call survives rescheduling, so flushing
      // (when asked) hands the latest arguments to the latest callback and
      // the superseded ones stay dropped — same as a normal debounce run.
      if (flushRef.current && pendingArgsRef.current) {
        callbackRef.current(...pendingArgsRef.current)
      }
      pendingArgsRef.current = null
    }
  }, [])

  return useCallback(
    (...args: Args) => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      pendingArgsRef.current = args
      timeoutRef.current = setTimeout(() => {
        pendingArgsRef.current = null
        callbackRef.current(...args)
      }, delayMs)
    },
    [delayMs]
  )
}
