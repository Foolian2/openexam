"use client"

import { useMemo, useRef, type KeyboardEvent } from "react"
import { Input } from "@/components/ui/input"
import type { FillBlankConfig } from "@/lib/types/questions"
import type { FillBlankAnswer } from "@/lib/types/answers"

interface FillBlankViewerProps {
  config: FillBlankConfig
  answer?: FillBlankAnswer
  onChange?: (answer: FillBlankAnswer) => void
  readOnly?: boolean
}

export function FillBlankViewer({
  config,
  answer,
  onChange,
  readOnly,
}: FillBlankViewerProps) {
  const blanks =
    answer?.blanks ?? config.blanks.map((b) => ({ id: b.id, value: "" }))

  const parts = useMemo(
    () => config.template.split(/(\{\d+\})/g),
    [config.template]
  )

  // Blank ids in the order they appear in the template, so Enter can advance
  // to the next blank and the visible numbering matches the template.
  const blankOrder = useMemo(() => {
    const ids: string[] = []
    for (const part of parts) {
      const match = part.match(/^\{(\d+)\}$/)
      if (match) ids.push(match[1])
    }
    return ids
  }, [parts])

  const blankRefs = useRef<Record<string, HTMLInputElement | null>>({})

  function updateBlank(id: string, value: string) {
    if (!onChange) return
    onChange({ blanks: blanks.map((b) => (b.id === id ? { ...b, value } : b)) })
  }

  function handleBlankKeyDown(id: string, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return
    e.preventDefault()
    const idx = blankOrder.indexOf(id)
    const nextId = blankOrder[idx + 1]
    if (nextId) blankRefs.current[nextId]?.focus()
  }

  return (
    // Plain inline flow, so the sentence wraps like text around the blanks.
    <p className="leading-10">
      {parts.map((part, i) => {
        const match = part.match(/^\{(\d+)\}$/)
        if (match) {
          const blank = blanks.find((b) => b.id === match[1])
          return (
            <span
              key={i}
              className="inline-flex items-baseline gap-1 align-baseline"
            >
              {/* Same badge as the ordering viewer; sits on the blank's line
                  instead of floating above it, onto the previous line. */}
              <span
                aria-hidden
                className="flex h-5 w-5 shrink-0 items-center justify-center self-center rounded-full border bg-muted text-[11px] leading-none text-muted-foreground tabular-nums"
              >
                {match[1]}
              </span>
              <Input
                ref={(el) => {
                  blankRefs.current[match[1]] = el
                }}
                aria-label={`Lücke ${match[1]}`}
                value={blank?.value ?? ""}
                onChange={(e) => updateBlank(match[1], e.target.value)}
                onKeyDown={(e) => handleBlankKeyDown(match[1], e)}
                disabled={readOnly}
                className="inline-block h-7 w-32 rounded-none border-x-0 border-t-0 border-b bg-transparent px-1 py-0 text-sm focus-visible:ring-0"
                placeholder="___"
              />
            </span>
          )
        }
        return <span key={i}>{part}</span>
      })}
    </p>
  )
}
