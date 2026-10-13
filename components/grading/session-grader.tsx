"use client"

import { memo, useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { ensureGraded } from "@/components/grading/ensure-graded"
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  ListTodo,
  Loader2,
  Save,
  Sparkles,
} from "lucide-react"
import { apiMutate } from "@/lib/api-mutate"
import { useDebouncedCallback } from "@/hooks/use-debounced-callback"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { HelpTip } from "@/components/help-tip"
import { AnswerDisplay, type GradedQuestion } from "./answer-display"
import { SolutionHint } from "./solution-hint"
import { RubricChecklist } from "./rubric-checklist"
import { getGradingProgress } from "@/lib/grading-progress"
import { prefersReducedMotion } from "@/lib/utils"
import { rubricOf } from "@/lib/types/questions"

type ReviewQuestion = GradedQuestion

interface ReviewData {
  session: {
    id: string
    submissionType: string | null
    submittedAt: string | null
    // Non-null when this session's SEB Browser Exam Key changed or stopped
    // arriving mid-exam. Informational: the student was never blocked, and
    // this is not by itself evidence of cheating (see lib/SEB_OUT_OF_SCOPE.md).
    sebIntegrityFlaggedAt: string | null
    sebIntegrityReason: string | null
  }
  student: { name: string; email: string }
  exam: { id: string; title: string; status: string }
  questions: ReviewQuestion[]
  answers: { questionId: string; content: Record<string, unknown> }[]
  grades: {
    questionId: string
    points: number
    feedback: string | null
    autoGraded: boolean
  }[]
}

interface GradeDraft {
  points: string
  feedback: string
  autoGraded: boolean
}

export function SessionGrader({
  sessionId,
  examId,
  position,
  prevSessionId,
  nextSessionId,
}: {
  sessionId: string
  examId: string
  position: { index: number; total: number }
  prevSessionId: string | null
  nextSessionId: string | null
}) {
  const router = useRouter()
  const [data, setData] = useState<ReviewData | null>(null)
  const [loadError, setLoadError] = useState("")
  const [drafts, setDrafts] = useState<Record<string, GradeDraft>>({})
  const [saving, setSaving] = useState(false)
  const [justSaved, setJustSaved] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [autosaveStatus, setAutosaveStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle")
  // The load effect below sets the initial drafts from the fetched review —
  // that assignment must not itself trigger an autosave PUT.
  const skipNextAutosaveRef = useRef(true)
  const editVersionRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    async function load() {
      await ensureGraded(examId, sessionId)
      if (cancelled) return
      try {
        const res = await fetch(`/api/sessions/${sessionId}/review`)
        const d = await res.json()
        if (!res.ok) {
          setLoadError(d.error?.message ?? "Laden fehlgeschlagen")
          return
        }
        if (cancelled) return
        const review: ReviewData = d
        const initial: Record<string, GradeDraft> = {}
        for (const q of review.questions) {
          const grade = review.grades.find((g) => g.questionId === q.id)
          initial[q.id] = {
            points: grade ? String(grade.points) : "",
            feedback: grade?.feedback ?? "",
            autoGraded: grade?.autoGraded ?? false,
          }
        }
        setDrafts(initial)
        setData(review)
        setDirty(false)
        editVersionRef.current = 0
        skipNextAutosaveRef.current = true
      } catch {
        setLoadError("Netzwerkfehler. Bitte Seite neu laden.")
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [examId, sessionId])

  type DraftGrade = { questionId: string; points: number; feedback?: string }

  /** Permissive: silently drops entries with no/invalid points rather than
   * aborting, since autosave should persist whatever's currently valid
   * without interrupting a mid-edit. handleSave below does its own strict,
   * all-or-nothing validation on top of this for the explicit save. */
  function collectValidGrades(
    review: ReviewData,
    source: Record<string, GradeDraft>
  ): DraftGrade[] {
    const grades: DraftGrade[] = []
    for (const q of review.questions) {
      const draft = source[q.id]
      if (!draft || draft.points === "") continue
      const points = Number(draft.points)
      if (Number.isNaN(points) || points < 0 || points > q.points) continue
      grades.push({
        questionId: q.id,
        points,
        feedback: draft.feedback || undefined,
      })
    }
    return grades
  }

  async function persistGrades(
    grades: DraftGrade[]
  ): Promise<{ ok: boolean; message?: string }> {
    // Stays toast-free: the debounced autosave below reports through
    // autosaveStatus, and only the explicit save surfaces a message.
    const result = await apiMutate(`/api/sessions/${sessionId}/grades`, {
      method: "PUT",
      body: { grades },
      fallbackError: "Speichern fehlgeschlagen",
    })
    if (!result.ok) return { ok: false, message: result.message }
    return { ok: true }
  }

  const debouncedAutosave = useDebouncedCallback(
    (source: Record<string, GradeDraft>) => {
      if (!data) return
      const grades = collectValidGrades(data, source)
      if (grades.length === 0) return
      setAutosaveStatus("saving")
      void persistGrades(grades).then(({ ok }) => {
        setAutosaveStatus(ok ? "saved" : "error")
      })
    },
    1500
  )

  useEffect(() => {
    if (skipNextAutosaveRef.current) {
      skipNextAutosaveRef.current = false
      return
    }
    debouncedAutosave(drafts)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts])

  async function handleSave(): Promise<boolean> {
    if (!data) return false
    const grades: DraftGrade[] = []
    for (const q of data.questions) {
      const draft = drafts[q.id]
      if (!draft || draft.points === "") continue
      const points = Number(draft.points)
      if (Number.isNaN(points) || points < 0 || points > q.points) {
        toast.error(`Ungültige Punktzahl bei „${q.title}“ (0–${q.points})`)
        return false
      }
      grades.push({
        questionId: q.id,
        points,
        feedback: draft.feedback || undefined,
      })
    }
    if (grades.length === 0) {
      toast.error("Keine Punkte eingetragen")
      return false
    }
    const editVersion = editVersionRef.current
    setSaving(true)
    try {
      const { ok, message } = await persistGrades(grades)
      if (!ok) {
        toast.error(message ?? "Speichern fehlgeschlagen")
        return false
      }
      if (editVersionRef.current !== editVersion) {
        // The teacher changed a score or feedback while this save was in
        // flight. What we just persisted is already stale, so keep `dirty`
        // set and report failure -- the caller must not navigate away, or
        // the newer edit (and its pending autosave) would be lost on unmount.
        setAutosaveStatus("saved")
        return false
      }
      setDirty(false)
      setAutosaveStatus("saved")
      toast.success("Bewertung gespeichert")
      setJustSaved(true)
      setTimeout(() => setJustSaved(false), 1500)
      return true
    } finally {
      setSaving(false)
    }
  }

  const changePoints = useCallback((questionId: string, points: string) => {
    editVersionRef.current += 1
    setDirty(true)
    setDrafts((prev) => ({
      ...prev,
      [questionId]: { ...prev[questionId], points, autoGraded: false },
    }))
  }, [])

  const changeFeedback = useCallback((questionId: string, feedback: string) => {
    editVersionRef.current += 1
    setDirty(true)
    setDrafts((prev) => ({
      ...prev,
      [questionId]: { ...prev[questionId], feedback, autoGraded: false },
    }))
  }, [])

  async function navigateToSession(targetSessionId: string): Promise<void> {
    if (dirty && !(await handleSave())) return
    router.push(`/dashboard/teacher/grades/${examId}/${targetSessionId}`)
  }

  async function saveAndContinue(): Promise<void> {
    if (!(await handleSave())) return
    if (nextSessionId) {
      router.push(`/dashboard/teacher/grades/${examId}/${nextSessionId}`)
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

  const answersByQuestion = new Map(
    data.answers.map((a) => [a.questionId, a.content])
  )
  const total = data.questions.reduce((sum, q) => {
    const p = Number(drafts[q.id]?.points)
    return sum + (Number.isNaN(p) ? 0 : p)
  }, 0)
  const maxTotal = data.questions.reduce((sum, q) => sum + q.points, 0)
  const progress = getGradingProgress(data.questions, drafts)

  function scrollToFirstOpen(): void {
    if (!progress.firstOpenId) return
    document.getElementById(`grade-${progress.firstOpenId}`)?.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "center",
    })
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6 pb-24">
      <header className="sticky top-0 z-10 -mx-6 flex flex-wrap items-center justify-between gap-3 border-b bg-background/95 px-6 py-3 backdrop-blur">
        <div className="flex items-center gap-2">
          <SidebarTrigger className="-ml-1" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Button
                asChild
                variant="ghost"
                size="icon"
                aria-label="Zurück zur Bewertungsübersicht"
              >
                <Link
                  href={`/dashboard/teacher/grades/${examId}`}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <ArrowLeft />
                </Link>
              </Button>
              <h1 className="truncate text-xl font-semibold">
                {data.student.name}
              </h1>
              <span className="text-sm text-muted-foreground">
                ({position.index}/{position.total})
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {data.exam.title} · {total} / {maxTotal} Punkte
            </p>
            <button
              type="button"
              className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:pointer-events-none"
              onClick={scrollToFirstOpen}
              disabled={progress.open === 0}
            >
              <ListTodo className="h-3 w-3" />
              {progress.open === 0
                ? "Alle Fragen bewertet"
                : `${progress.open} von ${progress.total} Fragen offen`}
            </button>
            {data.session.sebIntegrityFlaggedAt && (
              <p className="mt-1 text-xs font-medium text-destructive">
                {data.session.sebIntegrityReason === "bek_disappeared"
                  ? "SEB-Schlüssel wurde während der Prüfung nicht mehr gesendet."
                  : "SEB-Schlüssel hat sich während der Prüfung geändert."}{" "}
                <span className="font-normal">
                  Hinweis zur Prüfung durch eine Lehrperson — kein Nachweis
                  einer Täuschung.
                </span>
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            disabled={!prevSessionId || saving}
            aria-label="Vorherige Sitzung"
            onClick={() =>
              prevSessionId && void navigateToSession(prevSessionId)
            }
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            disabled={!nextSessionId || saving}
            aria-label="Nächste Sitzung"
            onClick={() =>
              nextSessionId && void navigateToSession(nextSessionId)
            }
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <span
            className="hidden text-xs text-muted-foreground sm:inline"
            aria-live="polite"
          >
            {autosaveStatus === "saving" && "Wird automatisch gespeichert…"}
            {autosaveStatus === "saved" && "Automatisch gespeichert"}
            {autosaveStatus === "error" &&
              "Automatisches Speichern fehlgeschlagen"}
          </span>
          <Button
            onClick={() => void saveAndContinue()}
            disabled={saving || justSaved}
          >
            {saving ? (
              <Loader2 className="animate-spin" />
            ) : justSaved ? (
              <Check />
            ) : (
              <Save />
            )}
            {justSaved
              ? "Gespeichert"
              : nextSessionId
                ? "Speichern & weiter"
                : "Speichern"}
            {nextSessionId && !saving && !justSaved && (
              <ChevronRight className="h-4 w-4" />
            )}
          </Button>
        </div>
      </header>

      {data.questions.map((q, index) => (
        <GradeCard
          key={q.id}
          sessionId={sessionId}
          question={q}
          index={index}
          answer={answersByQuestion.get(q.id)}
          draft={drafts[q.id]}
          onChangePoints={changePoints}
          onChangeFeedback={changeFeedback}
        />
      ))}
    </div>
  )
}

const GradeCard = memo(function GradeCard({
  sessionId,
  question,
  index,
  answer,
  draft,
  onChangePoints,
  onChangeFeedback,
}: {
  sessionId: string
  question: ReviewQuestion
  index: number
  answer?: Record<string, unknown>
  draft?: GradeDraft
  onChangePoints: (questionId: string, points: string) => void
  onChangeFeedback: (questionId: string, feedback: string) => void
}) {
  const rubric = rubricOf(question)
  return (
    <Card id={`grade-${question.id}`}>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <CardTitle className="text-base leading-relaxed font-medium">
          <span className="mr-2 text-muted-foreground">{index + 1}.</span>
          {question.title}
        </CardTitle>
        <Badge variant="outline" className="shrink-0">
          max. {question.points} P.
        </Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        {answer ? (
          <AnswerDisplay
            sessionId={sessionId}
            question={question}
            answer={answer}
          />
        ) : (
          <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            Keine Antwort abgegeben
          </p>
        )}

        <SolutionHint question={question} />

        {rubric?.length ? (
          <RubricChecklist
            rubric={rubric}
            maxPoints={question.points}
            onApply={(points) =>
              onChangePoints(
                question.id,
                String(Math.min(points, question.points))
              )
            }
          />
        ) : null}

        <div className="flex flex-col gap-3 rounded-md border bg-muted/30 p-3 sm:flex-row">
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={0}
              max={question.points}
              step={0.5}
              value={draft?.points ?? ""}
              onChange={(e) => onChangePoints(question.id, e.target.value)}
              className="w-24"
              placeholder="—"
            />
            <span className="shrink-0 text-sm text-muted-foreground">
              / {question.points} P.
            </span>
            {draft?.autoGraded && (
              <span className="flex items-center gap-1">
                <Badge variant="secondary" className="gap-1">
                  <Sparkles className="h-3 w-3" />
                  Auto
                </Badge>
                <HelpTip content="Diese Punktzahl wurde automatisch vom System vergeben (z.B. bei Multiple Choice). Sie können sie jederzeit überschreiben." />
              </span>
            )}
          </div>
          <Textarea
            value={draft?.feedback ?? ""}
            onChange={(e) => onChangeFeedback(question.id, e.target.value)}
            placeholder="Feedback (optional)"
            rows={2}
            className="flex-1"
          />
        </div>
      </CardContent>
    </Card>
  )
})
