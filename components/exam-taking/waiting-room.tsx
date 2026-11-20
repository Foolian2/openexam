"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Hourglass, Loader2, WifiOff } from "lucide-react"
import { useClock } from "@/hooks/use-clock"
import { replaceDocument } from "@/lib/document-navigation"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

/** How often the room asks whether the teacher has pressed Start. */
export const WAITING_POLL_MS = 2_000
const WAITING_POLL_JITTER = 0.25
/** Failed polls in a row before the connection warning shows. */
const OFFLINE_AFTER_FAILURES = 3
/**
 * Spread over which the room moves on to /take once the shared start is
 * reached, so a whole class doesn't load the exam in the same instant. The
 * clock is already running server-side, so this costs at most this long.
 */
export const ENTER_SPREAD_MS = 2_000

type StartStatus = {
  status: string
  examStatus: string
  startedAt: string | null
  serverNow: string
}

type Props = {
  sessionId: string
  examId: string
  title: string
  timeLimitMin: number
  initialStartedAt: string | null
  initialServerNow: string
}

export function WaitingRoom({
  sessionId,
  examId,
  title,
  timeLimitMin,
  initialStartedAt,
  initialServerNow,
}: Props) {
  const [startedAt, setStartedAt] = useState(initialStartedAt)
  // Server time minus local time, so the countdown follows the server's clock
  // even when the student's device clock is off.
  const [offset, setOffset] = useState(
    () => new Date(initialServerNow).getTime() - Date.now()
  )
  const [failures, setFailures] = useState(0)
  const [unavailable, setUnavailable] = useState(false)
  const now = useClock()
  const router = useRouter()
  const entering = useRef(false)

  // Ask until Start has happened. Self-rescheduling with jitter, like the
  // runner's status poll: a slow server stretches the period instead of
  // stacking requests, and a class doesn't poll in lockstep.
  useEffect(() => {
    if (startedAt || unavailable) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    async function poll() {
      try {
        const res = await fetch(`/api/sessions/${sessionId}/start-status`, {
          cache: "no-store",
        })
        if (!res.ok) throw new Error(String(res.status))
        const data: StartStatus = await res.json()
        if (cancelled) return
        setFailures(0)
        setOffset(new Date(data.serverNow).getTime() - Date.now())
        if (data.status === "SUBMITTED" || data.status === "AUTO_SUBMITTED") {
          router.replace(`/exam/${examId}/complete`)
          return
        }
        if (data.startedAt && data.status !== "WAITING") {
          setStartedAt(data.startedAt)
          return
        }
        if (data.examStatus !== "PUBLISHED") {
          // Archived or otherwise taken away before Start.
          setUnavailable(true)
          return
        }
      } catch {
        if (!cancelled) setFailures((n) => n + 1)
      }
      if (!cancelled) schedule()
    }
    function schedule() {
      const spread = WAITING_POLL_MS * WAITING_POLL_JITTER
      timer = setTimeout(
        () => void poll(),
        WAITING_POLL_MS - spread + Math.random() * 2 * spread
      )
    }
    schedule()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [sessionId, examId, startedAt, unavailable, router])

  // Once Start is known, move on when the shared clock begins.
  useEffect(() => {
    if (!startedAt) return
    const delay =
      new Date(startedAt).getTime() -
      (Date.now() + offset) +
      Math.random() * ENTER_SPREAD_MS
    const timer = setTimeout(
      () => {
        if (entering.current) return
        entering.current = true
        // A full load, not router.replace: inside SEB a soft navigation
        // fails the take page's Config Key check. See replaceDocument.
        replaceDocument(`/exam/${examId}/take`)
      },
      Math.max(0, delay)
    )
    return () => clearTimeout(timer)
  }, [startedAt, offset, examId])

  const secondsLeft = startedAt
    ? Math.max(
        0,
        Math.ceil((new Date(startedAt).getTime() - (now + offset)) / 1000)
      )
    : null

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-md text-center">
        <CardHeader>
          <Hourglass className="mx-auto mb-2 h-12 w-12 text-primary" />
          <CardTitle>Warteraum</CardTitle>
          <CardDescription>
            «{title}» · {timeLimitMin} Minuten
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4">
          {unavailable ? (
            <>
              <p className="text-sm">Diese Prüfung ist nicht mehr verfügbar.</p>
              <Button asChild variant="outline">
                <a href="/dashboard/student">Zum Dashboard</a>
              </Button>
            </>
          ) : secondsLeft !== null ? (
            <p className="text-lg font-medium" role="status" aria-live="polite">
              {secondsLeft > 0
                ? `Die Prüfung beginnt in ${secondsLeft} s`
                : "Die Prüfung wird geöffnet …"}
            </p>
          ) : (
            <>
              <Loader2
                className="h-6 w-6 animate-spin text-muted-foreground motion-reduce:animate-none"
                aria-hidden
              />
              <p className="text-sm" role="status">
                Du bist im Warteraum. Die Prüfung beginnt für alle gleichzeitig,
                sobald die Lehrperson sie startet. Deine Zeit läuft erst ab
                dann. Lass diese Seite offen.
              </p>
            </>
          )}
          {failures >= OFFLINE_AFTER_FAILURES && !unavailable && (
            <p className="flex items-center gap-2 text-sm text-destructive">
              <WifiOff className="h-4 w-4" aria-hidden />
              Keine Verbindung zum Server. Es wird weiter versucht …
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
