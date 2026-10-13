"use client"

import { Check } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ExamStatus } from "@/generated/prisma/client"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

const STEPS: { status: ExamStatus; label: string; help: string }[] = [
  {
    status: "DRAFT",
    label: "Entwurf",
    help: "Die Prüfung ist in Bearbeitung und nur für Sie sichtbar.",
  },
  {
    status: "PUBLISHED",
    label: "Veröffentlicht",
    help: "Der Zugangscode wurde erzeugt. Die Teilnehmenden können die Prüfung sehen, aber noch nicht beitreten.",
  },
  {
    status: "ACTIVE",
    label: "Aktiv",
    help: "Die Prüfung läuft — die Teilnehmenden können mit dem Zugangscode beitreten.",
  },
  {
    status: "CLOSED",
    label: "Beendet",
    help: "Die Prüfung ist beendet. Es können keine Antworten mehr abgegeben werden.",
  },
  {
    status: "GRADED",
    label: "Bewertet",
    help: "Alle Abgaben wurden bewertet. Je nach Einstellung sehen die Teilnehmenden nun ihre Ergebnisse.",
  },
]

export function ExamStatusStepper({ status }: { status: ExamStatus }) {
  if (status === "ARCHIVED") {
    return (
      <ol className="flex items-center gap-1.5">
        <li className="text-xs text-muted-foreground">Archiviert</li>
      </ol>
    )
  }

  const currentIndex = STEPS.findIndex((s) => s.status === status)

  return (
    <ol className="flex items-center gap-1.5">
      {STEPS.map((step, i) => {
        const isDone = i < currentIndex
        const isCurrent = i === currentIndex
        return (
          <li key={step.status} className="flex items-center gap-1.5">
            {i > 0 && (
              <span
                className={cn(
                  "h-px w-4",
                  isDone || isCurrent ? "bg-primary" : "bg-border"
                )}
              />
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  tabIndex={0}
                  className={cn(
                    "flex cursor-help items-center gap-1 rounded-full px-2 py-0.5 text-xs outline-none",
                    isCurrent && "bg-primary font-medium text-primary-foreground",
                    isDone && "text-muted-foreground",
                    !isDone && !isCurrent && "text-muted-foreground/50"
                  )}
                >
                  {isDone && <Check className="h-3 w-3" />}
                  {step.label}
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-64 font-normal">
                {step.help}
              </TooltipContent>
            </Tooltip>
          </li>
        )
      })}
    </ol>
  )
}
