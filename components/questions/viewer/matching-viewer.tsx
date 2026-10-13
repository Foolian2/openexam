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
import { GripVertical } from "lucide-react"
import type {
  MatchingConfig,
  SanitizedMatchingConfig,
} from "@/lib/types/questions"
import type { MatchingAnswer } from "@/lib/types/answers"

interface MatchingViewerProps {
  config: MatchingConfig | SanitizedMatchingConfig
  answer?: MatchingAnswer
  onChange?: (answer: MatchingAnswer) => void
  readOnly?: boolean
}

function SortableRight({
  id,
  text,
  index,
}: {
  id: string
  text: string
  index: number
}) {
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({ id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className="flex cursor-grab items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm active:cursor-grabbing"
      {...attributes}
      {...listeners}
    >
      <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground" />
      <PositionBadge index={index} />
      {text}
    </div>
  )
}

function PositionBadge({ index }: { index: number }) {
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border bg-muted text-[11px] text-muted-foreground tabular-nums">
      {index + 1}
    </span>
  )
}

function shuffleArray<T>(arr: T[]): T[] {
  const copy = [...arr]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

/**
 * Students receive the sanitized shape (decoupled sides, opaque right-side
 * ids, pre-shuffled server-side); teacher views still pass the raw config.
 * Normalize both to left/right item lists.
 */
function normalize(
  config: MatchingConfig | SanitizedMatchingConfig | null | undefined
): {
  left: { id: string; text: string }[]
  right: { id: string; text: string }[]
  clientShuffle: boolean
} {
  if (config && "pairs" in config && Array.isArray(config.pairs)) {
    return {
      left: config.pairs.map((p) => ({ id: p.id, text: p.left })),
      right: config.pairs.map((p) => ({ id: p.id, text: p.right })),
      clientShuffle: config.shuffleSides,
    }
  }
  const sanitized = config as SanitizedMatchingConfig | null | undefined
  return {
    left: Array.isArray(sanitized?.left) ? sanitized.left : [],
    right: Array.isArray(sanitized?.right) ? sanitized.right : [],
    clientShuffle: false,
  }
}

export function MatchingViewer({
  config,
  answer,
  onChange,
  readOnly,
}: MatchingViewerProps) {
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  // Derived from props on every render — cheap, and avoids stale values if
  // the config prop changes.
  const { left, right, clientShuffle } = normalize(config)

  const [rightOrder, setRightOrder] = useState<string[]>(() => {
    const knownIds = new Set(right.map((r) => r.id))
    if (answer) {
      // Ignore unknown ids and append any missing items so every right-side
      // item is always rendered exactly once.
      const fromAnswer = answer.matches
        .map((m) => m.rightId)
        .filter((id, i, arr) => knownIds.has(id) && arr.indexOf(id) === i)
      const seen = new Set(fromAnswer)
      return [
        ...fromAnswer,
        ...right.map((r) => r.id).filter((id) => !seen.has(id)),
      ]
    }
    const ids = right.map((r) => r.id)
    return clientShuffle ? shuffleArray(ids) : ids
  })

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = rightOrder.indexOf(active.id as string)
    const newIndex = rightOrder.indexOf(over.id as string)
    const newOrder = arrayMove(rightOrder, oldIndex, newIndex)
    setRightOrder(newOrder)

    onChange?.({
      matches: left.map((item, i) => ({
        leftId: item.id,
        rightId: newOrder[i],
      })),
    })
  }

  const rightById = new Map(right.map((r) => [r.id, r]))
  const rightItems = rightOrder
    .map((id) => rightById.get(id))
    .filter((item): item is { id: string; text: string } => item !== undefined)

  return (
    <div className="space-y-2">
      {!readOnly && (
        <p className="text-xs text-muted-foreground">
          Ziehen (oder Pfeiltasten), um jeden rechten Begriff dem linken Begriff
          in derselben Zeile zuzuordnen.
        </p>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          {left.map((item, i) => (
            <div
              key={item.id}
              className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm"
            >
              <PositionBadge index={i} />
              {item.text}
            </div>
          ))}
        </div>

        <div className="space-y-2">
          {readOnly ? (
            rightItems.map((item, i) => (
              <div
                key={item.id}
                className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm"
              >
                <PositionBadge index={i} />
                {item.text}
              </div>
            ))
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={rightOrder}
                strategy={verticalListSortingStrategy}
              >
                {rightItems.map((item, i) => (
                  <SortableRight
                    key={item.id}
                    id={item.id}
                    text={item.text}
                    index={i}
                  />
                ))}
              </SortableContext>
            </DndContext>
          )}
        </div>
      </div>
    </div>
  )
}
