"use client"

import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import type { MCConfig } from "@/lib/types/questions"
import type { MCAnswer } from "@/lib/types/answers"

interface MCViewerProps {
  config: MCConfig
  answer?: MCAnswer
  onChange?: (answer: MCAnswer) => void
  readOnly?: boolean
}

function OptionLetter({ letter }: { letter: string }) {
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium text-muted-foreground">
      {letter}
    </span>
  )
}

export function MCViewer({
  config,
  answer,
  onChange,
  readOnly,
}: MCViewerProps) {
  const selected = answer?.selectedOptionIds ?? []

  if (config.multiSelect) {
    return (
      <div className="space-y-2">
        {config.options.map((opt, i) => (
          <label
            key={opt.id}
            className="flex cursor-pointer items-center gap-3"
          >
            <Checkbox
              checked={selected.includes(opt.id)}
              disabled={readOnly}
              onCheckedChange={(checked) => {
                if (!onChange) return
                const next = checked
                  ? [...selected, opt.id]
                  : selected.filter((id) => id !== opt.id)
                onChange({ selectedOptionIds: next })
              }}
            />
            <OptionLetter letter={String.fromCharCode(65 + i)} />
            <span className="text-sm">{opt.text}</span>
          </label>
        ))}
        <div className="flex items-center justify-between pt-1">
          <p className="text-xs text-muted-foreground">
            {selected.length} ausgewählt
          </p>
          {onChange && selected.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              type="button"
              className="h-6 text-xs"
              onClick={() => onChange({ selectedOptionIds: [] })}
            >
              Auswahl leeren
            </Button>
          )}
        </div>
      </div>
    )
  }

  return (
    <RadioGroup
      value={selected[0] ?? ""}
      disabled={readOnly}
      onValueChange={(id) => onChange?.({ selectedOptionIds: [id] })}
      className="space-y-2"
    >
      {config.options.map((opt, i) => (
        <div key={opt.id} className="flex items-center gap-3">
          <RadioGroupItem value={opt.id} id={`view-${opt.id}`} />
          <OptionLetter letter={String.fromCharCode(65 + i)} />
          <Label
            htmlFor={`view-${opt.id}`}
            className="cursor-pointer font-normal"
          >
            {opt.text}
          </Label>
        </div>
      ))}
    </RadioGroup>
  )
}
