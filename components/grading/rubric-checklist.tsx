"use client"

import { useState } from "react"
import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { RubricItem } from "@/lib/types/questions"

interface RubricChecklistProps {
  rubric: RubricItem[]
  maxPoints: number
  onApply: (points: number) => void
}

/**
 * Grading aid, not a record: checked criteria are local UI state only,
 * never persisted. Resets whenever the card remounts (e.g. navigating to
 * another session), which is fine since it's just a scratch pad for
 * computing a suggested point total.
 */
export function RubricChecklist({
  rubric,
  maxPoints,
  onApply,
}: RubricChecklistProps) {
  const [checked, setChecked] = useState<Set<string>>(new Set())

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const suggested = rubric
    .filter((r) => checked.has(r.id))
    .reduce((sum, r) => sum + r.points, 0)

  return (
    <div className="space-y-2 rounded-md border p-3">
      <p className="text-sm font-medium">Bewertungsraster</p>
      <div className="space-y-1.5">
        {rubric.map((item) => (
          <div
            key={item.id}
            role="checkbox"
            aria-checked={checked.has(item.id)}
            tabIndex={0}
            onClick={() => toggle(item.id)}
            onKeyDown={(e) => {
              if (e.key === " " || e.key === "Enter") {
                e.preventDefault()
                toggle(item.id)
              }
            }}
            className={cn(
              "flex cursor-pointer items-center gap-2 rounded-sm text-sm outline-none",
              "focus-visible:ring-3 focus-visible:ring-ring/50"
            )}
          >
            {/* Purely visual — the row above is the actual checkbox control,
                so a nested interactive role here would be invalid ARIA. */}
            <Checkbox
              checked={checked.has(item.id)}
              tabIndex={-1}
              aria-hidden="true"
              className="pointer-events-none"
            />
            <span className="flex-1">{item.criterion}</span>
            <span className="text-xs text-muted-foreground">
              +{item.points} P.
            </span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between pt-1">
        <span className="text-xs text-muted-foreground">
          Vorschlag: {suggested} / {maxPoints} P.
        </span>
        <Button
          variant="outline"
          size="sm"
          type="button"
          onClick={() => onApply(suggested)}
        >
          Übernehmen
        </Button>
      </div>
    </div>
  )
}
