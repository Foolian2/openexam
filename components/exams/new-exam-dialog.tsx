"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Plus } from "lucide-react"
import { apiMutateToast } from "@/lib/api-mutate-toast"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

interface NewExamDialogProps {
  triggerLabel?: string
  variant?: "default" | "outline"
}

export function NewExamDialog({
  triggerLabel = "Neue Prüfung",
  variant = "default",
}: NewExamDialogProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState("")
  const [timeLimitMin, setTimeLimitMin] = useState(60)
  const [isCreating, setIsCreating] = useState(false)

  const durationValid =
    Number.isInteger(timeLimitMin) && timeLimitMin >= 1 && timeLimitMin <= 600

  async function handleCreate() {
    if (!title.trim() || !durationValid) return
    setIsCreating(true)
    try {
      const result = await apiMutateToast<{ exam: { id: string } }>(
        "/api/exams",
        {
          body: { title: title.trim(), timeLimitMin },
          fallbackError: "Fehler beim Erstellen",
        }
      )
      if (!result.ok) return
      setOpen(false)
      setTitle("")
      setTimeLimitMin(60)
      router.push(`/dashboard/teacher/exams/${result.data.exam.id}/edit`)
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !isCreating && setOpen(next)}>
      <DialogTrigger asChild>
        <Button variant={variant}>
          <Plus data-icon="inline-start" />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Neue Prüfung</DialogTitle>
          <DialogDescription>
            Geben Sie einen Titel ein, um zu beginnen. Alle weiteren
            Einstellungen können Sie danach anpassen.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="new-exam-title">Titel *</Label>
            <Input
              id="new-exam-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="z.B. Mathematik Abschlussprüfung"
              maxLength={200}
              className="mt-1"
              autoFocus
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !isCreating &&
                  title.trim() &&
                  durationValid
                ) {
                  e.preventDefault()
                  void handleCreate()
                }
              }}
            />
          </div>
          <div>
            <Label htmlFor="new-exam-duration">Dauer (Minuten) *</Label>
            <Input
              id="new-exam-duration"
              type="number"
              min={1}
              max={600}
              value={timeLimitMin}
              onChange={(e) => setTimeLimitMin(Number(e.target.value))}
              aria-invalid={!durationValid}
              className="mt-1"
            />
            {!durationValid && (
              <p className="mt-1 text-xs text-destructive">
                Dauer muss zwischen 1 und 600 Minuten liegen
              </p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={isCreating}
          >
            Abbrechen
          </Button>
          <Button
            onClick={handleCreate}
            disabled={isCreating || !title.trim() || !durationValid}
          >
            {isCreating ? "Wird erstellt…" : "Prüfung erstellen"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
