"use client"

import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Label } from "@/components/ui/label"
import type { TrueFalseConfig } from "@/lib/types/questions"

interface TrueFalseEditorProps {
  config: TrueFalseConfig
  onChange: (config: TrueFalseConfig) => void
}

export function TrueFalseEditor({ config, onChange }: TrueFalseEditorProps) {
  return (
    <div className="space-y-3">
      <Label className="text-sm font-medium">Korrekte Antwort</Label>
      <p className="text-xs text-muted-foreground">
        Wählen Sie, ob die Aussage der Frage wahr oder falsch ist.
      </p>
      <RadioGroup
        value={config.isCorrect ? "true" : "false"}
        onValueChange={(v) => onChange({ isCorrect: v === "true" })}
        className="space-y-2"
      >
        <div className="flex items-center gap-3">
          <RadioGroupItem value="true" id="tf-true" />
          <Label htmlFor="tf-true" className="font-normal cursor-pointer">
            Wahr
          </Label>
        </div>
        <div className="flex items-center gap-3">
          <RadioGroupItem value="false" id="tf-false" />
          <Label htmlFor="tf-false" className="font-normal cursor-pointer">
            Falsch
          </Label>
        </div>
      </RadioGroup>
    </div>
  )
}