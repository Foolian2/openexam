"use client"

import { Textarea } from "@/components/ui/textarea"
import { RichTextEditor } from "@/components/rich-text/rich-text-editor"
import { RichTextDisplay } from "@/components/rich-text/rich-text-display"
import type { ViewerConfigByType } from "@/lib/types/questions"
import type { FreeTextAnswer } from "@/lib/types/answers"

interface FreeTextViewerProps {
  // Students get the sanitized config (no expectedKeywords); the keyword
  // highlight only exists on the teacher side.
  config: ViewerConfigByType["FREE_TEXT"]
  answer?: FreeTextAnswer
  onChange?: (answer: FreeTextAnswer) => void
  readOnly?: boolean
}

export function FreeTextViewer({
  config,
  answer,
  onChange,
  readOnly,
}: FreeTextViewerProps) {
  const value = answer?.text ?? ""

  if (config.richText) {
    if (readOnly || !onChange) {
      return (
        <RichTextDisplay
          html={value}
          keywords={
            "expectedKeywords" in config ? config.expectedKeywords : undefined
          }
          className={readOnly ? undefined : "py-2"}
        />
      )
    }
    return (
      <RichTextEditor
        value={value}
        onChange={(text) => onChange({ text })}
        maxLength={config.maxLength}
        placeholder="Antwort eingeben…"
      />
    )
  }

  return (
    <div>
      <Textarea
        value={value}
        onChange={(e) => onChange?.({ text: e.target.value })}
        maxLength={config.maxLength}
        disabled={readOnly}
        placeholder="Antwort eingeben…"
        rows={6}
      />
      <p className="mt-1 text-right text-xs text-muted-foreground">
        {value.length} / {config.maxLength}
      </p>
    </div>
  )
}
