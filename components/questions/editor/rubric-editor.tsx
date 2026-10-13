"use client"

import { nanoid } from "nanoid"
import { Plus, Trash2 } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty"
import { cn } from "@/lib/utils"
import type { RubricItem } from "@/lib/types/questions"

interface RubricEditorProps {
  rubric: RubricItem[] | undefined
  onChange: (rubric: RubricItem[]) => void
  questionPoints: number
}

export function RubricEditor({
  rubric,
  onChange,
  questionPoints,
}: RubricEditorProps) {
  const items = rubric ?? []

  function addItem() {
    onChange([...items, { id: nanoid(), criterion: "", points: 0 }])
  }

  function updateItem(
    index: number,
    field: "criterion" | "points",
    value: string | number
  ) {
    onChange(
      items.map((it, i) => (i === index ? { ...it, [field]: value } : it))
    )
  }

  function removeItem(index: number) {
    onChange(items.filter((_, i) => i !== index))
  }

  const sum = items.reduce((s, it) => s + it.points, 0)
  const mismatch = items.length > 0 && sum !== questionPoints

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <Label>Bewertungsraster (optional)</Label>
        <Button variant="outline" size="sm" onClick={addItem} type="button">
          <Plus />
          Kriterium hinzufügen
        </Button>
      </div>

      {items.length === 0 && (
        <Empty className="border bg-card">
          <EmptyTitle>Kein Bewertungsraster</EmptyTitle>
          <EmptyDescription>
            Optionale Kriterien für die manuelle Bewertung, mit Punktvorschlag
            pro Kriterium.
          </EmptyDescription>
        </Empty>
      )}

      {items.length > 0 && (
        <div className="space-y-2">
          {items.map((item, i) => (
            <div key={item.id} className="flex items-center gap-2">
              <Input
                value={item.criterion}
                onChange={(e) => updateItem(i, "criterion", e.target.value)}
                placeholder="Kriterium"
                className="flex-1"
              />
              <Input
                type="number"
                min={0}
                step={0.5}
                value={item.points}
                onChange={(e) =>
                  updateItem(i, "points", parseFloat(e.target.value) || 0)
                }
                className="w-20"
              />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => removeItem(i)}
                type="button"
                aria-label="Kriterium entfernen"
              >
                <Trash2 />
              </Button>
            </div>
          ))}
          <p
            className={cn(
              "text-xs",
              mismatch ? "text-amber-600" : "text-muted-foreground"
            )}
          >
            {mismatch
              ? `Summe weicht von der Gesamtpunktzahl ab (${sum} ≠ ${questionPoints})`
              : `Summe: ${sum} / ${questionPoints} Punkte`}
          </p>
        </div>
      )}
    </div>
  )
}
