"use client"

import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Plus, X } from "lucide-react"
import { RubricEditor } from "./rubric-editor"
import type { ShortAnswerConfig } from "@/lib/types/questions"

interface ShortAnswerEditorProps {
  config: ShortAnswerConfig
  onChange: (config: ShortAnswerConfig) => void
  questionPoints: number
}

export function ShortAnswerEditor({
  config,
  onChange,
  questionPoints,
}: ShortAnswerEditorProps) {
  function updateAccepted(index: number, value: string) {
    onChange({
      ...config,
      acceptedAnswers: config.acceptedAnswers.map((a, i) =>
        i === index ? value : a
      ),
    })
  }

  function addAccepted() {
    onChange({ ...config, acceptedAnswers: [...config.acceptedAnswers, ""] })
  }

  function removeAccepted(index: number) {
    if (config.acceptedAnswers.length <= 1) return
    onChange({
      ...config,
      acceptedAnswers: config.acceptedAnswers.filter((_, i) => i !== index),
    })
  }

  return (
    <div className="space-y-4">
      <div>
        <Label className="text-sm font-medium">Akzeptierte Antworten</Label>
        <p className="mb-2 text-xs text-muted-foreground">
          Die Bewertung trifft zu, wenn die Antworten der Studierenden (nach
          Trim &amp; optional Gross-/Kleinschreibungs-Abgleich) mit einer dieser
          Varianten übereinstimmt.
        </p>
        <div className="space-y-2">
          {config.acceptedAnswers.map((ans, i) => (
            <div key={i} className="flex gap-1">
              <Input
                value={ans}
                onChange={(e) => updateAccepted(i, e.target.value)}
                placeholder={`Akzeptierte Antwort ${i + 1}`}
                className="flex-1"
              />
              {config.acceptedAnswers.length > 1 && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => removeAccepted(i)}
                  type="button"
                >
                  <X />
                </Button>
              )}
            </div>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={addAccepted}
          className="mt-1 h-7 text-xs"
          type="button"
        >
          <Plus />
          Variante hinzufügen
        </Button>
      </div>

      <div className="flex items-center justify-between">
        <Label htmlFor="short-cs" className="font-normal">
          Gross-/Kleinschreibung beachten
        </Label>
        <Switch
          id="short-cs"
          checked={config.caseSensitive}
          onCheckedChange={(caseSensitive) =>
            onChange({ ...config, caseSensitive })
          }
        />
      </div>

      <div>
        <Label htmlFor="short-max">Maximale Zeichenanzahl</Label>
        <Input
          id="short-max"
          type="number"
          min={1}
          max={1000}
          value={config.maxLength}
          onChange={(e) =>
            onChange({
              ...config,
              maxLength: Math.max(
                1,
                Math.min(1000, parseInt(e.target.value) || 200)
              ),
            })
          }
          className="mt-1"
        />
      </div>

      <RubricEditor
        rubric={config.rubric}
        onChange={(rubric) => onChange({ ...config, rubric })}
        questionPoints={questionPoints}
      />
    </div>
  )
}
