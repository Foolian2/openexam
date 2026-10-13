"use client"

import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { ExamStatus } from "@/generated/prisma/client"

const statusConfig: Record<
  ExamStatus,
  {
    label: string
    variant: "default" | "secondary" | "destructive" | "outline"
    help: string
  }
> = {
  DRAFT: {
    label: "Entwurf",
    variant: "secondary",
    help: "Die Prüfung ist in Bearbeitung und nur für Sie sichtbar.",
  },
  PUBLISHED: {
    label: "Veröffentlicht",
    variant: "default",
    help: "Der Zugangscode wurde erzeugt. Die Teilnehmenden können die Prüfung sehen, aber noch nicht beitreten — erst nach «Starten».",
  },
  ACTIVE: {
    label: "Aktiv",
    variant: "default",
    help: "Die Prüfung läuft — die Teilnehmenden können mit dem Zugangscode beitreten.",
  },
  CLOSED: {
    label: "Beendet",
    variant: "outline",
    help: "Die Prüfung ist beendet. Es können keine Antworten mehr abgegeben werden.",
  },
  GRADED: {
    label: "Bewertet",
    variant: "default",
    help: "Alle Abgaben wurden bewertet. Je nach Einstellung sehen die Teilnehmenden nun ihre Ergebnisse.",
  },
  ARCHIVED: {
    label: "Archiviert",
    variant: "secondary",
    help: "Die Prüfung wurde archiviert und kann bei Bedarf wiederhergestellt werden.",
  },
}

const statusColor: Record<ExamStatus, string> = {
  DRAFT: "",
  PUBLISHED: "bg-info text-info-foreground hover:bg-info/90",
  ACTIVE: "bg-success text-success-foreground hover:bg-success/90",
  CLOSED: "border-warning text-warning-foreground",
  GRADED: "",
  ARCHIVED: "",
}

interface ExamStatusBadgeProps {
  status: ExamStatus
  className?: string
}

export function ExamStatusBadge({ status, className }: ExamStatusBadgeProps) {
  const { label, variant, help } = statusConfig[status]
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex outline-none">
          <Badge
            variant={variant}
            className={`${statusColor[status]} cursor-help ${className ?? ""}`}
          >
            {label}
          </Badge>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-64 font-normal">
        {help}
      </TooltipContent>
    </Tooltip>
  )
}
