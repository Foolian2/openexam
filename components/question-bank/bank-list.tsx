"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useQueryStates, debounce } from "nuqs"
import {
  Copy,
  Download,
  Folder,
  FolderInput,
  FolderMinus,
  Loader2,
  Pencil,
  Plus,
  Search,
  Share2,
  Trash2,
  ListChecks,
  Upload,
} from "lucide-react"
import { apiMutateToast } from "@/lib/api-mutate-toast"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty"
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { QuestionTypePicker } from "@/components/questions/question-type-picker"
import {
  QuestionSheet,
  type QuestionDraft,
} from "@/components/questions/question-sheet"
import { ShareDialog } from "@/components/question-bank/share-dialog"
import { ImportBankDialog } from "@/components/question-bank/import-dialog"
import {
  NewBankFolderButton,
  SelectedFolderActions,
} from "@/components/question-bank/folder-manager"
import {
  questionBankSearchParams,
  serializeQuestionBankSearchParams,
} from "@/lib/search-params/question-bank"
import { tablePendingClass } from "@/lib/search-params/shared"
import { cn } from "@/lib/utils"
import type { QuestionType } from "@/generated/prisma/client"
import { DataTablePagination } from "@/components/shared/data-table-pagination"
import { QUESTION_TYPE_LABELS } from "@/lib/constants/question-types"

const SORT_OPTIONS = [
  { value: "updatedAt_desc", label: "Zuletzt bearbeitet" },
  { value: "createdAt_desc", label: "Neueste zuerst" },
  { value: "title_asc", label: "Titel (A–Z)" },
  { value: "title_desc", label: "Titel (Z–A)" },
  { value: "points_desc", label: "Punkte (hoch zu tief)" },
  { value: "points_asc", label: "Punkte (tief zu hoch)" },
  { value: "type_asc", label: "Typ (A–Z)" },
] as const

const ALL = "ALL"

interface BankItem {
  id: string
  type: QuestionType
  title: string
  points: number
  required: boolean
  folderId: string | null
  createdAt: string | Date
  updatedAt: string | Date
  shareToken: string | null
  _count: { usedBy: number }
}

interface BankFolder {
  id: string
  name: string
}

interface Props {
  items: BankItem[]
  total: number
  limit: number
  folders: BankFolder[]
}

function copyCountLabel(n: number): string {
  return n === 1 ? "1 Kopie" : `${n} Kopien`
}

export function BankList({ items, total, limit, folders }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [filters, setFilters] = useQueryStates(questionBankSearchParams, {
    startTransition,
  })
  const totalPages = Math.ceil(total / limit)
  const [typePickerOpen, setTypePickerOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editingItem, setEditingItem] = useState<QuestionDraft | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<BankItem | null>(null)
  const [shareTarget, setShareTarget] = useState<BankItem | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [propagateTarget, setPropagateTarget] = useState<BankItem | null>(null)
  const [propagating, setPropagating] = useState(false)

  const { type, folderId, q, sortBy, sortDir } = filters
  // Mirror the server-side fallback in buildQuestionBankOrderBy so hand-crafted
  // URLs with unknown sortBy/sortDir values never leave the Select empty.
  const rawSortValue = sortBy
    ? `${sortBy}_${sortDir === "asc" ? "asc" : "desc"}`
    : "updatedAt_desc"
  const sortValue = SORT_OPTIONS.some((o) => o.value === rawSortValue)
    ? rawSortValue
    : "updatedAt_desc"

  function openNewItem(itemType: QuestionType) {
    setEditingItem({
      type: itemType,
      title: "",
      points: 1,
      required: true,
      config: null,
    })
    setSheetOpen(true)
  }

  async function openEditItem(item: BankItem) {
    const res = await fetch(`/api/question-bank/${item.id}`)
    if (!res.ok) {
      toast.error("Frage konnte nicht geladen werden")
      return
    }
    const { item: full } = await res.json()
    setEditingItem({
      id: full.id,
      type: full.type,
      title: full.title,
      points: full.points,
      required: full.required,
      config: full.config,
    })
    setSheetOpen(true)
  }

  async function handleSaveItem(draft: QuestionDraft): Promise<boolean> {
    if (draft.id) {
      const result = await apiMutateToast(`/api/question-bank/${draft.id}`, {
        method: "PATCH",
        body: {
          title: draft.title,
          points: draft.points,
          required: draft.required,
          config: draft.config,
        },
        success: "Frage aktualisiert",
        fallbackError: "Fehler beim Speichern",
      })
      if (!result.ok) return false
      const saved = items.find((i) => i.id === draft.id)
      // If copies exist in editable exams, offer to propagate the edit.
      if (saved && saved._count.usedBy > 0) {
        setPropagateTarget(saved)
      } else {
        router.refresh()
      }
      return true
    }

    const result = await apiMutateToast("/api/question-bank", {
      body: {
        type: draft.type,
        title: draft.title,
        points: draft.points,
        required: draft.required,
        config: draft.config,
      },
      success: "Frage zur Fragenbank hinzugefügt",
      fallbackError: "Fehler beim Erstellen",
    })
    if (!result.ok) return false
    router.refresh()
    return true
  }

  async function handlePropagate() {
    if (!propagateTarget) return
    setPropagating(true)
    try {
      const result = await apiMutateToast<{
        updated: number
        exams: unknown[]
      }>(`/api/question-bank/${propagateTarget.id}/propagate`, {
        success: (d) =>
          d.updated > 0
            ? `${d.updated} ${d.updated === 1 ? "Kopie" : "Kopien"} in ${
                d.exams.length
              } ${d.exams.length === 1 ? "Prüfung" : "Prüfungen"} aktualisiert`
            : "Keine bearbeitbaren Kopien vorhanden",
        fallbackError: "Aktualisierung fehlgeschlagen",
      })
      if (result.ok) router.refresh()
    } finally {
      setPropagating(false)
      setPropagateTarget(null)
    }
  }

  async function handleDelete(id: string) {
    const result = await apiMutateToast(`/api/question-bank/${id}`, {
      method: "DELETE",
      success: "Frage gelöscht",
      fallbackError: "Fehler beim Löschen",
    })
    if (result.ok) router.refresh()
  }

  async function handleDuplicate(id: string) {
    const result = await apiMutateToast(`/api/question-bank/${id}/duplicate`, {
      success: "Frage dupliziert",
      fallbackError: "Fehler beim Duplizieren",
    })
    if (result.ok) router.refresh()
  }

  async function handleMoveToFolder(item: BankItem, folderId: string | null) {
    const result = await apiMutateToast(`/api/question-bank/${item.id}`, {
      method: "PATCH",
      body: { folderId },
      success: folderId ? "Frage in Ordner verschoben" : "Aus Ordner entfernt",
      fallbackError: "Fehler beim Verschieben",
    })
    if (result.ok) router.refresh()
  }

  const folderNameById = new Map(folders.map((f) => [f.id, f.name]))

  // Fetches every page of the current filter view and downloads it as JSON —
  // the round-trip companion to the JSON import.
  async function handleExport() {
    setExporting(true)
    try {
      const items: Record<string, unknown>[] = []
      let page = 1
      for (;;) {
        const query = serializeQuestionBankSearchParams({
          page,
          type,
          folderId,
          q,
        })
        const res = await fetch(`/api/question-bank/export${query}`)
        if (!res.ok) {
          toast.error("Export fehlgeschlagen")
          return
        }
        const data = await res.json()
        items.push(...data.items)
        // Stop once a page comes back short of the limit, or empty — robust
        // against `total` shifting mid-export if items are added concurrently.
        if (data.items.length === 0 || data.items.length < data.limit) break
        page += 1
      }
      const blob = new Blob([JSON.stringify(items, null, 2)], {
        type: "application/json",
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = "fragenbank-export.json"
      a.click()
      URL.revokeObjectURL(url)
      toast.success(`${items.length} Fragen exportiert`)
    } finally {
      setExporting(false)
    }
  }

  async function handleMove(id: string, folderId: string | null) {
    const result = await apiMutateToast(`/api/question-bank/${id}/folder`, {
      method: "PATCH",
      body: { folderId },
      success: folderId ? "Frage verschoben" : "Aus Ordner entfernt",
      fallbackError: "Fehler beim Verschieben",
    })
    if (result.ok) router.refresh()
  }

  return (
    <div className={cn("space-y-4", tablePendingClass(isPending))}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) =>
              setFilters(
                { q: e.target.value, page: 1 },
                { limitUrlUpdates: debounce(400) }
              )
            }
            placeholder="Fragenbank durchsuchen…"
            className="pl-8"
            aria-label="Fragenbank durchsuchen"
          />
        </div>

        <Select
          value={type || ALL}
          onValueChange={(value) =>
            setFilters({ type: value === ALL ? "" : value, page: 1 })
          }
        >
          <SelectTrigger className="w-[200px]" aria-label="Nach Typ filtern">
            <SelectValue placeholder="Alle Typen" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Alle Typen</SelectItem>
            {(Object.keys(QUESTION_TYPE_LABELS) as QuestionType[]).map((t) => (
              <SelectItem key={t} value={t}>
                {QUESTION_TYPE_LABELS[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {folders.length > 0 && (
          <Select
            value={folderId || ALL}
            onValueChange={(value) =>
              setFilters({ folderId: value === ALL ? "" : value, page: 1 })
            }
          >
            <SelectTrigger
              className="w-[200px]"
              aria-label="Nach Ordner filtern"
            >
              <SelectValue placeholder="Alle Ordner" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Alle Ordner</SelectItem>
              {folders.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <SelectedFolderActions
          folder={folders.find((f) => f.id === folderId) ?? null}
          onDeleted={() => setFilters({ folderId: "", page: 1 })}
        />
        <NewBankFolderButton onCreated={() => router.refresh()} />

        <Select
          value={sortValue}
          onValueChange={(value) => {
            const [field, dir] = value.split("_") as [string, string]
            setFilters({ sortBy: field, sortDir: dir, page: 1 })
          }}
        >
          <SelectTrigger className="w-[190px]" aria-label="Sortierung">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORT_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          variant="outline"
          onClick={() => void handleExport()}
          disabled={exporting}
        >
          {exporting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          Exportieren
        </Button>
        <Button variant="outline" onClick={() => setImportOpen(true)}>
          <Upload className="h-4 w-4" />
          Importieren
        </Button>
        <Button className="ml-auto" onClick={() => setTypePickerOpen(true)}>
          <Plus className="h-4 w-4" />
          Neue Frage
        </Button>
      </div>

      {items.length === 0 ? (
        <Empty className="border bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ListChecks />
            </EmptyMedia>
            <EmptyTitle>
              {type || folderId || q
                ? "Keine Fragen gefunden"
                : "Noch keine Fragen in der Fragenbank"}
            </EmptyTitle>
            <EmptyDescription>
              {type || folderId || q
                ? "Keine Fragen entsprechen den aktuellen Filtern."
                : "Erstellen Sie wiederverwendbare Fragen, die Sie in mehrere Prüfungen einfügen können."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Titel</TableHead>
                  <TableHead>Typ</TableHead>
                  <TableHead className="text-center">Punkte</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <span className="truncate">
                          {item.title || "(Ohne Titel)"}
                        </span>
                        {item.folderId && folderNameById.has(item.folderId) && (
                          <Badge
                            variant="outline"
                            className="h-5 shrink-0 gap-1 text-xs font-normal"
                          >
                            <Folder className="h-3 w-3" />
                            {folderNameById.get(item.folderId)}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {QUESTION_TYPE_LABELS[item.type]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-center">{item.points}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              aria-label={`Ordner für ${item.title || "Frage"}`}
                              title={
                                item.folderId &&
                                folderNameById.has(item.folderId)
                                  ? `Ordner: ${folderNameById.get(item.folderId)}`
                                  : "Ordner zuweisen"
                              }
                            >
                              <Folder className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={() =>
                                void handleMoveToFolder(item, null)
                              }
                            >
                              Kein Ordner
                            </DropdownMenuItem>
                            {folders.map((f) => (
                              <DropdownMenuItem
                                key={f.id}
                                onClick={() =>
                                  void handleMoveToFolder(item, f.id)
                                }
                              >
                                {f.name}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => setShareTarget(item)}
                          aria-label="Frage teilen"
                        >
                          <Share2 className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => void handleDuplicate(item.id)}
                          aria-label="Frage duplizieren"
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => openEditItem(item)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label="In Ordner verschieben"
                            >
                              <FolderInput className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {folders.length === 0 && (
                              <DropdownMenuItem disabled>
                                Keine Ordner vorhanden
                              </DropdownMenuItem>
                            )}
                            {folders.map((f) => (
                              <DropdownMenuItem
                                key={f.id}
                                disabled={item.folderId === f.id}
                                onClick={() => handleMove(item.id, f.id)}
                              >
                                {f.name}
                              </DropdownMenuItem>
                            ))}
                            {item.folderId && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  onClick={() => handleMove(item.id, null)}
                                >
                                  <FolderMinus className="mr-2 h-4 w-4" />
                                  Aus Ordner entfernen
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive hover:text-destructive"
                          onClick={() => setDeleteTarget(item)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
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
            label="Fragen"
            onPageChange={(p) => setFilters({ page: p })}
          />
        </>
      )}

      <QuestionTypePicker
        open={typePickerOpen}
        onOpenChange={setTypePickerOpen}
        onSelect={(t) => {
          setTypePickerOpen(false)
          openNewItem(t)
        }}
      />

      <QuestionSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        question={editingItem}
        onSave={handleSaveItem}
      />

      <ShareDialog
        key={shareTarget?.id ?? "none"}
        item={shareTarget}
        onOpenChange={(open) => !open && setShareTarget(null)}
        onChanged={() => router.refresh()}
      />

      <ImportBankDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={() => router.refresh()}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Frage löschen?</AlertDialogTitle>
            <AlertDialogDescription>
              &quot;{deleteTarget?.title || "(Ohne Titel)"}&quot; wird aus der
              Fragenbank entfernt. Bereits in Prüfungen eingefügte Kopien dieser
              Frage bleiben unverändert.
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
        open={propagateTarget !== null}
        onOpenChange={(open) => !open && setPropagateTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Kopien aktualisieren?</AlertDialogTitle>
            <AlertDialogDescription>
              {/* usedBy counts copies (Question rows), not exams: one exam
                  can hold the same bank question twice. */}
              &quot;{propagateTarget?.title || "(Ohne Titel)"}&quot; wurde
              bearbeitet. In bearbeitbaren Prüfungen (Entwurf/Veröffentlicht)
              gibt es {copyCountLabel(propagateTarget?._count.usedBy ?? 0)}{" "}
              davon. Die aktuelle Version übernehmen? Aktive, beendete oder
              benotete Prüfungen werden nie verändert.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Nur Bank speichern</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handlePropagate()}
              disabled={propagating}
            >
              {propagating ? "Wird aktualisiert…" : "Kopien aktualisieren"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
