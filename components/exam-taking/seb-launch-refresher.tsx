"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"

/**
 * Keeps the seb:// launch link on /exam/[id]/launch-seb alive.
 *
 * Both tokens in that link — the single-use launch token and the one-time
 * login token — are minted when the page renders and expire together after
 * LAUNCH_TOKEN_TTL_SECONDS. A student who opens the page and then reads the
 * instructions, fetches their headphones, or waits for the invigilator to
 * start the exam comes back to a link that 401s with "Ungültiger oder
 * abgelaufener Start-Link", inside a flow that offers no way to retry short of
 * a manual reload.
 *
 * router.refresh() re-runs the server component and swaps in a fresh pair. The
 * interval is deliberately well under the TTL so a refresh that lands slowly
 * still replaces the link before the old one dies, and we refresh again the
 * moment the tab regains focus — the common case is a backgrounded tab, where
 * browsers throttle timers hard enough to miss several intervals.
 */
export function SebLaunchRefresher({ ttlSeconds }: { ttlSeconds: number }) {
  const router = useRouter()

  useEffect(() => {
    const intervalMs = (ttlSeconds / 2) * 1000

    const timer = setInterval(() => router.refresh(), intervalMs)
    const onVisible = () => {
      if (document.visibilityState === "visible") router.refresh()
    }
    document.addEventListener("visibilitychange", onVisible)

    return () => {
      clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [router, ttlSeconds])

  return null
}
