"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { CheckCircle2, Circle, ListChecks, X } from "lucide-react"
import { apiMutateToast } from "@/lib/api-mutate-toast"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { NewExamDialog } from "@/components/exams/new-exam-dialog"
import type {
  OnboardingActionExamIds,
  OnboardingStep,
  OnboardingStepId,
} from "@/lib/onboarding"

interface StepCopy {
  label: string
  description: string
}

const STEP_COPY: Record<OnboardingStepId, StepCopy> = {
  "create-exam": {
    label: "Prüfung erstellen",
    description:
      "Legen Sie mit «Neue Prüfung» eine erste Prüfung an. Den Titel können Sie später jederzeit ändern.",
  },
  "add-questions": {
    label: "Fragen hinzufügen",
    description:
      "Öffnen Sie die Prüfung und fügen Sie Fragen hinzu, z.B. Multiple Choice oder Freitext.",
  },
  publish: {
    label: "Prüfung veröffentlichen",
    description:
      "Beim Veröffentlichen wird der Zugangscode erzeugt, mit dem sich Ihre Schülerinnen und Schüler anmelden.",
  },
  activate: {
    label: "Prüfung starten",
    description:
      "Mit «Starten» wird die Prüfung sichtbar und die Teilnehmenden können beitreten.",
  },
  grade: {
    label: "Ergebnisse einsehen und bewerten",
    description:
      "Nach der Prüfung finden Sie unter «Bewertung» alle Ergebnisse und können Noten setzen.",
  },
}

async function setDismissed(dismissed: boolean): Promise<boolean> {
  const result = await apiMutateToast("/api/teacher/onboarding", {
    method: "PATCH",
    body: { dismissed },
    fallbackError: "Fehler beim Speichern",
    networkError: "Verbindungsfehler. Bitte versuchen Sie es erneut.",
  })
  return result.ok
}

interface OnboardingChecklistProps {
  steps: OnboardingStep[]
  actionExamIds: OnboardingActionExamIds
}

export function OnboardingChecklist({
  steps,
  actionExamIds,
}: OnboardingChecklistProps) {
  const router = useRouter()
  const [isSaving, setIsSaving] = useState(false)

  const doneCount = steps.filter((s) => s.done).length
  async function handleDismiss() {
    setIsSaving(true)
    const ok = await setDismissed(true)
    if (ok) router.refresh()
    else setIsSaving(false)
  }

  function renderAction(id: OnboardingStepId) {
    if (id === "create-exam") {
      return (
        <NewExamDialog triggerLabel="Prüfung erstellen" variant="outline" />
      )
    }
    if (id === "grade") {
      return (
        <Button asChild variant="outline">
          <Link href="/dashboard/teacher/grades">Zur Bewertung</Link>
        </Button>
      )
    }
    const examId = actionExamIds[id]
    if (!examId) return null
    return (
      <Button asChild variant="outline">
        <Link href={`/dashboard/teacher/exams/${examId}/edit`}>
          Prüfung öffnen
        </Link>
      </Button>
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-2">
            <ListChecks className="size-5 text-primary" aria-hidden />
            <div>
              <CardTitle className="text-lg">
                <h2 className="contents">Erste Schritte</h2>
              </CardTitle>
              <CardDescription>
                So erstellen Sie Ihre erste Prüfung in wenigen Schritten.
              </CardDescription>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Anleitung ausblenden"
            onClick={() => void handleDismiss()}
            disabled={isSaving}
          >
            <X aria-hidden />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ol className="flex flex-col gap-3">
          {steps.map((step) => {
            const copy = STEP_COPY[step.id]
            return (
              <li
                key={step.id}
                className="flex flex-wrap items-center justify-between gap-3"
                data-testid={`onboarding-step-${step.id}`}
                data-done={step.done}
              >
                <div className="flex min-w-0 items-start gap-3">
                  {step.done ? (
                    <CheckCircle2
                      className="mt-0.5 size-5 shrink-0 text-primary"
                      aria-hidden
                    />
                  ) : (
                    <Circle
                      className="mt-0.5 size-5 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                  )}
                  <div className="min-w-0">
                    <p
                      className={
                        step.done
                          ? "text-sm font-medium text-muted-foreground line-through"
                          : "text-sm font-medium"
                      }
                    >
                      {copy.label}
                    </p>
                    {!step.done && (
                      <p className="text-sm text-muted-foreground">
                        {copy.description}
                      </p>
                    )}
                  </div>
                </div>
                {!step.done && renderAction(step.id)}
              </li>
            )
          })}
        </ol>
        <div className="flex flex-col gap-2">
          <Progress
            aria-labelledby="onboarding-progress-label"
            value={(doneCount / steps.length) * 100}
          />
          <div className="flex items-center justify-between">
            <p
              id="onboarding-progress-label"
              className="text-sm text-muted-foreground"
            >
              {doneCount} von {steps.length} Schritten erledigt
            </p>
            <button
              type="button"
              className="text-sm text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => void handleDismiss()}
              disabled={isSaving}
            >
              Anleitung ausblenden
            </button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

interface OnboardingShowButtonProps {
  initialDismissed: boolean
}

export function OnboardingShowButton({
  initialDismissed,
}: OnboardingShowButtonProps) {
  const router = useRouter()
  const [isSaving, setIsSaving] = useState(false)

  if (!initialDismissed) return null

  async function handleShow() {
    setIsSaving(true)
    const ok = await setDismissed(false)
    if (ok) router.refresh()
    else setIsSaving(false)
  }

  return (
    <Button
      variant="ghost"
      onClick={() => void handleShow()}
      disabled={isSaving}
    >
      <ListChecks data-icon="inline-start" />
      Erste Schritte
    </Button>
  )
}
