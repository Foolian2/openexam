"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { MonitorPlay, Pencil, Users } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { AccessCodeChip } from "./access-code-chip"
import { isActive } from "@/lib/session-state"

const POLL_INTERVAL_MS = 10_000

interface ActiveExam {
  id: string
  title: string
  accessCode: string
  activatedAt: string | null
  initialActiveCount: number
}

function formatElapsed(activatedAt: string, now: number): string {
  const minutes = Math.max(
    0,
    Math.floor((now - new Date(activatedAt).getTime()) / 60_000)
  )
  if (minutes < 60) return `Seit ${minutes} Min. aktiv`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `Seit ${h} Std. ${m} Min. aktiv`
}

export function ActiveExamCallout({ exams }: { exams: ActiveExam[] }) {
  const [counts, setCounts] = useState<Record<string, number>>(() =>
    Object.fromEntries(exams.map((e) => [e.id, e.initialActiveCount]))
  )
  // Elapsed time is rendered client-side only to avoid a hydration mismatch.
  const [now, setNow] = useState<number | null>(null)

  useEffect(() => {
    const update = () => setNow(Date.now())
    const timeout = setTimeout(update, 0)
    const interval = setInterval(update, 60_000)
    return () => {
      clearTimeout(timeout)
      clearInterval(interval)
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function poll() {
      if (document.visibilityState === "hidden") return
      const results = await Promise.allSettled(
        exams.map(async (exam) => {
          const res = await fetch(`/api/exams/${exam.id}/sessions`)
          if (!res.ok) return null
          const data = (await res.json()) as { sessions: { status: string }[] }
          return {
            id: exam.id,
            count: data.sessions.filter((s) => isActive(s.status)).length,
          }
        })
      )
      if (cancelled) return
      setCounts((prev) => {
        const next = { ...prev }
        for (const r of results) {
          if (r.status === "fulfilled" && r.value)
            next[r.value.id] = r.value.count
        }
        return next
      })
    }

    const interval = setInterval(() => void poll(), POLL_INTERVAL_MS)
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void poll()
    }
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => {
      cancelled = true
      clearInterval(interval)
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }, [exams])

  if (exams.length === 0) return null

  return (
    <div
      className={exams.length > 1 ? "grid gap-4 md:grid-cols-2" : "grid gap-4"}
    >
      {exams.map((exam) => (
        <Card key={exam.id} className="border-primary/40 bg-primary/5">
          <CardHeader>
            <div className="flex items-center gap-2 text-xs font-medium text-primary">
              <span
                aria-hidden
                className="relative inline-flex size-2 rounded-full bg-primary"
              />
              Läuft gerade
            </div>
            <CardTitle>
              <Link
                href={`/dashboard/teacher/monitor/${exam.id}`}
                className="underline-offset-2 hover:underline"
              >
                {exam.title}
              </Link>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-col gap-2">
              <AccessCodeChip
                code={exam.accessCode}
                className="px-4 py-2 text-2xl tracking-[0.3em]"
              />
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <Users className="size-4" />
                  {counts[exam.id] ?? 0} Teilnehmer aktiv
                </span>
                {exam.activatedAt && now !== null && (
                  <span>{formatElapsed(exam.activatedAt, now)}</span>
                )}
              </div>
            </div>
            <div className="flex gap-2">
              <Button asChild>
                <Link href={`/dashboard/teacher/monitor/${exam.id}`}>
                  <MonitorPlay data-icon="inline-start" />
                  Live-Monitor
                </Link>
              </Button>
              <Button asChild variant="outline">
                <Link href={`/dashboard/teacher/exams/${exam.id}/edit`}>
                  <Pencil data-icon="inline-start" />
                  Bearbeiten
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
