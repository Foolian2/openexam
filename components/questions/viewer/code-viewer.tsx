"use client"

import { CodeInput } from "@/components/shared/code-input"
import type { CodeConfig } from "@/lib/types/questions"
import type { CodeAnswer } from "@/lib/types/answers"

interface CodeViewerProps {
  config: CodeConfig
  answer?: CodeAnswer
  onChange?: (answer: CodeAnswer) => void
  readOnly?: boolean
}

export function CodeViewer({
  config,
  answer,
  onChange,
  readOnly,
}: CodeViewerProps) {
  const value = answer?.code ?? config.starterCode

  // Read-only code displays don't need the multi-MB Monaco engine — a plain
  // <pre> keeps the results/grading pages light.
  if (readOnly) {
    return (
      <pre className="h-64 overflow-auto rounded-md border bg-muted/50 p-3 font-mono text-sm">
        {value}
      </pre>
    )
  }

  return (
    <div>
      <CodeInput
        language={config.language}
        value={value}
        onChange={(code) => onChange?.({ code, language: config.language })}
        ariaLabel="Code-Antwort"
      />
      <p className="mt-2 text-xs text-muted-foreground">
        Deine Antwort wird von der Lehrperson bewertet.
      </p>
    </div>
  )
}
