"use client"

import { useState } from "react"
import type { AnswerContent } from "@/lib/answer-buffer"
import type { ViewerQuestionConfig } from "@/lib/types/questions"
import { QuestionViewer } from "./question-viewer"

/**
 * Booleans that change how a viewer is wired up rather than what it shows,
 * so flipping one has to remount the preview alongside a structural edit.
 */
const STRUCTURAL_FLAGS = ["multiSelect", "shuffle", "richText"]

/**
 * Identity of a config's *structure*: the item ids and modes the viewers
 * latch onto when they mount (ordering's reset baseline, matching's slots,
 * free text's editor kind). Used as a React `key`, so editing a label leaves
 * the preview's trial answers alone while adding, removing or reordering
 * items rebuilds it with fresh state.
 */
export function previewStructureKey(type: string, config: unknown): string {
  const record = (config ?? {}) as Record<string, unknown>
  const parts = [type]
  for (const field of Object.keys(record).sort()) {
    const value = record[field]
    if (Array.isArray(value)) {
      const ids = value.map((item, index) =>
        item && typeof item === "object" && "id" in item
          ? String((item as { id: unknown }).id)
          : index
      )
      parts.push(`${field}=${ids.join(",")}`)
    } else if (typeof value === "boolean" && STRUCTURAL_FLAGS.includes(field)) {
      parts.push(`${field}=${value}`)
    }
  }
  return parts.join("|")
}

/**
 * Live, interactive rendering of a question exactly as a student would
 * answer it — used by the authoring sheet to try out a config before saving.
 * Answers are kept in local state and never persisted; uploads are
 * disabled (no session context).
 */
export function InteractivePreview({
  question,
}: {
  question: ViewerQuestionConfig
}) {
  const [answer, setAnswer] = useState<AnswerContent | undefined>(undefined)
  const viewer = (
    <QuestionViewer
      question={question}
      answer={answer}
      onChange={setAnswer}
      idPrefix="preview-"
    />
  )
  if (question.type !== "FILE_UPLOAD") return viewer
  return (
    <div className="space-y-2">
      {viewer}
      <p className="text-xs text-muted-foreground">
        In der Vorschau ist kein Upload möglich.
      </p>
    </div>
  )
}
