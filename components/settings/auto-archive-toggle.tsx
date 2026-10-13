"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { apiMutateToast } from "@/lib/api-mutate-toast"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"

interface AutoArchiveToggleProps {
  initialEnabled: boolean
}

export function AutoArchiveToggle({ initialEnabled }: AutoArchiveToggleProps) {
  const router = useRouter()
  const [enabled, setEnabled] = useState(initialEnabled)
  const [isSaving, setIsSaving] = useState(false)

  async function handleChange(checked: boolean) {
    setIsSaving(true)
    setEnabled(checked)
    try {
      const result = await apiMutateToast("/api/teacher/auto-archive", {
        method: "PATCH",
        body: { enabled: checked },
        success: checked
          ? "Automatische Archivierung aktiviert"
          : "Automatische Archivierung deaktiviert",
        fallbackError: "Fehler beim Speichern",
        networkError: "Verbindungsfehler. Bitte versuchen Sie es erneut.",
      })
      // The switch flipped optimistically above; put it back if the write
      // did not land, whatever the reason.
      if (!result.ok) {
        setEnabled(!checked)
        return
      }
      router.refresh()
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex flex-col gap-1">
        <Label htmlFor="auto-archive-toggle" className="text-sm font-medium">
          Prüfungen älter als 30 Tage automatisch archivieren
        </Label>
        <p className="text-sm text-muted-foreground">
          Beendete und bewertete Prüfungen, die seit 30 Tagen nicht mehr
          aktualisiert wurden, werden beim Öffnen der Prüfungsverwaltung
          automatisch archiviert.
        </p>
      </div>
      <Switch
        id="auto-archive-toggle"
        checked={enabled}
        disabled={isSaving}
        onCheckedChange={(checked) => void handleChange(checked)}
      />
    </div>
  )
}
