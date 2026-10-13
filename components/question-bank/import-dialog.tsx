"use client"

import { useRef, useState } from "react"
import { toast } from "sonner"
import { FileJson, Loader2 } from "lucide-react"
import { apiMutate } from "@/lib/api-mutate"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { splitQuestionBankImport } from "@/lib/question-bank-import"

interface ImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: (count: number) => void
}

interface ImportResult {
  created: number
  failed: { index: number; error: string }[]
}

const EXAMPLE_JSON = `[
  {
    "type": "SHORT_ANSWER",
    "title": "Hauptstadt der Schweiz?",
    "points": 1,
    "required": true,
    "config": {
      "acceptedAnswers": ["Bern"],
      "caseSensitive": false,
      "maxLength": 100
    }
  }
]`

export function ImportBankDialog({
  open,
  onOpenChange,
  onImported,
}: ImportDialogProps) {
  const [value, setValue] = useState("")
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  function readFile(file: File) {
    const reader = new FileReader()
    reader.onload = () => {
      setValue(String(reader.result ?? ""))
      setResult(null)
    }
    reader.readAsText(file)
  }

  async function handleImport() {
    let items: unknown
    try {
      items = JSON.parse(value)
    } catch {
      toast.error("Ungültiges JSON")
      return
    }

    setLoading(true)
    try {
      const batches = Array.isArray(items)
        ? splitQuestionBankImport(items)
        : [items]
      const combined: ImportResult = { created: 0, failed: [] }
      let itemOffset = 0

      for (const batch of batches) {
        const result = await apiMutate<ImportResult>(
          "/api/question-bank/import",
          { body: { items: batch }, fallbackError: "Import fehlgeschlagen" }
        )
        // A rejected batch that still lists per-item failures is a partial
        // success: keep what landed and fold its failures in.
        const data = result.ok
          ? result.data
          : (result.payload as ImportResult | null)
        // The route always answers `{ created, failed }` — on the 201 and on
        // the 422 alike — so a batch that carries neither says nothing about
        // what landed. Advancing the loop past it would silently under-report
        // the import (and, for the last batch, finish with "0 erstellt, 0
        // fehlgeschlagen" and no error at all), so it aborts, whatever `ok`
        // says.
        if (!Array.isArray(data?.failed) || typeof data.created !== "number") {
          setResult(combined)
          if (combined.created > 0) onImported(combined.created)
          toast.error(result.ok ? "Import fehlgeschlagen" : result.message)
          return
        }
        combined.created += data.created
        combined.failed.push(
          ...data.failed.map((failure) => ({
            ...failure,
            index: failure.index + itemOffset,
          }))
        )
        itemOffset += Array.isArray(batch) ? batch.length : 0
      }

      setResult(combined)
      if (combined.created > 0) onImported(combined.created)
      if (combined.failed.length > 0 && combined.created === 0) {
        toast.error("Keine Fragen importiert — alle Einträge sind ungültig")
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) {
          setResult(null)
          setValue("")
        }
      }}
    >
      {/* Scrolls as a whole if the result list still overflows. */}
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Fragen importieren</DialogTitle>
          <DialogDescription>
            Importieren Sie mehrere Fragen als JSON-Array. Jeder Eintrag wird
            einzeln validiert; ungültige Einträge werden gemeldet, der Rest wird
            trotzdem angelegt.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Textarea
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              setResult(null)
            }}
            placeholder={EXAMPLE_JSON}
            rows={10}
            // The shared Textarea grows with its content (field-sizing-content).
            // Uncapped, a pasted export of a handful of questions pushed the
            // dialog past the viewport and its Importieren button off screen.
            className="max-h-[40dvh] overflow-y-auto font-mono text-xs"
            aria-label="JSON mit Fragen"
          />
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) readFile(file)
            }}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
          >
            <FileJson className="mr-2 h-4 w-4" />
            Aus Datei laden…
          </Button>

          {result && (
            <div className="space-y-2 rounded-lg border bg-muted/40 p-3 text-sm">
              <div className="flex items-center gap-2">
                <Badge variant="secondary">
                  {result.created} {result.created === 1 ? "Frage" : "Fragen"}{" "}
                  importiert
                </Badge>
                {result.failed.length > 0 && (
                  <Badge variant="destructive">
                    {result.failed.length} fehlgeschlagen
                  </Badge>
                )}
              </div>
              {result.failed.length > 0 && (
                <ul className="max-h-32 space-y-1 overflow-y-auto font-mono text-xs text-muted-foreground">
                  {result.failed.map((f) => (
                    <li key={f.index}>
                      Eintrag {f.index + 1}: {f.error}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button onClick={() => void handleImport()} disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Importieren
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
