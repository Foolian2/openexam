"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useQueryStates } from "nuqs"
import { Inbox, Loader2, PenLine, Zap } from "lucide-react"
import { apiMutateToast } from "@/lib/api-mutate-toast"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { HelpTip } from "@/components/help-tip"
import { DataTablePagination } from "@/components/shared/data-table-pagination"
import { gradesSearchParams } from "@/lib/search-params/grades"
import { tablePendingClass } from "@/lib/search-params/shared"
import { cn } from "@/lib/utils"

const SUBMISSION_LABELS: Record<string, string> = {
  MANUAL: "Manuell",
  AUTO_TIME: "Zeit abgelaufen",
  TEACHER_FORCED: "Durch Lehrperson",
}

interface GradeSessionRow {
  id: string
  submissionType: string | null
  user: { name: string; email: string }
  totalPoints: number
  maxPoints: number
  gradedCount: number
}

interface Props {
  examId: string
  examStatus: string
  questionCount: number
  sessions: GradeSessionRow[]
  limit: number
  total: number
}

export function GradesTable({
  examId,
  examStatus,
  questionCount,
  sessions,
  limit,
  total,
}: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [filters, setFilters] = useQueryStates(gradesSearchParams, {
    startTransition,
  })
  const totalPages = Math.ceil(total / limit)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false)
  const [bulkLoading, setBulkLoading] = useState(false)

  const bulkEligible = examStatus === "CLOSED"
  const allOnPageSelected =
    sessions.length > 0 && sessions.every((s) => selected.has(s.id))

  function toggleAll() {
    setSelected((prev) => {
      if (allOnPageSelected) {
        const next = new Set(prev)
        for (const s of sessions) next.delete(s.id)
        return next
      }
      const next = new Set(prev)
      for (const s of sessions) next.add(s.id)
      return next
    })
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function applyBulkZero() {
    setBulkLoading(true)
    try {
      const result = await apiMutateToast<{ gradesCreated: number }>(
        `/api/exams/${examId}/bulk-grade`,
        {
          body: {
            sessionIds: Array.from(selected),
            action: "ZERO_UNGRADED",
          },
          success: (d) =>
            `${d.gradesCreated} unbewertete Frage(n) auf 0 gesetzt`,
          fallbackError: "Massenbewertung fehlgeschlagen",
        }
      )
      if (!result.ok) return
      setSelected(new Set())
      router.refresh()
    } finally {
      setBulkLoading(false)
      setBulkConfirmOpen(false)
    }
  }

  return (
    <div className={cn("space-y-4", tablePendingClass(isPending))}>
      {bulkEligible && selected.size > 0 && (
        <div className="flex animate-in items-center justify-between rounded-lg border bg-muted/40 px-4 py-2 duration-[var(--duration-fast)] ease-out fade-in-0 slide-in-from-top-2">
          <span className="text-sm">{selected.size} ausgewählt</span>
          <span className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setBulkConfirmOpen(true)}
            >
              <Zap className="h-3.5 w-3.5" />
              Unbewertete auf 0 setzen
            </Button>
            <HelpTip content="Setzt alle ausgewählten Abgaben, die noch keine Note haben, auf 0 Punkte. Bereits bewertete Abgaben bleiben unverändert. Sie werden vor dem Ausführen nochmals um Bestätigung gebeten." />
          </span>
        </div>
      )}

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              {bulkEligible && (
                <TableHead className="w-10">
                  <Checkbox
                    checked={allOnPageSelected}
                    onCheckedChange={toggleAll}
                    aria-label="Alle auf dieser Seite auswählen"
                  />
                </TableHead>
              )}
              <TableHead>Schüler:in</TableHead>
              <TableHead>Abgabe</TableHead>
              <TableHead>Punkte</TableHead>
              <TableHead>Bewertung</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={bulkEligible ? 6 : 5} className="p-0">
                  <Empty>
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <Inbox />
                      </EmptyMedia>
                      <EmptyTitle>Noch keine Abgaben</EmptyTitle>
                      <EmptyDescription>
                        Sobald Teilnehmende diese Prüfung abgeben, erscheinen
                        sie hier zum Bewerten.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                </TableCell>
              </TableRow>
            )}
            {sessions.map((s) => {
              const fullyGraded = s.gradedCount >= questionCount
              return (
                <TableRow key={s.id}>
                  {bulkEligible && (
                    <TableCell>
                      <Checkbox
                        checked={selected.has(s.id)}
                        onCheckedChange={() => toggleOne(s.id)}
                        aria-label={`${s.user.name} auswählen`}
                      />
                    </TableCell>
                  )}
                  <TableCell>
                    <div className="font-medium">{s.user.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {s.user.email}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {s.submissionType
                      ? (SUBMISSION_LABELS[s.submissionType] ??
                        s.submissionType)
                      : "—"}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {s.gradedCount > 0
                      ? `${s.totalPoints} / ${s.maxPoints}`
                      : "—"}
                  </TableCell>
                  <TableCell>
                    {fullyGraded ? (
                      <Badge className="bg-success text-success-foreground hover:bg-success/90">
                        Vollständig
                      </Badge>
                    ) : (
                      <Badge variant="secondary">
                        {s.gradedCount > 0 ? "Teilweise" : "Offen"}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button asChild size="sm" variant="outline">
                      <Link
                        href={`/dashboard/teacher/grades/${examId}/${s.id}`}
                      >
                        <PenLine className="h-4 w-4" />
                        Bewerten
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      <DataTablePagination
        page={filters.page}
        totalPages={totalPages}
        total={total}
        limit={limit}
        label="Abgaben"
        onPageChange={(p) => setFilters({ page: p })}
      />

      <AlertDialog open={bulkConfirmOpen} onOpenChange={setBulkConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Unbewertete Fragen auf 0 setzen?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Für {selected.size} ausgewählte Abgabe(n) werden alle noch
              unbewerteten Fragen mit 0 Punkten bewertet. Bereits bewertete
              Fragen (manuell oder automatisch) bleiben unverändert. Dies kann
              nicht rückgängig gemacht werden.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkLoading}>
              Abbrechen
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={applyBulkZero}
              disabled={bulkLoading}
            >
              {bulkLoading && <Loader2 className="h-4 w-4 animate-spin" />}
              Anwenden
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
