"use client"

import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Label } from "@/components/ui/label"
import type { TrueFalseAnswer } from "@/lib/types/answers"

interface TrueFalseViewerProps {
  // The sanitized TRUE_FALSE config is `{}` (no solution state); the raw
  // config is read-only on the teacher side but the viewer renders the
  // same way either way. Accept any object shape and ignore it.
  config?: unknown
  answer?: TrueFalseAnswer
  onChange?: (answer: TrueFalseAnswer) => void
  readOnly?: boolean
  // Prefix for the radio input ids. Several true/false questions can
  // render on one page (exam runner, results), so a fixed id would
  // collide and break label-to-radio association.
  idPrefix?: string
}

export function TrueFalseViewer({
  answer,
  onChange,
  readOnly,
  idPrefix = "tf-view-",
}: TrueFalseViewerProps) {
  const value = answer ? (answer.selected ? "true" : "false") : ""
  return (
    <RadioGroup
      value={value}
      disabled={readOnly}
      onValueChange={(v) => onChange?.({ selected: v === "true" })}
      className="space-y-2"
    >
      <div className="flex items-center gap-3">
        <RadioGroupItem value="true" id={`${idPrefix}true`} />
        <Label
          htmlFor={`${idPrefix}true`}
          className="cursor-pointer font-normal"
        >
          Wahr
        </Label>
      </div>
      <div className="flex items-center gap-3">
        <RadioGroupItem value="false" id={`${idPrefix}false`} />
        <Label
          htmlFor={`${idPrefix}false`}
          className="cursor-pointer font-normal"
        >
          Falsch
        </Label>
      </div>
    </RadioGroup>
  )
}
