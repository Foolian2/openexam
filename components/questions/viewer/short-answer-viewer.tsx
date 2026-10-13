"use client"

import { Input } from "@/components/ui/input"
import type { ShortAnswerConfig } from "@/lib/types/questions"
import type { ShortAnswerAnswer } from "@/lib/types/answers"

interface ShortAnswerViewerProps {
  // The sanitized SHORT_ANSWER config drops acceptedAnswers but keeps
  // maxLength and caseSensitive. Both shapes satisfy this prop type.
  config: Pick<ShortAnswerConfig, "maxLength">
  answer?: ShortAnswerAnswer
  onChange?: (answer: ShortAnswerAnswer) => void
  readOnly?: boolean
}

export function ShortAnswerViewer({
  config,
  answer,
  onChange,
  readOnly,
}: ShortAnswerViewerProps) {
  const value = answer?.text ?? ""
  return (
    <div>
      <Input
        value={value}
        onChange={(e) => onChange?.({ text: e.target.value })}
        maxLength={config.maxLength}
        disabled={readOnly}
        placeholder="Antwort eingeben…"
      />
      <p className="mt-1 text-right text-xs text-muted-foreground">
        {value.length} / {config.maxLength}
      </p>
    </div>
  )
}
