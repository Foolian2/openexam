"use client"

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import { useRouter } from "next/navigation"
import { KeyRound, LogIn, Hourglass } from "lucide-react"
import { apiMutate } from "@/lib/api-mutate"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

const CODE_LENGTH = 6

// The join route answers 202 with a wait instead of a session when a whole
// class arrives at once (lib/exam-admission.ts). One return trip is normally
// the whole story — the place in line is reserved, so coming back on time is
// admitted — and the rest is headroom for a cohort big enough to overflow the
// queue, where everyone receives the same capped wait and a round can repeat.
// Bounded so a server that somehow never releases produces an error the
// student can act on rather than a spinner that never ends.
const MAX_QUEUE_ROUNDS = 4

// Waits the server computes are already spread apart by construction — it
// hands out one slot per admission interval. The exception is a cohort large
// enough to overflow the queue, where everyone past its capacity receives the
// same capped wait; returning exactly on time would rebuild a smaller version
// of the burst. A second of scatter de-synchronises those without meaningfully
// stretching the shortest wait the server ever asks for (one second).
const RETRY_JITTER_MS = 1_000

// POST /api/sessions answers 200 with the exam, or 202 with a queue slot
// when the admission burst is full.
type JoinResponse = {
  examId?: string
  queued?: boolean
  waitMs?: number
  /** Entered the waiting room of a shared-start exam. */
  waiting?: boolean
}

export function JoinExamForm() {
  const router = useRouter()
  const [code, setCode] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  // The reserved place in line, or null when not queued. `admitAt` is a
  // wall-clock instant rather than a countdown so a throttled background tab
  // resumes with the correct remaining time instead of a counter frozen where
  // it was backgrounded, and the access code rides along because the retry is
  // scheduled from an effect that can't see the form's current input.
  const [queue, setQueue] = useState<{
    code: string
    admitAt: number
  } | null>(null)
  const [remainingSec, setRemainingSec] = useState(0)
  const roundsRef = useRef(0)

  const join = useCallback(
    async (accessCode: string) => {
      setError("")
      setLoading(true)
      const result = await apiMutate<JoinResponse>("/api/sessions", {
        body: { accessCode },
        fallbackError: "Beitritt fehlgeschlagen",
        networkError: "Netzwerkfehler. Bitte erneut versuchen.",
      })
      if (!result.ok) {
        setQueue(null)
        setLoading(false)
        setError(result.message)
        return
      }
      const data = result.data
      if (data.queued && roundsRef.current < MAX_QUEUE_ROUNDS) {
        roundsRef.current += 1
        const delay =
          (Number(data.waitMs) || 0) + Math.random() * RETRY_JITTER_MS
        setQueue({ code: accessCode, admitAt: Date.now() + delay })
        setRemainingSec(Math.ceil(delay / 1000))
        // `loading` deliberately stays true: the join is still in flight
        // from the student's point of view, and once the countdown ends the
        // form must not be sitting there inviting a second submit.
        return
      }
      if (data.queued) {
        // Out of rounds — the queue never released us. Hand the student
        // back control rather than looping: a manual retry re-uses the
        // reserved rank, so it is admitted rather than sent to the back.
        setQueue(null)
        setLoading(false)
        setError("Der Start ist stark ausgelastet. Bitte erneut versuchen.")
        return
      }
      setQueue(null)
      // Stays loading through the navigation — re-enabling the button here
      // only creates a window for a second join on a slow route transition.
      router.push(
        data.waiting ? `/exam/${data.examId}/wait` : `/exam/${data.examId}/take`
      )
    },
    [router]
  )

  // Re-attempt the join when the reserved slot opens. Driven by an effect
  // rather than a timer the fetch schedules for itself, so unmounting mid-
  // countdown cancels it and a fresh decision always replaces the pending one.
  useEffect(() => {
    if (!queue) return
    const id = setTimeout(
      () => void join(queue.code),
      Math.max(0, queue.admitAt - Date.now())
    )
    return () => clearTimeout(id)
  }, [queue, join])

  // Drives the visible countdown only; entry is scheduled by the effect
  // above, so a drifting or throttled tick can't delay it.
  useEffect(() => {
    if (!queue) return
    const tick = () =>
      setRemainingSec(
        Math.max(0, Math.ceil((queue.admitAt - Date.now()) / 1000))
      )
    tick()
    const id = setInterval(tick, 250)
    return () => clearInterval(id)
  }, [queue])

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (loading) return
    roundsRef.current = 0
    void join(code.trim().toUpperCase())
  }

  const queued = queue !== null

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="items-center text-center">
        <div className="mx-auto mb-1 flex size-10 items-center justify-center rounded-full bg-primary/10">
          {queued ? (
            <Hourglass className="size-5 text-primary" />
          ) : (
            <KeyRound className="size-5 text-primary" />
          )}
        </div>
        <CardTitle>
          {queued ? "Gleich geht es los" : "An Prüfung teilnehmen"}
        </CardTitle>
        <CardDescription>
          {queued
            ? "Ihr Platz ist reserviert. Sie werden automatisch eingelassen — bitte diese Seite offen lassen."
            : "Geben Sie den 6-stelligen Zugangscode ein, den Sie von Ihrer Lehrperson erhalten haben."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {queued ? (
          <div
            role="status"
            aria-live="polite"
            className="flex flex-col items-center gap-3 py-2 text-center"
          >
            {/* Decorative: the countdown below is what this region announces. */}
            <Spinner
              aria-hidden="true"
              className="size-6 text-muted-foreground"
            />
            <p className="text-3xl font-semibold tabular-nums">
              {remainingSec}s
            </p>
            <p className="text-sm text-muted-foreground">
              Ihre Prüfungszeit beginnt erst, wenn Sie eingelassen werden.
            </p>
          </div>
        ) : (
          <form
            onSubmit={handleSubmit}
            className="flex flex-col items-center gap-4"
          >
            <InputOTP
              maxLength={CODE_LENGTH}
              aria-label="Zugangscode"
              value={code}
              onChange={(value) => {
                setCode(value.toUpperCase())
                setError("")
              }}
              // Matches the server validator: letters plus digits 2-9 (no 0/1).
              pattern="^[a-zA-Z2-9]*$"
              autoFocus
              containerClassName="justify-center"
            >
              <InputOTPGroup>
                {Array.from({ length: CODE_LENGTH }, (_, i) => (
                  <InputOTPSlot
                    key={i}
                    index={i}
                    className="size-12 font-mono text-xl uppercase"
                  />
                ))}
              </InputOTPGroup>
            </InputOTP>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button
              type="submit"
              className="w-full"
              disabled={loading || code.trim().length !== CODE_LENGTH}
            >
              <LogIn />
              {loading ? "Wird geprüft…" : "Teilnehmen"}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  )
}
