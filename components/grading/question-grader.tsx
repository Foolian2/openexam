"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { toast } from "sonner"
import { ensureGraded } from "@/components/grading/ensure-graded"
import { ArrowLeft, Check, Inbox, Loader2, Sparkles, Zap } from "lucide-react"
import { apiMutateToast } from "@/lib/api-mutate-toast"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { AnswerDisplay, type GradedQuestion } from "./answer-display"
import { SolutionHint } from "./solution-hint"
import { RubricChecklist } from "./rubric-checklist"
import { QUESTION_TYPE_LABELS } from "@/lib/constants/question-types"
import { rubricOf } from "@/lib/types/questions"

interface RowGrade {
  points: number
  maxPoints: number
  feedback: string | null
  autoGraded: boolean
  reviewedAt: string | null
}

interface Row {
  sessionId: string
  student: { id: string; name: string; email: string }
  answer: Record<string, unknown> | null
  grade: RowGrade | null
}

interface QuestionGraderData {
  question: GradedQuestion
  exam: { id: string; title: string; status: string }
  rows: Row[]
}

export function QuestionGrader({
  examId,
  questionId,
}: {
  examId: string
  questionId: string
}) {
  const [data, setData] = useState<QuestionGraderData | null>(null)
  const [loadError, setLoadError] = useState("")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pointsDialogOpen, setPointsDialogOpen] = useState(false)
  const [pointsInput, setPointsInput] = useState("")
  const [feedbackInput, setFeedbackInput] = useState("")
  const [applyingPoints, setApplyingPoints] = useState(false)
  const [markingReviewed, setMarkingReviewed] = useState(false)

  async function load() {
    try {
      const res = await fetch(
        `/api/exams/${examId}/questions/${questionId}/answers`
      )
      const d = await res.json()
      if (!res.ok) {
        setLoadError(d.error?.message ?? "Laden fehlgeschlagen")
        return
      }
      setData(d)
    } catch {
      setLoadError("Netzwerkfehler. Bitte Seite neu laden.")
    }
  }

  useEffect(() => {
    // Await load() inside an async boundary so the react-compiler lint rule
    // can prove setState runs asynchronously (after the fetch resolves),
    // rather than synchronously in the effect body.
    // The grading backfill runs here, on mount, and not inside load():
    // load() also re-runs after every bulk edit, and those reloads only need
    // to read.
    void (async () => {
      await ensureGraded(examId)
      await load()
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionId])

  function toggleOne(sessionId: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
  }

  function toggleAll() {
    if (!data) return
    setSelected((prev) => {
      const allSelected = data.rows.every((r) => prev.has(r.sessionId))
      if (allSelected) return new Set()
      return new Set(data.rows.map((r) => r.sessionId))
    })
  }

  const selectedAutoGraded = data
    ? data.rows.filter((r) => selected.has(r.sessionId) && r.grade?.autoGraded)
    : []

  async function applyPoints() {
    if (!data) return
    const points = Number(pointsInput)
    if (Number.isNaN(points) || points < 0 || points > data.question.points) {
      toast.error(`Ungültige Punktzahl (0–${data.question.points})`)
      return
    }
    setApplyingPoints(true)
    try {
      const result = await apiMutateToast<{ gradesUpdated: number }>(
        `/api/exams/${examId}/bulk-grade`,
        {
          body: {
            sessionIds: Array.from(selected),
            action: "SET_POINTS",
            questionId,
            points,
            feedback: feedbackInput || undefined,
          },
          success: (d) => `Punkte für ${d.gradesUpdated} Antwort(en) gesetzt`,
          fallbackError: "Massenbewertung fehlgeschlagen",
        }
      )
      if (!result.ok) return
      setSelected(new Set())
      setPointsInput("")
      setFeedbackInput("")
      await load()
    } finally {
      setApplyingPoints(false)
      setPointsDialogOpen(false)
    }
  }

  async function markReviewed() {
    setMarkingReviewed(true)
    try {
      const result = await apiMutateToast(`/api/exams/${examId}/bulk-grade`, {
        body: {
          sessionIds: Array.from(selected),
          action: "MARK_REVIEWED",
          questionId,
        },
        success: "Als überprüft markiert",
        fallbackError: "Massenbewertung fehlgeschlagen",
      })
      if (!result.ok) return
      setSelected(new Set())
      await load()
    } finally {
      setMarkingReviewed(false)
    }
  }

  if (loadError) {
    return <div className="p-6 text-sm text-destructive">{loadError}</div>
  }
  if (!data) {
    return (
      <div className="flex min-h-[50svh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const rubric = rubricOf(data.question)
  const allSelected =
    data.rows.length > 0 && data.rows.every((r) => selected.has(r.sessionId))

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6 pb-24">
      <header className="sticky top-0 z-10 -mx-6 flex flex-wrap items-center gap-3 border-b bg-background/95 px-6 py-3 backdrop-blur">
        <SidebarTrigger className="-ml-1" />
        <Button
          asChild
          variant="ghost"
          size="icon"
          aria-label="Zurück zur Fragenübersicht"
        >
          <Link
            href={`/dashboard/teacher/grades/${examId}/by-question`}
            className="text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft />
          </Link>
        </Button>
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold">
            {data.question.title}
          </h1>
          <p className="text-xs text-muted-foreground">
            {data.exam.title} ·{" "}
            {
              QUESTION_TYPE_LABELS[
                data.question.type as keyof typeof QUESTION_TYPE_LABELS
              ]
            }{" "}
            · max. {data.question.points} P.
          </p>
        </div>
      </header>

      <SolutionHint question={data.question} />

      {rubric?.length ? (
        <RubricChecklist
          rubric={rubric}
          maxPoints={data.question.points}
          onApply={(points) => {
            if (selected.size === 0) {
              toast.error("Wählen Sie mindestens eine Antwort aus")
              return
            }
            setPointsInput(String(Math.min(points, data.question.points)))
            setPointsDialogOpen(true)
          }}
        />
      ) : null}

      {selected.size > 0 && (
        <div className="sticky top-16 z-10 flex animate-in flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/40 px-4 py-2 duration-[var(--duration-fast)] ease-out fade-in-0 slide-in-from-top-2">
          <span className="text-sm">{selected.size} ausgewählt</span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={selectedAutoGraded.length === 0 || markingReviewed}
              onClick={markReviewed}
              title={
                selectedAutoGraded.length === 0
                  ? "Keine automatisch bewerteten Antworten in der Auswahl"
                  : undefined
              }
            >
              {markingReviewed ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              Als überprüft markieren
            </Button>
            <Button size="sm" onClick={() => setPointsDialogOpen(true)}>
              <Zap className="h-3.5 w-3.5" />
              Punkte anwenden
            </Button>
          </div>
        </div>
      )}

      <div className="rounded-lg border">
        <div className="flex items-center gap-3 border-b px-4 py-2">
          <Checkbox
            checked={allSelected}
            onCheckedChange={toggleAll}
            aria-label="Alle auswählen"
          />
          <span className="text-sm text-muted-foreground">
            Alle auswählen ({data.rows.length})
          </span>
        </div>
        {data.rows.length === 0 && (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Inbox />
              </EmptyMedia>
              <EmptyTitle>Noch keine Abgaben</EmptyTitle>
              <EmptyDescription>
                Zu dieser Frage liegen keine Antworten vor. Sobald Teilnehmende
                die Prüfung abgeben, können Sie hier alle Antworten
                nebeneinander bewerten.
              </EmptyDescription>
            </EmptyHeader>
            <Button asChild size="sm" variant="outline">
              <Link href={`/dashboard/teacher/grades/${examId}/by-question`}>
                Zur Fragenübersicht
              </Link>
            </Button>
          </Empty>
        )}
        {data.rows.map((row) => (
          <div
            key={row.sessionId}
            className="flex gap-3 border-b p-4 last:border-b-0"
          >
            <Checkbox
              checked={selected.has(row.sessionId)}
              onCheckedChange={() => toggleOne(row.sessionId)}
              aria-label={`${row.student.name} auswählen`}
              className="mt-1"
            />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-medium">{row.student.name}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {row.student.email}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {row.grade ? (
                    <Badge variant="outline">
                      {row.grade.points} / {row.grade.maxPoints} P.
                    </Badge>
                  ) : (
                    <Badge variant="secondary">Unbewertet</Badge>
                  )}
                  {row.grade?.autoGraded && (
                    <Badge variant="secondary" className="gap-1">
                      <Sparkles className="h-3 w-3" />
                      Auto
                    </Badge>
                  )}
                  {row.grade?.reviewedAt && (
                    <Badge variant="secondary" className="gap-1">
                      <Check className="h-3 w-3" />
                      Überprüft
                    </Badge>
                  )}
                </div>
              </div>
              {row.answer ? (
                <AnswerDisplay
                  sessionId={row.sessionId}
                  question={data.question}
                  answer={row.answer}
                />
              ) : (
                <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                  Keine Antwort abgegeben
                </p>
              )}
            </div>
          </div>
        ))}
      </div>

      <AlertDialog open={pointsDialogOpen} onOpenChange={setPointsDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Punkte für {selected.size} Antwort(en) setzen?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Überschreibt die aktuelle Bewertung dieser Antworten mit dem
              angegebenen Wert. Dies kann nicht rückgängig gemacht werden.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="bulk-points">
                Punkte (0–{data.question.points})
              </Label>
              <Input
                id="bulk-points"
                type="number"
                min={0}
                max={data.question.points}
                step={0.5}
                value={pointsInput}
                onChange={(e) => setPointsInput(e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="bulk-feedback">Feedback (optional)</Label>
              <Textarea
                id="bulk-feedback"
                value={feedbackInput}
                onChange={(e) => setFeedbackInput(e.target.value)}
                rows={2}
                className="mt-1"
              />
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={applyingPoints}>
              Abbrechen
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={applyPoints}
              disabled={
                applyingPoints || pointsInput === "" || selected.size === 0
              }
            >
              {applyingPoints && <Loader2 className="h-4 w-4 animate-spin" />}
              Anwenden
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
