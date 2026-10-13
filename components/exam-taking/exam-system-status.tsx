"use client"

import { useEffect, useState, useSyncExternalStore } from "react"
import {
  BatteryCharging,
  BatteryFull,
  BatteryLow,
  BatteryMedium,
  BatteryWarning,
  WifiOff,
} from "lucide-react"
import { useClock } from "@/hooks/use-clock"
import { describeBattery, type BatteryStatus } from "@/lib/battery-status"
import { cn } from "@/lib/utils"

/**
 * `navigator.getBattery()` is not in lib.dom (the Battery Status API was
 * dropped from the standard library types), so it is declared here. Optional
 * because it genuinely is: Chromium implements it, WebKit does not, so this
 * resolves on Windows SEB and is simply absent on macOS SEB's WKWebView.
 */
interface BatteryManager extends EventTarget {
  level: number
  charging: boolean
}

declare global {
  interface Navigator {
    getBattery?: () => Promise<BatteryManager>
  }
}

/** How long the socket must stay down before the student is told. */
const OFFLINE_CONFIRM_MS = 5_000

/**
 * Wall-clock time, battery charge and connection state, shown inside the exam.
 *
 * These are not decoration: SEB's task bar is hidden (see lib/SEB_OUT_OF_SCOPE.md
 * — every pixel of it is somewhere a student can click that is not the exam),
 * and it used to be the only clock, battery indicator and network status on
 * screen. A student two hours into a paper on an unplugged laptop has no other
 * way to see any of it, and SEB's kiosk mode means there is nothing else to look
 * at.
 *
 * Rendered only inside SEB, since that is the only place the task bar was taken
 * away; a normal browser still has the operating system's own.
 */
export function ExamSystemStatus({
  clockOffsetMs,
  connected,
}: {
  clockOffsetMs: number
  connected: boolean
}) {
  const inSeb = useIsSeb()

  const battery = useBattery(inSeb)
  // Shares the one 1s ticker the exam timer already runs, so neither the clock
  // nor the offline threshold below costs an additional interval.
  const tickMs = useClock()
  const offline = useConfirmedOffline(connected, tickMs)
  // Offset only for display: the offline threshold is a duration, which the
  // server's clock skew has no bearing on.
  const nowMs = tickMs + clockOffsetMs

  if (!inSeb) return null

  const time = new Date(nowMs).toLocaleTimeString("de-CH", {
    hour: "2-digit",
    minute: "2-digit",
  })

  return (
    <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground tabular-nums">
      <span aria-label={`Uhrzeit ${time}`}>{time}</span>
      {battery && <BatteryIndicator status={battery} />}
      {offline && (
        <span className="flex items-center gap-1 font-medium text-destructive">
          <WifiOff className="h-3.5 w-3.5" aria-hidden />
          Offline
        </span>
      )}
    </div>
  )
}

/**
 * True once the socket has been down continuously for OFFLINE_CONFIRM_MS.
 *
 * Reconnects are routine — a laptop waking, a Wi-Fi roam between access points
 * — and each one drops `connected` for a moment. Rendering that immediately
 * would flash "Offline" at a student mid-exam over something that fixed itself,
 * which is its own kind of false alarm. Recovery is instant in the other
 * direction: once the socket is back there is nothing left to warn about.
 *
 * Derived by adjusting state during render rather than in an effect — the
 * documented pattern for state that follows a prop, and it needs no timer of
 * its own: the shared 1s tick that drives the clock above re-renders this and
 * carries it across the threshold.
 */
function useConfirmedOffline(connected: boolean, nowMs: number): boolean {
  const [offlineSince, setOfflineSince] = useState<number | null>(null)

  if (connected && offlineSince !== null) setOfflineSince(null)
  if (!connected && offlineSince === null) setOfflineSince(nowMs)

  return offlineSince !== null && nowMs - offlineSince >= OFFLINE_CONFIRM_MS
}

/**
 * Whether the page is running inside SEB, resolved without a hydration
 * mismatch: the server snapshot is `false` (it has no window.SafeExamBrowser),
 * the client snapshot reads the real thing, and React reconciles the two after
 * hydration. `subscribe` is a no-op because the answer cannot change — a page
 * does not move between browsers.
 */
function useIsSeb(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => window.SafeExamBrowser !== undefined,
    () => false
  )
}

function BatteryIndicator({ status }: { status: BatteryStatus }) {
  const Icon = status.charging
    ? BatteryCharging
    : status.tone === "critical"
      ? BatteryWarning
      : status.tone === "low"
        ? BatteryLow
        : status.percent > 60
          ? BatteryFull
          : BatteryMedium

  return (
    <span
      className={cn(
        "flex items-center gap-1",
        status.tone === "critical" && "font-medium text-destructive",
        status.tone === "low" && "text-amber-600 dark:text-amber-500"
      )}
      aria-label={
        `Akku ${status.percent} Prozent` + (status.charging ? ", wird geladen" : "")
      }
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {status.percent}%
    </span>
  )
}

/**
 * Subscribes to the Battery Status API, or stays null where it does not exist.
 *
 * The BatteryManager is a long-lived object that mutates in place and notifies
 * through events, so polling it would be both wasteful and laggy; `levelchange`
 * and `chargingchange` are the only times the reading actually moves.
 */
function useBattery(enabled: boolean): BatteryStatus | null {
  const [status, setStatus] = useState<BatteryStatus | null>(null)

  useEffect(() => {
    if (!enabled || typeof navigator.getBattery !== "function") return

    let manager: BatteryManager | null = null
    // The promise can resolve after unmount (or after the API rejects, which
    // some Chromium builds do behind a permissions policy) — without this the
    // listeners would be attached to an object nothing ever detaches them from.
    let cancelled = false

    const update = () => {
      if (!manager) return
      setStatus(describeBattery(manager.level, manager.charging))
    }

    navigator
      .getBattery()
      .then((b) => {
        if (cancelled) return
        manager = b
        update()
        b.addEventListener("levelchange", update)
        b.addEventListener("chargingchange", update)
      })
      .catch(() => {
        // Unavailable is the normal case on WebKit and behind a restrictive
        // permissions policy. Nothing renders, which is the intended fallback.
      })

    return () => {
      cancelled = true
      manager?.removeEventListener("levelchange", update)
      manager?.removeEventListener("chargingchange", update)
    }
  }, [enabled])

  return status
}
