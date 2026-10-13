"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { CheckCheck, Loader2 } from "lucide-react"
import { apiMutate } from "@/lib/api-mutate"
import { apiMutateToast } from "@/lib/api-mutate-toast"
import { Button } from "@/components/ui/button"
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

export function MarkGradedButton({
  examId,
  showResults,
  incompleteCount,
  submittedCount,
}: {
  examId: string
  showResults: boolean
  /** Submissions that still have an ungraded question. */
  incompleteCount: number
  submittedCount: number
}) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  async function publishResults() {
    const result = await apiMutateToast(`/api/exams/${examId}/show-results`, {
      method: "PATCH",
      body: { showResults: true },
      success: "Ergebnisse sind jetzt für Schüler:innen sichtbar",
      fallbackError: "Fehler beim Speichern",
    })
    if (result.ok) router.refresh()
  }

  async function handleConfirm() {
    setLoading(true)
    try {
      // Kept on apiMutate rather than apiMutateToast: the success toast
      // carries a description and an action button, beyond a plain message.
      const result = await apiMutate(`/api/exams/${examId}/mark-graded`, {
        fallbackError: "Aktion fehlgeschlagen",
      })
      if (!result.ok) {
        toast.error(result.message)
        return
      }
      if (showResults) {
        toast.success("Prüfung als bewertet markiert")
      } else {
        toast.success("Prüfung als bewertet markiert", {
          description: "Die Ergebnisse sind für Schüler:innen noch verborgen.",
          action: {
            label: "Jetzt veröffentlichen",
            onClick: () => void publishResults(),
          },
        })
      }
      router.refresh()
    } finally {
      setLoading(false)
    }
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button disabled={loading}>
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <CheckCheck className="h-4 w-4" />
          )}
          Als bewertet markieren
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Prüfung als bewertet markieren?</AlertDialogTitle>
          <AlertDialogDescription>
            {showResults
              ? "Schüler:innen sehen ihre Ergebnisse sofort, da die Ergebnis-Freigabe bereits aktiv ist."
              : "Die Ergebnis-Freigabe ist derzeit deaktiviert — Schüler:innen sehen ihre Punktzahl erst, wenn du sie danach explizit veröffentlichst."}
          </AlertDialogDescription>
          {incompleteCount > 0 && (
            // Marking graded doesn't require every answer to be graded, and
            // students then see "—" for open questions and a total without
            // them. Nothing in the dialog said so.
            <p
              role="alert"
              className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm"
            >
              {incompleteCount} von {submittedCount}{" "}
              {submittedCount === 1 ? "Abgabe ist" : "Abgaben sind"} noch nicht
              vollständig bewertet. Unbewertete Fragen erscheinen bei den
              Schüler:innen als «—» und fehlen in ihrer Gesamtpunktzahl. Mit
              «Unbewertete auf 0 setzen» in der Tabelle kannst du sie gesammelt
              abschliessen.
            </p>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Abbrechen</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm}>
            Als bewertet markieren
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
