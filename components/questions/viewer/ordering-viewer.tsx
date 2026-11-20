"use client"

import { useState } from "react"
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { GripVertical, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import type {
  OrderingConfig,
  SanitizedOrderingConfig,
} from "@/lib/types/questions"
import type { OrderingAnswer } from "@/lib/types/answers"

interface OrderingViewerProps {
  // Both raw OrderingConfig and SanitizedOrderingConfig have the same shape
  // ({ items, shuffle }); only the *order* of items differs, which the
  // viewer doesn't care about beyond rendering. Type alias accepts either.
  config: OrderingConfig | SanitizedOrderingConfig
  answer?: OrderingAnswer
  onChange?: (answer: OrderingAnswer) => void
  readOnly?: boolean
}

function SortableItem({
  id,
  text,
  index,
}: {
  id: string
  text: string
  index: number
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
  } = useSortable({ id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className="flex cursor-grab items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm select-none active:cursor-grabbing"
      // Mouse/pen can drag anywhere. Touch starts only on the handle so
      // swiping the text still scrolls the exam, including long lists.
      onPointerDown={(event) => {
        if (
          event.pointerType !== "touch" ||
          (event.target as Element).closest("[data-drag-handle]")
        ) {
          listeners?.onPointerDown?.(event)
        }
      }}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        data-drag-handle
        aria-label={`Element ${index + 1} verschieben`}
        className="-my-2 -ml-3 flex size-11 shrink-0 touch-none items-center justify-center rounded-md focus-visible:outline-2 focus-visible:outline-ring"
        {...attributes}
        onKeyDown={(event) => listeners?.onKeyDown?.(event)}
      >
        <GripVertical
          className="h-4 w-4 text-muted-foreground"
          aria-hidden="true"
        />
      </button>
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border bg-muted text-[11px] text-muted-foreground tabular-nums">
        {index + 1}
      </span>
      {text}
    </div>
  )
}

export function OrderingViewer({
  config,
  answer,
  onChange,
  readOnly,
}: OrderingViewerProps) {
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  // Items as presented to the student (already server-shuffled by the
  // sanitizeQuestionConfig path, or in raw correct order if a teacher is
  // previewing the original config — the viewer handles both).
  const items = Array.isArray(config?.items) ? config.items : []
  const itemById = new Map(items.map((i) => [i.id, i]))
  const allIds = items.map((i) => i.id)

  // The order the items were presented in on first render — "reset" restores
  // exactly this, so the untouched state is recoverable.
  const [initialOrder] = useState<string[]>(allIds)

  // orderedIds is the student's arrangement. Initialize from the answer if
  // present (preserving unknown/forged ids would be wrong, so filter);
  // otherwise start from the displayed order so the student has something
  // to reorder.
  const [orderedIds, setOrderedIds] = useState<string[]>(() => {
    if (answer?.orderedIds && answer.orderedIds.length > 0) {
      const known = new Set(allIds)
      const fromAnswer = answer.orderedIds.filter((id) => known.has(id))
      const seen = new Set(fromAnswer)
      const appended = allIds.filter((id) => !seen.has(id))
      return [...fromAnswer, ...appended]
    }
    return allIds
  })

  const isDirty = orderedIds.join("|") !== initialOrder.join("|")

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = orderedIds.indexOf(active.id as string)
    const newIndex = orderedIds.indexOf(over.id as string)
    if (oldIndex === -1 || newIndex === -1) return
    const next = arrayMove(orderedIds, oldIndex, newIndex)
    setOrderedIds(next)
    onChange?.({ orderedIds: next })
  }

  function handleReset() {
    const initial = initialOrder
    setOrderedIds(initial)
    onChange?.({ orderedIds: initial })
  }

  const rendered = orderedIds
    .map((id) => itemById.get(id))
    .filter((i): i is { id: string; text: string } => i !== undefined)

  if (readOnly) {
    return (
      <div className="space-y-2">
        {rendered.map((item, i) => (
          <div
            key={item.id}
            className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm"
          >
            <span className="w-5 text-right text-xs text-muted-foreground tabular-nums">
              {i + 1}.
            </span>
            {item.text}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Ziehen (oder Pfeiltasten), um die Elemente in die richtige Reihenfolge
        zu bringen.
      </p>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={orderedIds}
          strategy={verticalListSortingStrategy}
        >
          <div className="space-y-2">
            {rendered.map((item, i) => (
              <SortableItem
                key={item.id}
                id={item.id}
                text={item.text}
                index={i}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      {isDirty && (
        <Button
          variant="outline"
          size="sm"
          type="button"
          onClick={handleReset}
          className="mt-1"
        >
          <RotateCcw className="mr-1 h-3.5 w-3.5" />
          Zurücksetzen
        </Button>
      )}
    </div>
  )
}
