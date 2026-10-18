"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  Eye,
  Send,
  BookOpen,
  MonitorPlay,
  StopCircle,
  Copy,
  Archive,
  ArchiveRestore,
  Printer,
  ListChecks,
  Settings2,
} from "lucide-react"
import { apiMutateToast } from "@/lib/api-mutate-toast"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
import { ExamMetadataForm, type SaveStatus } from "./exam-metadata-form"
import {
  QuestionBuilder,
  type Question,
} from "@/components/questions/question-builder"
import { ExamStatusBadge } from "./exam-status-badge"
import { ExamStatusStepper } from "./exam-status-stepper"
import { AccessCodeChip } from "./access-code-chip"
import { ResultsVisibilityControl } from "./results-visibility-control"
import { QuestionViewer } from "@/components/questions/viewer/question-viewer"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import type { CreateExamInput } from "@/lib/validators/exam"
import type { ExamStatus } from "@/generated/prisma/client"

interface ExamEditorProps {
  exam?: {
    id: string
    title: string
    description: string | null
    timeLimitMin: number
    shuffleQuestions: boolean
    shuffleOptions: boolean
    showResults: boolean
    sebRequired: boolean
    waitingRoom: boolean
    scheduledStart: string | null
    scheduledEnd: string | null
    status: ExamStatus
    accessCode: string
  }
  initialQuestions?: Question[]
}

type EditorExam = NonNullable<ExamEditorProps["exam"]>

export function ExamEditor({
  exam: initialExam,
  initialQuestions = [],
}: ExamEditorProps) {
  const router = useRouter()
  const [exam, setExam] = useState(initialExam ?? null)
  const [isSaving, setIsSaving] = useState(false)
  const [isPublishing, setIsPublishing] = useState(false)
  const [isActivating, setIsActivating] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  const [isDuplicating, setIsDuplicating] = useState(false)
  const [isArchiving, setIsArchiving] = useState(false)
  const [isUnarchiving, setIsUnarchiving] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false)
  const [activateConfirmOpen, setActivateConfirmOpen] = useState(false)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle")
  const [questions, setQuestions] = useState<Question[]>(initialQuestions)
  const mountedRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const isNew = !exam
  const isReadOnly =
    exam?.status === "ACTIVE" ||
    exam?.status === "CLOSED" ||
    exam?.status === "GRADED" ||
    exam?.status === "ARCHIVED"
  const canToggleResultsVisibility =
    exam?.status === "CLOSED" ||
    exam?.status === "GRADED" ||
    exam?.status === "ARCHIVED"

  async function handleMetadataSave(data: CreateExamInput) {
    // A queued autosave may resolve after navigating away: the request must
    // still run (the metadata form deliberately keeps it alive), but state
    // updates after teardown are noise, so gate them on the mount flag.
    if (mountedRef.current) setIsSaving(true)
    try {
      if (isNew) {
        const result = await apiMutateToast<{ exam: EditorExam }>(
          "/api/exams",
          {
            body: data,
            success: "Prüfung erstellt",
            fallbackError: "Fehler beim Erstellen",
          }
        )
        if (!result.ok) return
        if (mountedRef.current) setExam(result.data.exam)
        router.replace(`/dashboard/teacher/exams/${result.data.exam.id}/edit`)
      } else {
        const result = await apiMutateToast<{ exam: EditorExam }>(
          `/api/exams/${exam.id}`,
          {
            method: "PATCH",
            body: data,
            success: "Prüfung gespeichert",
            fallbackError: "Fehler beim Speichern",
          }
        )
        if (!result.ok) throw new Error(result.message)
        if (mountedRef.current) setExam(result.data.exam)
      }
    } finally {
      if (mountedRef.current) setIsSaving(false)
    }
  }

  async function handlePublish() {
    if (!exam) return
    setIsPublishing(true)
    try {
      const result = await apiMutateToast<{ exam: EditorExam }>(
        `/api/exams/${exam.id}/publish`,
        {
          success: (d) =>
            "Prüfung veröffentlicht! Zugangscode: " + d.exam.accessCode,
          fallbackError: "Fehler beim Veröffentlichen",
        }
      )
      if (result.ok) setExam(result.data.exam)
    } finally {
      setIsPublishing(false)
    }
  }

  async function handleActivate() {
    if (!exam) return
    setIsActivating(true)
    try {
      const result = await apiMutateToast<{
        exam: EditorExam
        startedWaiting: number
      }>(`/api/exams/${exam.id}/activate`, {
        success: (d) =>
          d.startedWaiting > 0
            ? `Prüfung gestartet — ${d.startedWaiting} aus dem Warteraum beginnen in 10 Sekunden`
            : "Prüfung aktiviert",
        fallbackError: "Fehler beim Aktivieren",
      })
      if (result.ok) setExam(result.data.exam)
    } finally {
      setIsActivating(false)
    }
  }

  async function handleClose() {
    if (!exam) return
    setIsClosing(true)
    try {
      const result = await apiMutateToast<{
        exam: EditorExam
        forcedSubmissions: number
      }>(`/api/exams/${exam.id}/close`, {
        success: (d) =>
          d.forcedSubmissions > 0
            ? `Prüfung beendet — ${d.forcedSubmissions} offene Sitzung(en) automatisch abgegeben`
            : "Prüfung beendet",
        fallbackError: "Fehler beim Beenden",
      })
      if (result.ok) setExam(result.data.exam)
    } finally {
      setIsClosing(false)
    }
  }

  async function handleDuplicate() {
    if (!exam) return
    setIsDuplicating(true)
    try {
      const result = await apiMutateToast<{ exam: { id: string } }>(
        `/api/exams/${exam.id}/duplicate`,
        {
          success: "Prüfung dupliziert",
          fallbackError: "Fehler beim Duplizieren",
        }
      )
      if (result.ok)
        router.push(`/dashboard/teacher/exams/${result.data.exam.id}/edit`)
    } finally {
      setIsDuplicating(false)
    }
  }

  async function handleArchive() {
    if (!exam) return
    setIsArchiving(true)
    try {
      const result = await apiMutateToast<{ exam: EditorExam }>(
        `/api/exams/${exam.id}/archive`,
        {
          success: "Prüfung archiviert",
          fallbackError: "Fehler beim Archivieren",
        }
      )
      if (result.ok) setExam(result.data.exam)
    } finally {
      setIsArchiving(false)
    }
  }

  async function handleUnarchive() {
    if (!exam) return
    setIsUnarchiving(true)
    try {
      const result = await apiMutateToast<{ exam: EditorExam }>(
        `/api/exams/${exam.id}/archive`,
        {
          method: "DELETE",
          success: "Archivierung aufgehoben",
          fallbackError: "Fehler beim Wiederherstellen",
        }
      )
      if (result.ok) setExam(result.data.exam)
    } finally {
      setIsUnarchiving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">
            {isNew ? "Neue Prüfung" : exam.title}
          </h1>
          {exam && (
            <div className="flex items-center gap-3">
              <ExamStatusBadge status={exam.status} />
              {(exam.status === "PUBLISHED" || exam.status === "ACTIVE") && (
                <AccessCodeChip code={exam.accessCode} />
              )}
              {!isReadOnly && saveStatus !== "idle" && (
                <span
                  role="status"
                  aria-live="polite"
                  data-testid="metadata-save-status"
                  className="text-xs text-muted-foreground"
                >
                  {saveStatus === "saving" && "Wird gespeichert…"}
                  {saveStatus === "saved" && "Gespeichert"}
                  {saveStatus === "error" && "Fehler beim Speichern"}
                </span>
              )}
            </div>
          )}
          {exam && (
            <div className="pt-1">
              <ExamStatusStepper status={exam.status} />
            </div>
          )}
        </div>

        <div className="flex gap-2">
          {exam && (
            <Button variant="outline" onClick={() => setPreviewOpen(true)}>
              <Eye />
              Vorschau
            </Button>
          )}
          {exam && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <Printer className="mr-1.5 h-4 w-4" />
                  Drucken
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() =>
                    window.open(
                      `/api/exams/${exam.id}/print`,
                      "_blank",
                      "noopener,noreferrer"
                    )
                  }
                >
                  Prüfung & Abgaben (ohne Lösungen)
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() =>
                    window.open(
                      `/api/exams/${exam.id}/print?solutions=1`,
                      "_blank",
                      "noopener,noreferrer"
                    )
                  }
                >
                  Prüfung & Abgaben (mit Lösungen)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {exam && isReadOnly && (
            <Button
              variant="outline"
              onClick={handleDuplicate}
              disabled={isDuplicating}
            >
              <Copy />
              {isDuplicating ? "…" : "Duplizieren"}
            </Button>
          )}
          {exam?.status === "DRAFT" && (
            <div className="flex flex-col items-end gap-1">
              <Button
                onClick={handlePublish}
                disabled={isPublishing || questions.length === 0}
                title={
                  questions.length === 0
                    ? "Fügen Sie zuerst mindestens eine Frage hinzu"
                    : undefined
                }
              >
                <Send />
                {isPublishing ? "…" : "Veröffentlichen"}
              </Button>
              <p className="max-w-[220px] text-right text-xs text-muted-foreground">
                {questions.length === 0
                  ? "Fügen Sie mindestens eine Frage hinzu, um zu veröffentlichen."
                  : "Erzeugt den Zugangscode. Für Teilnehmende sichtbar erst nach „Starten“."}
              </p>
            </div>
          )}
          {exam?.status === "PUBLISHED" && exam.waitingRoom && (
            <Button asChild variant="outline">
              <Link href={`/dashboard/teacher/monitor/${exam.id}`}>
                <MonitorPlay />
                Warteraum
              </Link>
            </Button>
          )}
          {exam?.status === "PUBLISHED" && (
            <div className="flex flex-col items-end gap-1">
              <Button
                onClick={() => setActivateConfirmOpen(true)}
                disabled={isActivating}
                className="bg-success text-success-foreground hover:bg-success/90"
              >
                <BookOpen />
                {isActivating ? "…" : "Starten"}
              </Button>
              <p className="max-w-[220px] text-right text-xs text-muted-foreground">
                {exam.waitingRoom
                  ? "Startet die Prüfung für alle im Warteraum gleichzeitig."
                  : "Macht die Prüfung sofort für Teilnehmende zugänglich."}
              </p>
            </div>
          )}
          {exam?.status === "ACTIVE" && (
            <>
              <Button asChild variant="outline">
                <Link href={`/dashboard/teacher/monitor/${exam.id}`}>
                  <MonitorPlay />
                  Live-Monitor
                </Link>
              </Button>
              <Button
                variant="destructive"
                onClick={() => setCloseConfirmOpen(true)}
                disabled={isClosing}
              >
                <StopCircle />
                {isClosing ? "…" : "Beenden"}
              </Button>
            </>
          )}
          {(exam?.status === "CLOSED" || exam?.status === "GRADED") && (
            <Button
              variant="outline"
              onClick={handleArchive}
              disabled={isArchiving}
            >
              <Archive />
              {isArchiving ? "…" : "Archivieren"}
            </Button>
          )}
          {exam?.status === "ARCHIVED" && (
            <Button
              variant="outline"
              onClick={handleUnarchive}
              disabled={isUnarchiving}
            >
              <ArchiveRestore />
              {isUnarchiving ? "…" : "Archivierung aufheben"}
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Prüfungseinstellungen</CardTitle>
            </CardHeader>
            <CardContent>
              {isReadOnly ? (
                <div className="space-y-4">
                  <p className="text-sm text-muted-foreground">
                    Aktive/abgeschlossene Prüfungen können nicht bearbeitet
                    werden.
                  </p>
                  {canToggleResultsVisibility && (
                    <div className="space-y-2 rounded-lg border p-3">
                      <p className="text-sm font-medium">
                        Ergebnis-Sichtbarkeit
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Schüler:innen mit bewerteten Antworten sehen ihre
                        Punktzahl im Dashboard, sobald die Ergebnisse
                        veröffentlicht sind.
                      </p>
                      <ResultsVisibilityControl
                        examId={exam.id}
                        initialShowResults={exam.showResults}
                        examStatus={exam.status}
                        onChange={(showResults) =>
                          setExam((prev) =>
                            prev ? { ...prev, showResults } : prev
                          )
                        }
                      />
                    </div>
                  )}
                </div>
              ) : (
                <ExamMetadataForm
                  hasFileUploadQuestions={questions.some(
                    (question) => question.type === "FILE_UPLOAD"
                  )}
                  defaultValues={
                    exam
                      ? {
                          title: exam.title,
                          description: exam.description ?? undefined,
                          timeLimitMin: exam.timeLimitMin,
                          shuffleQuestions: exam.shuffleQuestions,
                          shuffleOptions: exam.shuffleOptions,
                          showResults: exam.showResults,
                          sebRequired: exam.sebRequired,
                          waitingRoom: exam.waitingRoom,
                          scheduledStart: exam.scheduledStart ?? undefined,
                          scheduledEnd: exam.scheduledEnd ?? undefined,
                        }
                      : undefined
                  }
                  onSubmit={handleMetadataSave}
                  isLoading={isSaving}
                  autosave={!isNew}
                  onStatusChange={setSaveStatus}
                  submitLabel={
                    isNew ? "Prüfung erstellen" : "Änderungen speichern"
                  }
                />
              )}
            </CardContent>
          </Card>
        </div>

        <div className="lg:col-span-3">
          <Card>
            <CardHeader className="flex flex-row items-baseline justify-between space-y-0">
              <CardTitle>Fragen</CardTitle>
              {questions.length > 0 && (
                <p className="text-sm text-muted-foreground">
                  {questions.length} Fragen ·{" "}
                  {questions.reduce((sum, q) => sum + q.points, 0)} Punkte
                </p>
              )}
            </CardHeader>
            <CardContent>
              {!exam ? (
                <Empty className="border border-dashed">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Settings2 />
                    </EmptyMedia>
                    <EmptyTitle>Zuerst Prüfung anlegen</EmptyTitle>
                    <EmptyDescription>
                      Speichern Sie links Titel und Einstellungen — danach
                      können Sie hier Fragen hinzufügen.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <QuestionBuilder
                  examId={exam.id}
                  sebRequired={exam.sebRequired}
                  questions={questions}
                  onQuestionsChange={setQuestions}
                  disabled={isReadOnly}
                />
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Vorschau: {exam?.title}</DialogTitle>
            <DialogDescription>
              So wird die Prüfung für Teilnehmende angezeigt.
            </DialogDescription>
          </DialogHeader>
          {questions.length === 0 ? (
            <Empty className="border border-dashed">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ListChecks />
                </EmptyMedia>
                <EmptyTitle>Noch keine Fragen</EmptyTitle>
                <EmptyDescription>
                  Sobald Sie Fragen hinzugefügt haben, sehen Sie hier die
                  Vorschau, wie die Prüfung für Teilnehmende aussieht.
                </EmptyDescription>
              </EmptyHeader>
              <Button variant="outline" onClick={() => setPreviewOpen(false)}>
                Fragen hinzufügen
              </Button>
            </Empty>
          ) : (
            <div className="space-y-4">
              {questions.map((q, index) => (
                <Card key={q.id}>
                  <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
                    <CardTitle className="text-base leading-relaxed font-medium">
                      <span className="mr-2 text-muted-foreground">
                        {index + 1}.
                      </span>
                      {q.title}
                      {q.required && " *"}
                    </CardTitle>
                    <Badge variant="outline" className="shrink-0">
                      {q.points} P.
                    </Badge>
                  </CardHeader>
                  <CardContent>
                    <QuestionViewer question={q} readOnly />
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={closeConfirmOpen} onOpenChange={setCloseConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Prüfung beenden?</AlertDialogTitle>
            <AlertDialogDescription>
              Alle offenen Sitzungen werden automatisch abgegeben. Dies kann
              nicht rückgängig gemacht werden.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                setCloseConfirmOpen(false)
                void handleClose()
              }}
            >
              Beenden
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={activateConfirmOpen}
        onOpenChange={setActivateConfirmOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Prüfung starten?</AlertDialogTitle>
            <AlertDialogDescription>
              {exam?.waitingRoom
                ? "Alle im Warteraum beginnen nach einem Countdown von 10 Sekunden gleichzeitig und erhalten die volle Dauer. Wer später beitritt, erhält die volle Dauer ab dem eigenen Beitritt. Die Prüfung kann danach nicht mehr bearbeitet werden."
                : "Die Prüfung wird sofort für Teilnehmende mit dem Zugangscode zugänglich und kann danach nicht mehr bearbeitet werden."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              className="bg-success text-success-foreground hover:bg-success/90"
              onClick={() => {
                setActivateConfirmOpen(false)
                void handleActivate()
              }}
            >
              Starten
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
