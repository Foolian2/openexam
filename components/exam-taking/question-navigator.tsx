"use client"

import { Bookmark } from "lucide-react"
import { useState } from "react"
import { cn } from "@/lib/utils"
import { Progress } from "@/components/ui/progress"

export type NavigatorQuestionState =
  "answered" | "open" | "required-open" | "error"

interface QuestionNavigatorProps {
  items: { id: string; state: NavigatorQuestionState; bookmarked: boolean }[]
  currentId?: string | null
  onNavigate: (id: string) => void
  variant: "rail" | "dots"
  answeredCount: number
}

const STATE_LABELS: Record<NavigatorQuestionState, string> = {
  answered: "beantwortet",
  open: "unbeantwortet",
  "required-open": "Pflichtfrage, unbeantwortet",
  error: "beantwortet, Speichern fehlgeschlagen",
}

function NoBookmarksHint() {
  return (
    <p className="flex items-start gap-1.5 rounded-md border border-dashed p-2 text-xs text-muted-foreground">
      <Bookmark className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>
        Keine Fragen markiert. Tippen Sie bei einer Frage auf das
        Lesezeichen-Symbol, um sie hier zum späteren Nachprüfen zu sammeln.
      </span>
    </p>
  )
}

export function QuestionNavigator({
  items,
  currentId,
  onNavigate,
  variant,
  answeredCount,
}: QuestionNavigatorProps) {
  const total = items.length
  const [markedOnly, setMarkedOnly] = useState(false)
  if (total === 0) return null

  const visibleItems = markedOnly
    ? items.filter((item) => item.bookmarked)
    : items
  const buttons = visibleItems.map((item) => {
    const i = items.findIndex((candidate) => candidate.id === item.id)
    // An errored save implies an answer exists, so error keeps the filled look.
    const filled = item.state === "answered" || item.state === "error"
    return (
      <button
        key={item.id}
        type="button"
        onClick={() => onNavigate(item.id)}
        aria-label={`Frage ${i + 1}, ${STATE_LABELS[item.state]}`}
        aria-current={item.id === currentId ? "true" : undefined}
        className={cn(
          "relative flex items-center justify-center rounded-md font-medium tabular-nums transition-[color,background-color,border-color,transform] duration-[160ms] ease-out after:absolute after:-inset-2 after:content-[''] active:scale-[0.97]",
          variant === "rail" ? "size-8 text-xs" : "size-6 text-[10px]",
          filled
            ? "bg-primary text-primary-foreground hover:bg-primary/90"
            : "border bg-background text-muted-foreground hover:bg-muted",
          item.state === "error" && "ring-2 ring-warning",
          item.id === currentId && item.state !== "error" && "ring-2 ring-ring"
        )}
      >
        {i + 1}
        {item.bookmarked && (
          <Bookmark
            aria-hidden
            className="absolute -right-1 -bottom-1 size-3 fill-warning text-warning"
          />
        )}
        {item.state === "required-open" && (
          <span
            aria-hidden
            className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-destructive"
          />
        )}
      </button>
    )
  })

  if (variant === "dots") {
    return (
      <nav aria-label="Fragenübersicht" className="space-y-2">
        <button
          type="button"
          className="text-xs text-muted-foreground underline"
          onClick={() => setMarkedOnly((value) => !value)}
        >
          {markedOnly
            ? "Alle Fragen"
            : `Markiert (${items.filter((item) => item.bookmarked).length})`}
        </button>
        <div className="flex flex-wrap gap-1">{buttons}</div>
        {markedOnly && buttons.length === 0 && <NoBookmarksHint />}
      </nav>
    )
  }

  return (
    <nav aria-label="Fragenübersicht" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground tabular-nums">
          {answeredCount} von {total} Fragen beantwortet
        </span>
        <QuestionProgressBar answeredCount={answeredCount} total={total} />
      </div>
      <button
        type="button"
        className="self-start text-xs text-muted-foreground underline"
        onClick={() => setMarkedOnly((value) => !value)}
      >
        {markedOnly
          ? "Alle Fragen"
          : `Markiert (${items.filter((item) => item.bookmarked).length})`}
      </button>
      <div className="grid grid-cols-4 gap-1.5">{buttons}</div>
      {markedOnly && buttons.length === 0 && <NoBookmarksHint />}
    </nav>
  )
}

export function QuestionProgressBar({
  answeredCount,
  total,
}: {
  answeredCount: number
  total: number
}) {
  return (
    <Progress
      value={total > 0 ? (answeredCount / total) * 100 : 0}
      aria-label="Beantwortete Fragen"
    />
  )
}
