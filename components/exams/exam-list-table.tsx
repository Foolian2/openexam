"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useQueryStates, debounce } from "nuqs"
import {
  MoreHorizontal,
  Pencil,
  Trash2,
  Send,
  BookOpen,
  Copy,
  MonitorPlay,
  ClipboardCheck,
  Search,
  AlertTriangle,
  FolderInput,
  FolderMinus,
  Archive,
  ArchiveRestore,
  Printer,
  Eye,
  EyeOff,
} from "lucide-react"
import { apiMutateToast } from "@/lib/api-mutate-toast"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ExamStatusBadge } from "./exam-status-badge"
import { AccessCodeChip } from "./access-code-chip"
import { NewExamDialog } from "./new-exam-dialog"
import { DataTablePagination } from "@/components/shared/data-table-pagination"
import { examListSearchParams } from "@/lib/search-params/exam-list"
import { tablePendingClass } from "@/lib/search-params/shared"
import { cn } from "@/lib/utils"
import type { ExamStatus } from "@/generated/prisma/client"
import { formatDateTime } from "@/lib/format-date"

const STATUS_OPTIONS: { value: ExamStatus; label: string }[] = [
  { value: "DRAFT", label: "Entwurf" },
  { value: "PUBLISHED", label: "Veröffentlicht" },
  { value: "ACTIVE", label: "Aktiv" },
  { value: "CLOSED", label: "Beendet" },
  { value: "GRADED", label: "Bewertet" },
  { value: "ARCHIVED", label: "Archiviert" },
]

const ALL_STATUSES = "ALL"

interface Exam {
  id: string
  title: string
  status: ExamStatus
  timeLimitMin: number
  accessCode: string
  scheduledStart: string | null
  totalPoints: number
  folderId: string | null
  showResults: boolean
  _count: { questions: number }
}

const RESULTS_VISIBLE_STATUSES: ExamStatus[] = ["CLOSED", "GRADED", "ARCHIVED"]

interface ExamFolder {
  id: string
  name: string
}

interface ExamListTableProps {
  exams: Exam[]
  total: number
  limit: number
  counts: Record<string, number>
  totalAll: number
  folders: ExamFolder[]
}

function PrimaryAction({ exam }: { exam: Exam }) {
  switch (exam.status) {
    case "DRAFT":
      return (
        <Button asChild variant="outline" size="sm">
          <Link href={`/dashboard/teacher/exams/${exam.id}/edit`}>
            <Pencil />
            Bearbeiten
          </Link>
        </Button>
      )
    case "PUBLISHED":
      return <AccessCodeChip code={exam.accessCode} />
    case "ACTIVE":
      return (
        <Button asChild variant="outline" size="sm">
          <Link href={`/dashboard/teacher/monitor/${exam.id}`}>
            <MonitorPlay />
            Live-Monitor
          </Link>
        </Button>
      )
    case "CLOSED":
      return (
        <Button asChild variant="outline" size="sm">
          <Link href={`/dashboard/teacher/grades/${exam.id}`}>
            <ClipboardCheck />
            Bewerten
          </Link>
        </Button>
      )
    case "GRADED":
    case "ARCHIVED":
      return (
        <Button asChild variant="outline" size="sm">
          <Link href={`/dashboard/teacher/grades/${exam.id}`}>
            <ClipboardCheck />
            Ergebnisse
          </Link>
        </Button>
      )
  }
}

export function ExamListTable({
  exams,
  total,
  limit,
  counts,
  totalAll,
  folders,
}: ExamListTableProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [filters, setFilters] = useQueryStates(examListSearchParams, {
    startTransition,
  })
  const totalPages = Math.ceil(total / limit)
  const [deleteTarget, setDeleteTarget] = useState<Exam | null>(null)
  const [activateTarget, setActivateTarget] = useState<Exam | null>(null)
  const [isDuplicating, setIsDuplicating] = useState<string | null>(null)
  const [movingExamId, setMovingExamId] = useState<string | null>(null)

  const safeStatus = STATUS_OPTIONS.some((o) => o.value === filters.status)
    ? filters.status
    : ""
  const search = filters.q
  const folder = filters.folder

  async function handleDelete(id: string) {
    const result = await apiMutateToast(`/api/exams/${id}`, {
      method: "DELETE",
      success: "Prüfung gelöscht",
      fallbackError: "Fehler beim Löschen",
    })
    if (result.ok) router.refresh()
  }

  async function handlePublish(id: string) {
    const result = await apiMutateToast(`/api/exams/${id}/publish`, {
      success: "Prüfung veröffentlicht",
      fallbackError: "Fehler beim Veröffentlichen",
    })
    if (result.ok) router.refresh()
  }

  async function handleActivate(id: string) {
    const result = await apiMutateToast(`/api/exams/${id}/activate`, {
      success: "Prüfung gestartet",
      fallbackError: "Fehler beim Starten",
    })
    if (result.ok) router.refresh()
  }

  async function handleMove(id: string, folderId: string | null) {
    setMovingExamId(id)
    try {
      const result = await apiMutateToast(`/api/exams/${id}/folder`, {
        method: "PATCH",
        body: { folderId },
        success: folderId ? "Prüfung verschoben" : "Aus Ordner entfernt",
        fallbackError: "Fehler beim Verschieben",
      })
      if (result.ok) router.refresh()
    } finally {
      setMovingExamId(null)
    }
  }

  async function handleDuplicate(id: string) {
    setIsDuplicating(id)
    try {
      const result = await apiMutateToast<{ exam: { id: string } }>(
        `/api/exams/${id}/duplicate`,
        {
          success: "Prüfung dupliziert",
          fallbackError: "Fehler beim Duplizieren",
        }
      )
      if (result.ok)
        router.push(`/dashboard/teacher/exams/${result.data.exam.id}/edit`)
    } finally {
      setIsDuplicating(null)
    }
  }

  async function handleArchive(id: string) {
    const result = await apiMutateToast(`/api/exams/${id}/archive`, {
      success: "Prüfung archiviert",
      fallbackError: "Fehler beim Archivieren",
    })
    if (result.ok) router.refresh()
  }

  async function handleUnarchive(id: string) {
    const result = await apiMutateToast(`/api/exams/${id}/archive`, {
      method: "DELETE",
      success: "Archivierung aufgehoben",
      fallbackError: "Fehler beim Wiederherstellen",
    })
    if (result.ok) router.refresh()
  }

  return (
    <div className={cn("space-y-4", tablePendingClass(isPending))}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filters.q}
            onChange={(e) =>
              setFilters(
                { q: e.target.value, page: 1 },
                { limitUrlUpdates: debounce(400) }
              )
            }
            placeholder="Prüfung suchen…"
            className="pl-8"
            aria-label="Prüfungen durchsuchen"
          />
        </div>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={safeStatus || ALL_STATUSES}
          onValueChange={(value) => {
            if (value)
              setFilters({
                status: value === ALL_STATUSES ? "" : value,
                page: 1,
              })
          }}
          className="flex-wrap"
        >
          <ToggleGroupItem value={ALL_STATUSES} className="gap-1">
            Alle
            <span className="text-muted-foreground tabular-nums">
              {totalAll}
            </span>
          </ToggleGroupItem>
          {STATUS_OPTIONS.map((opt) => (
            <ToggleGroupItem
              key={opt.value}
              value={opt.value}
              className="gap-1"
            >
              {opt.label}
              <span className="text-muted-foreground tabular-nums">
                {counts[opt.value] ?? 0}
              </span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {exams.length === 0 ? (
        <Empty className="border bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BookOpen />
            </EmptyMedia>
            <EmptyTitle>
              {safeStatus || search || folder
                ? "Keine Prüfungen gefunden"
                : "Noch keine Prüfungen"}
            </EmptyTitle>
            <EmptyDescription>
              {safeStatus || search || folder
                ? "Keine Prüfungen entsprechen den aktuellen Filtern."
                : "Erstellen Sie Ihre erste Prüfung, um loszulegen."}
            </EmptyDescription>
          </EmptyHeader>
          {!safeStatus && !search && !folder && (
            <NewExamDialog triggerLabel="Neue Prüfung erstellen" />
          )}
        </Empty>
      ) : (
        <>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Titel</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-center">Fragen</TableHead>
                  <TableHead className="text-center">Punkte</TableHead>
                  <TableHead>Geplanter Start</TableHead>
                  <TableHead>
                    <span className="sr-only">Schnellaktion</span>
                  </TableHead>
                  <TableHead className="w-10">
                    <span className="sr-only">Aktionen</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {exams.map((exam) => (
                  <TableRow key={exam.id}>
                    <TableCell className="font-medium">
                      <Link
                        href={`/dashboard/teacher/exams/${exam.id}/edit`}
                        className="underline-offset-2 hover:underline"
                      >
                        {exam.title}
                      </Link>
                      <p className="text-xs font-normal text-muted-foreground">
                        {exam.timeLimitMin} Min.
                      </p>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <ExamStatusBadge status={exam.status} />
                        {RESULTS_VISIBLE_STATUSES.includes(exam.status) && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge
                                variant={
                                  exam.showResults ? "default" : "secondary"
                                }
                                className={
                                  exam.showResults
                                    ? "bg-success text-success-foreground"
                                    : "text-muted-foreground"
                                }
                              >
                                {exam.showResults ? <Eye /> : <EyeOff />}
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent>
                              {exam.showResults
                                ? "Ergebnisse für Schüler:innen sichtbar"
                                : "Ergebnisse für Schüler:innen verborgen"}
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-center">
                      <div className="inline-flex items-center gap-1.5">
                        {exam._count.questions}
                        {exam._count.questions === 0 &&
                          (exam.status === "DRAFT" ||
                            exam.status === "PUBLISHED") && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <AlertTriangle className="h-3.5 w-3.5 text-warning" />
                              </TooltipTrigger>
                              <TooltipContent>
                                Keine Fragen — kann nicht veröffentlicht werden
                              </TooltipContent>
                            </Tooltip>
                          )}
                      </div>
                    </TableCell>
                    <TableCell className="text-center">
                      {exam.totalPoints}
                    </TableCell>
                    <TableCell
                      className="text-sm text-muted-foreground"
                      suppressHydrationWarning
                    >
                      {exam.scheduledStart
                        ? formatDateTime(exam.scheduledStart)
                        : "—"}
                    </TableCell>
                    <TableCell>
                      <PrimaryAction exam={exam} />
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon">
                            <MoreHorizontal />
                            <span className="sr-only">Aktionen</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() =>
                              router.push(
                                `/dashboard/teacher/exams/${exam.id}/edit`
                              )
                            }
                          >
                            <Pencil className="mr-2 h-4 w-4" />
                            Bearbeiten
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() =>
                              window.open(
                                `/api/exams/${exam.id}/print`,
                                "_blank",
                                "noopener,noreferrer"
                              )
                            }
                          >
                            <Printer className="mr-2 h-4 w-4" />
                            Als PDF drucken
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            disabled={isDuplicating === exam.id}
                            onClick={() => handleDuplicate(exam.id)}
                          >
                            <Copy className="mr-2 h-4 w-4" />
                            Duplizieren
                          </DropdownMenuItem>
                          <DropdownMenuSub>
                            <DropdownMenuSubTrigger
                              disabled={movingExamId === exam.id}
                            >
                              <FolderInput className="mr-2 h-4 w-4" />
                              In Ordner verschieben
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent>
                              {folders.length === 0 && (
                                <DropdownMenuItem disabled>
                                  Keine Ordner vorhanden
                                </DropdownMenuItem>
                              )}
                              {folders.map((f) => (
                                <DropdownMenuItem
                                  key={f.id}
                                  disabled={exam.folderId === f.id}
                                  onClick={() => handleMove(exam.id, f.id)}
                                >
                                  {f.name}
                                </DropdownMenuItem>
                              ))}
                              {exam.folderId && (
                                <>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    onClick={() => handleMove(exam.id, null)}
                                  >
                                    <FolderMinus className="mr-2 h-4 w-4" />
                                    Aus Ordner entfernen
                                  </DropdownMenuItem>
                                </>
                              )}
                            </DropdownMenuSubContent>
                          </DropdownMenuSub>
                          {exam.status === "DRAFT" && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => handlePublish(exam.id)}
                              >
                                <Send className="mr-2 h-4 w-4" />
                                Veröffentlichen
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onClick={() => setDeleteTarget(exam)}
                              >
                                <Trash2 className="mr-2 h-4 w-4" />
                                Löschen
                              </DropdownMenuItem>
                            </>
                          )}
                          {exam.status === "PUBLISHED" && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => setActivateTarget(exam)}
                              >
                                <BookOpen className="mr-2 h-4 w-4" />
                                Starten
                              </DropdownMenuItem>
                            </>
                          )}
                          {(exam.status === "CLOSED" ||
                            exam.status === "GRADED") && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => handleArchive(exam.id)}
                              >
                                <Archive className="mr-2 h-4 w-4" />
                                Archivieren
                              </DropdownMenuItem>
                            </>
                          )}
                          {exam.status === "ARCHIVED" && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => handleUnarchive(exam.id)}
                              >
                                <ArchiveRestore className="mr-2 h-4 w-4" />
                                Archivierung aufheben
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <DataTablePagination
            page={filters.page}
            totalPages={totalPages}
            total={total}
            limit={limit}
            label="Prüfungen"
            onPageChange={(p) => setFilters({ page: p })}
          />
        </>
      )}

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Prüfung löschen?</AlertDialogTitle>
            <AlertDialogDescription>
              &quot;{deleteTarget?.title}&quot; wird endgültig gelöscht. Dies
              kann nicht rückgängig gemacht werden.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteTarget) void handleDelete(deleteTarget.id)
                setDeleteTarget(null)
              }}
            >
              Löschen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={activateTarget !== null}
        onOpenChange={(open) => !open && setActivateTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Prüfung starten?</AlertDialogTitle>
            <AlertDialogDescription>
              &quot;{activateTarget?.title}&quot; wird sofort für Teilnehmende
              mit dem Zugangscode zugänglich und kann danach nicht mehr
              bearbeitet werden.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              className="bg-success text-success-foreground hover:bg-success/90"
              onClick={() => {
                if (activateTarget) void handleActivate(activateTarget.id)
                setActivateTarget(null)
              }}
            >
              Starten
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
