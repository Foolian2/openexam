import { useSyncExternalStore } from "react"

// A single shared 1s ticker backs every useClock() call, so N ticking rows
// cost one setInterval instead of N. getSnapshot must return a value that's
// only updated from the interval callback (not on every call) — returning
// Date.now() directly from getSnapshot is a classic useSyncExternalStore
// footgun: React re-invokes getSnapshot after render to check for tearing,
// sees a "changed" value every time since it's the wall clock, and schedules
// another render in an infinite loop.
let cached = Date.now()
const listeners = new Set<() => void>()
let intervalId: ReturnType<typeof setInterval> | null = null

function tick() {
  cached = Date.now()
  for (const listener of listeners) listener()
}

function subscribe(callback: () => void) {
  listeners.add(callback)
  if (intervalId === null) {
    // The ticker was stopped, so `cached` is as old as the last tick (or the
    // module load) — refresh it, or the first subscriber renders a stale time.
    cached = Date.now()
    intervalId = setInterval(tick, 1000)
  }
  return () => {
    listeners.delete(callback)
    if (listeners.size === 0 && intervalId !== null) {
      clearInterval(intervalId)
      intervalId = null
    }
  }
}

function getSnapshot() {
  return cached
}

export function useClock() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
