"use client"

import { Info, ShieldAlert } from "lucide-react"
import { Button } from "@/components/ui/button"

function countLabel(count: number, singular: string, plural: string) {
  return `${count} ${count === 1 ? singular : plural}`
}

/**
 * Informational focus loss stays inspectable without a warning badge.
 * `compact` keeps the desktop table column as narrow as the bare count it
 * replaced; the full wording stays the button's accessible name.
 */
export function IntegrityEventsButton({
  integrityEventCount,
  focusLossEventCount = 0,
  compact = false,
  onClick,
}: {
  integrityEventCount: number
  focusLossEventCount?: number
  compact?: boolean
  onClick: () => void
}) {
  if (integrityEventCount === 0 && focusLossEventCount === 0) {
    return compact ? (
      <span className="text-muted-foreground">—</span>
    ) : (
      <span className="text-xs text-muted-foreground">
        Keine Auffälligkeiten
      </span>
    )
  }

  const warnings =
    integrityEventCount > 0
      ? countLabel(integrityEventCount, "Auffälligkeit", "Auffälligkeiten")
      : null
  const hints =
    focusLossEventCount > 0
      ? countLabel(focusLossEventCount, "Hinweis", "Hinweise")
      : null
  const label = [warnings, hints].filter(Boolean).join(" · ")
  const Icon = warnings ? ShieldAlert : Info

  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={compact ? label : undefined}
      title={compact ? label : undefined}
      className={[
        compact ? "h-7 gap-1.5 px-2" : "h-auto gap-1.5 px-2",
        warnings
          ? "text-destructive hover:text-destructive"
          : "text-muted-foreground",
      ].join(" ")}
      onClick={onClick}
    >
      {compact ? (
        <>
          {warnings && (
            <>
              <ShieldAlert className="h-3.5 w-3.5" />
              {integrityEventCount}
            </>
          )}
          {hints && (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <Info className="h-3.5 w-3.5" />
              {focusLossEventCount}
            </span>
          )}
        </>
      ) : (
        <>
          <Icon className="h-3.5 w-3.5" />
          {label}
        </>
      )}
    </Button>
  )
}
