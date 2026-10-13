"use client"

import { useState } from "react"
import { Eye, EyeOff, Loader2 } from "lucide-react"
import { apiMutateToast } from "@/lib/api-mutate-toast"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"

interface ResultsVisibilityControlProps {
  examId: string
  initialShowResults: boolean
  /** Students only see released results once the exam is GRADED/ARCHIVED. */
  examStatus: string
  onChange?: (showResults: boolean) => void
}

/**
 * Explicit publish/hide control for exam results, shown once an exam is
 * CLOSED/GRADED/ARCHIVED. Publishing is a broadcast to the whole class, so
 * it requires confirmation; hiding again is the low-risk direction and
 * applies immediately.
 *
 * Releasing on a CLOSED exam is allowed but takes effect only once the exam is
 * marked as graded (the student dashboard and results page require
 * GRADED/ARCHIVED), so the texts say so instead of promising "ab sofort".
 */
export function ResultsVisibilityControl({
  examId,
  initialShowResults,
  examStatus,
  onChange,
}: ResultsVisibilityControlProps) {
  const waitsForGrading = examStatus !== "GRADED" && examStatus !== "ARCHIVED"
  const [showResults, setShowResults] = useState(initialShowResults)
  const [isLoading, setIsLoading] = useState(false)

  async function setVisibility(next: boolean) {
    setIsLoading(true)
    try {
      const result = await apiMutateToast(`/api/exams/${examId}/show-results`, {
        method: "PATCH",
        body: { showResults: next },
        success: next
          ? waitsForGrading
            ? "Ergebnisse freigegeben – sichtbar, sobald die Prüfung als bewertet markiert ist"
            : "Ergebnisse sind jetzt für Schüler:innen sichtbar"
          : "Ergebnisse sind jetzt verborgen",
        fallbackError: "Fehler beim Speichern",
      })
      if (!result.ok) return
      setShowResults(next)
      onChange?.(next)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge
        variant={showResults ? "default" : "secondary"}
        className={showResults ? "bg-success text-success-foreground" : ""}
      >
        {showResults ? (
          <Eye data-icon="inline-start" />
        ) : (
          <EyeOff data-icon="inline-start" />
        )}
        {showResults
          ? waitsForGrading
            ? "Freigegeben – sichtbar nach Bewertung"
            : "Ergebnisse öffentlich"
          : "Ergebnisse nicht sichtbar"}
      </Badge>

      {showResults ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isLoading}
          onClick={() => setVisibility(false)}
        >
          {isLoading ? <Loader2 className="animate-spin" /> : <EyeOff />}
          Verbergen
        </Button>
      ) : (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button type="button" size="sm" disabled={isLoading}>
              {isLoading ? <Loader2 className="animate-spin" /> : <Eye />}
              Ergebnisse veröffentlichen
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Ergebnisse für alle Schüler:innen freigeben?
              </AlertDialogTitle>
              <AlertDialogDescription>
                {waitsForGrading
                  ? "Die Schüler:innen sehen ihre Punktzahl im Dashboard, sobald du die Prüfung als bewertet markierst."
                  : "Alle Schüler:innen mit bewerteten Antworten sehen ab sofort ihre Punktzahl im Dashboard."}{" "}
                Du kannst die Freigabe jederzeit wieder zurücknehmen.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Abbrechen</AlertDialogCancel>
              <AlertDialogAction onClick={() => setVisibility(true)}>
                Veröffentlichen
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  )
}
