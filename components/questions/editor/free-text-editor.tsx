"use client"

import { useState } from "react"
import { X } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { RubricEditor } from "./rubric-editor"
import { HelpTip } from "@/components/help-tip"
import type { FreeTextConfig } from "@/lib/types/questions"

interface FreeTextEditorProps {
  config: FreeTextConfig
  onChange: (config: FreeTextConfig) => void
  questionPoints: number
}

export function FreeTextEditor({
  config,
  onChange,
  questionPoints,
}: FreeTextEditorProps) {
  const [keywordInput, setKeywordInput] = useState("")

  function addKeyword(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter" && e.key !== ",") return
    e.preventDefault()
    const kw = keywordInput.trim()
    if (!kw) return
    const existing = config.expectedKeywords ?? []
    if (!existing.includes(kw)) {
      onChange({ ...config, expectedKeywords: [...existing, kw] })
    }
    setKeywordInput("")
  }

  function removeKeyword(kw: string) {
    onChange({
      ...config,
      expectedKeywords: (config.expectedKeywords ?? []).filter((k) => k !== kw),
    })
  }

  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor="maxLength">Maximale Zeichenanzahl</Label>
        <Input
          id="maxLength"
          type="number"
          min={1}
          max={10000}
          value={config.maxLength}
          onChange={(e) =>
            onChange({ ...config, maxLength: parseInt(e.target.value) || 500 })
          }
          className="mt-1"
        />
      </div>

      <div className="flex items-center justify-between">
        <Label htmlFor="richText" className="font-normal">
          Rich-Text-Formatierung erlauben
        </Label>
        <Switch
          id="richText"
          checked={config.richText}
          onCheckedChange={(richText) => onChange({ ...config, richText })}
        />
      </div>
      {config.richText && (
        <p className="-mt-2 text-xs text-muted-foreground">
          Die Zeichenbegrenzung zählt den sichtbaren Text; Formatierungs-Markup
          wird zusätzlich gespeichert. Antworten erscheinen als formatierter
          Text und erwartete Schlüsselwörter werden in der Bewertung
          hervorgehoben.
        </p>
      )}

      <div>
        <span className="flex items-center gap-1.5">
          <Label htmlFor="keywords">Erwartete Schlüsselwörter (optional)</Label>
          <HelpTip content="Freitext-Antworten werden immer von Ihnen bewertet, nicht automatisch. Diese Wörter werden beim Bewerten in der Antwort hervorgehoben, damit Sie schneller sehen, ob die wichtigen Begriffe vorkommen." />
        </span>
        <p className="mb-1 text-xs text-muted-foreground">
          Werden bei der manuellen Bewertung hervorgehoben. Enter oder Komma zum
          Hinzufügen.
        </p>
        <Input
          id="keywords"
          value={keywordInput}
          onChange={(e) => setKeywordInput(e.target.value)}
          onKeyDown={addKeyword}
          placeholder="Schlüsselwort eingeben…"
          className="mt-1"
        />
        {(config.expectedKeywords ?? []).length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {config.expectedKeywords!.map((kw) => (
              <Badge key={kw} variant="secondary" className="gap-1">
                {kw}
                <button
                  onClick={() => removeKeyword(kw)}
                  className="rounded-full hover:bg-muted"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}
      </div>

      <RubricEditor
        rubric={config.rubric}
        onChange={(rubric) => onChange({ ...config, rubric })}
        questionPoints={questionPoints}
      />
    </div>
  )
}
