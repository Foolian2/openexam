"use client"

import { useEffect } from "react"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Plus, X } from "lucide-react"
import { HelpTip } from "@/components/help-tip"
import type { FillBlankConfig } from "@/lib/types/questions"
import { nextBlankId, parseBlankIds } from "@/lib/fill-blank-template"

interface FillBlankEditorProps {
  config: FillBlankConfig
  onChange: (config: FillBlankConfig) => void
}

export function FillBlankEditor({ config, onChange }: FillBlankEditorProps) {
  useEffect(() => {
    const ids = parseBlankIds(config.template)
    const existingIds = config.blanks.map((b) => b.id)
    if (JSON.stringify(ids) === JSON.stringify(existingIds)) return

    const updated = ids.map((id) => {
      const existing = config.blanks.find((b) => b.id === id)
      return existing ?? { id, acceptedAnswers: [""], caseSensitive: false }
    })
    onChange({ ...config, blanks: updated })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.template])

  function insertBlank() {
    onChange({
      ...config,
      template: config.template + ` {${nextBlankId(config.template)}}`,
    })
  }

  function updateAcceptedAnswer(blankId: string, index: number, value: string) {
    onChange({
      ...config,
      blanks: config.blanks.map((b) =>
        b.id === blankId
          ? {
              ...b,
              acceptedAnswers: b.acceptedAnswers.map((a, i) =>
                i === index ? value : a
              ),
            }
          : b
      ),
    })
  }

  function addAcceptedAnswer(blankId: string) {
    onChange({
      ...config,
      blanks: config.blanks.map((b) =>
        b.id === blankId
          ? { ...b, acceptedAnswers: [...b.acceptedAnswers, ""] }
          : b
      ),
    })
  }

  function removeAcceptedAnswer(blankId: string, index: number) {
    onChange({
      ...config,
      blanks: config.blanks.map((b) =>
        b.id === blankId
          ? {
              ...b,
              acceptedAnswers: b.acceptedAnswers.filter((_, i) => i !== index),
            }
          : b
      ),
    })
  }

  function setCaseSensitive(blankId: string, caseSensitive: boolean) {
    onChange({
      ...config,
      blanks: config.blanks.map((b) =>
        b.id === blankId ? { ...b, caseSensitive } : b
      ),
    })
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1 flex items-center justify-between">
          <Label>Vorlage</Label>
          <Button
            variant="outline"
            size="sm"
            onClick={insertBlank}
            type="button"
          >
            <Plus />
            Lücke einfügen
          </Button>
        </div>
        <Textarea
          value={config.template}
          onChange={(e) => onChange({ ...config, template: e.target.value })}
          placeholder='z.B. "Die Hauptstadt der Schweiz ist {1} und liegt im Kanton {2}."'
          rows={4}
        />
        <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
          Lücken mit {"{1}"}, {"{2}"} usw. markieren
          <HelpTip content="Schreiben Sie {1}, {2} usw. direkt in den Text, dort wo die Teilnehmenden etwas einfügen sollen. Für jede Nummer können Sie unten die akzeptierten Antworten festlegen." />
        </p>
      </div>

      {config.blanks.length > 0 && (
        <div className="space-y-4">
          <Label>Lücken konfigurieren</Label>
          {config.blanks.map((blank) => (
            <div key={blank.id} className="space-y-2 rounded-lg border p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Lücke {blank.id}</span>
                <div className="flex items-center gap-2">
                  <Label
                    htmlFor={`cs-${blank.id}`}
                    className="text-xs font-normal"
                  >
                    Gross-/Kleinschreibung
                  </Label>
                  <HelpTip content="Wenn aktiviert, muss die Antwort exakt gross- bzw. kleingeschrieben werden. Standard: deaktiviert — dann zählt nur der Inhalt." />
                  <Switch
                    id={`cs-${blank.id}`}
                    checked={blank.caseSensitive}
                    onCheckedChange={(v) => setCaseSensitive(blank.id, v)}
                  />
                </div>
              </div>
              <div className="space-y-1">
                {blank.acceptedAnswers.map((ans, i) => (
                  <div key={i} className="flex gap-1">
                    <Input
                      value={ans}
                      onChange={(e) =>
                        updateAcceptedAnswer(blank.id, i, e.target.value)
                      }
                      placeholder={`Akzeptierte Antwort ${i + 1}`}
                      className="flex-1"
                    />
                    {blank.acceptedAnswers.length > 1 && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => removeAcceptedAnswer(blank.id, i)}
                      >
                        <X />
                      </Button>
                    )}
                  </div>
                ))}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => addAcceptedAnswer(blank.id)}
                  className="h-7 text-xs"
                >
                  <Plus />
                  Variante hinzufügen
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
