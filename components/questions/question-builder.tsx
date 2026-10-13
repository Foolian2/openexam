"use client"

import { useState } from "react"
import {
  DndContext,
  closestCenter,
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
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import {
  GripVertical,
  Pencil,
  Trash2,
  Plus,
  ListChecks,
  BookMarked,
  BookUp,
  Copy,
  ChevronDown,
  Loader2,
} from "lucide-react"
import { apiMutateToast } from "@/lib/api-mutate-toast"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { BankPickerDialog } from "@/components/question-bank/bank-picker-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
import { QuestionTypePicker } from "./question-type-picker"
import { QuestionSheet, type QuestionDraft } from "./question-sheet"
import type { QuestionConfig, QuestionType } from "@/lib/types/questions"
import { SEB_FILE_UPLOAD_MESSAGE } from "@/lib/seb-question-policy"
import { LAST_QUESTION_TYPE_KEY } from "@/lib/storage-keys"
import { QUESTION_TYPE_LABELS } from "@/lib/constants/question-types"

const QUESTION_TYPE_ORDER: QuestionType[] = [
  "MULTIPLE_CHOICE",
  "FREE_TEXT",
  "FILL_IN_THE_BLANK",
  "FILE_UPLOAD",
  "MATCHING",
  "CODE",
  "TRUE_FALSE",
  "SHORT_ANSWER",
  "ORDERING",
]

const LAST_TYPE_STORAGE_KEY = LAST_QUESTION_TYPE_KEY

function readLastQuestionType(): QuestionType | null {
  if (typeof window === "undefined") return null
  try {
    const stored = window.localStorage.getItem(LAST_TYPE_STORAGE_KEY)
    return (QUESTION_TYPE_ORDER as string[]).includes(stored ?? "")
      ? (stored as QuestionType)
      : null
  } catch {
    return null
  }
}

export type Question = {
  id: string
  title: string
  points: number
  required: boolean
  order: number
} & QuestionConfig

interface QuestionBuilderProps {
  examId: string
  sebRequired?: boolean
  questions: Question[]
  disabled?: boolean
  onQuestionsChange: (updater: (prev: Question[]) => Question[]) => void
}

function SortableQuestionCard({
  question,
  index,
  onEdit,
  onDelete,
  onDuplicate,
  onSaveToBank,
  savingToBank,
  duplicating,
  uploadBlocked,
  disabled,
}: {
  question: Question
  index: number
  onEdit: () => void
  onDelete: () => void
  onDuplicate: () => void
  onSaveToBank: () => void
  savingToBank: boolean
  duplicating: boolean
  uploadBlocked?: boolean
  disabled?: boolean
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: question.id,
    disabled,
  })

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-3 rounded-lg border bg-card p-3 ${isDragging ? "opacity-50 shadow-lg" : ""}`}
    >
      <button
        className="cursor-grab touch-none text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        disabled={disabled}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-5 w-5" />
      </button>

      <span className="w-6 shrink-0 text-sm text-muted-foreground">
        {index + 1}.
      </span>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {question.title || "(Ohne Titel)"}
        </p>
        <div className="mt-0.5 flex items-center gap-2">
          <Badge variant="outline" className="h-5 text-xs">
            {QUESTION_TYPE_LABELS[question.type]}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {question.points} Pkt.
          </span>
          {!question.required && (
            <span className="text-xs text-muted-foreground">optional</span>
          )}
        </div>
      </div>

      <div className="flex shrink-0 gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onSaveToBank}
          disabled={disabled || savingToBank}
          aria-label="Frage in Fragenbank speichern"
          title="In Fragenbank speichern"
        >
          {savingToBank ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <BookUp className="h-4 w-4" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onDuplicate}
          disabled={disabled || duplicating || uploadBlocked}
          aria-label="Frage duplizieren"
          title="Frage duplizieren"
        >
          {duplicating ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onEdit}
          disabled={disabled}
          aria-label="Frage bearbeiten"
          title="Frage bearbeiten"
        >
          <Pencil className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-destructive hover:text-destructive"
          onClick={onDelete}
          disabled={disabled}
          aria-label="Frage löschen"
          title="Frage löschen"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}

function AddQuestionButton({
  disabled,
  sebRequired,
  lastType,
  onOpenPicker,
  onQuickAdd,
}: {
  disabled?: boolean
  sebRequired?: boolean
  lastType: QuestionType | null
  onOpenPicker: () => void
  onQuickAdd: (type: QuestionType) => void
}) {
  return (
    <div className="flex w-full">
      <Button
        variant="outline"
        className="flex-1 rounded-r-none border-r-0"
        onClick={onOpenPicker}
        disabled={disabled}
      >
        <Plus className="mr-2 h-4 w-4" />
        Frage hinzufügen
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            className="rounded-l-none px-2"
            disabled={disabled}
            aria-label="Fragetyp direkt wählen"
            title="Fragetyp direkt wählen"
          >
            <ChevronDown className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          {lastType && !(sebRequired && lastType === "FILE_UPLOAD") && (
            <>
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Zuletzt verwendet
              </DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => onQuickAdd(lastType)}>
                {QUESTION_TYPE_LABELS[lastType]}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            Alle Fragetypen
          </DropdownMenuLabel>
          {QUESTION_TYPE_ORDER.map((type) => (
            <DropdownMenuItem
              key={type}
              disabled={sebRequired && type === "FILE_UPLOAD"}
              onSelect={() => onQuickAdd(type)}
            >
              {QUESTION_TYPE_LABELS[type]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export function QuestionBuilder({
  examId,
  sebRequired = false,
  questions,
  disabled,
  onQuestionsChange,
}: QuestionBuilderProps) {
  const [typePickerOpen, setTypePickerOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editingQuestion, setEditingQuestion] = useState<QuestionDraft | null>(
    null
  )
  const [deleteTarget, setDeleteTarget] = useState<Question | null>(null)
  const [bankPickerOpen, setBankPickerOpen] = useState(false)
  const [insertingFromBank, setInsertingFromBank] = useState(false)
  const [savingToBankId, setSavingToBankId] = useState<string | null>(null)
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null)
  const sensors = useSensors(useSensor(PointerSensor))

  function handleDragEnd(event: DragEndEvent) {
    if (disabled) return
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = questions.findIndex((q) => q.id === active.id)
    const newIndex = questions.findIndex((q) => q.id === over.id)
    const reordered = arrayMove(questions, oldIndex, newIndex)
    onQuestionsChange(() => reordered)

    void apiMutateToast(`/api/exams/${examId}/questions/reorder`, {
      method: "PUT",
      body: { questionIds: reordered.map((q) => q.id) },
      fallbackError: "Reihenfolge konnte nicht gespeichert werden",
    })
  }

  function openNewQuestion(type: QuestionType) {
    if (disabled || (sebRequired && type === "FILE_UPLOAD")) return
    setEditingQuestion({
      type,
      title: "",
      points: 1,
      required: true,
      config: null,
    })
    try {
      window.localStorage.setItem(LAST_TYPE_STORAGE_KEY, type)
    } catch {
      // Storage unavailable (private mode) — the shortcut simply stays hidden.
    }
    setSheetOpen(true)
  }

  function openEditQuestion(question: Question) {
    if (disabled) return
    setEditingQuestion({
      id: question.id,
      type: question.type,
      title: question.title,
      points: question.points,
      required: question.required,
      config: question.config,
    })
    setSheetOpen(true)
  }

  async function handleSaveQuestion(draft: QuestionDraft): Promise<boolean> {
    if (draft.id) {
      const result = await apiMutateToast<{ question: Question }>(
        `/api/exams/${examId}/questions/${draft.id}`,
        {
          method: "PATCH",
          body: {
            title: draft.title,
            points: draft.points,
            required: draft.required,
            config: draft.config,
          },
          success: "Frage aktualisiert",
          fallbackError: "Fehler beim Speichern",
        }
      )
      if (!result.ok) return false
      const { question } = result.data
      onQuestionsChange((prev) =>
        prev.map((q) => (q.id === question.id ? { ...q, ...question } : q))
      )
      return true
    } else {
      const result = await apiMutateToast<{ question: Question }>(
        `/api/exams/${examId}/questions`,
        {
          body: {
            type: draft.type,
            title: draft.title,
            points: draft.points,
            required: draft.required,
            config: draft.config,
          },
          success: "Frage hinzugefügt",
          fallbackError: "Fehler beim Hinzufügen",
        }
      )
      if (!result.ok) return false
      onQuestionsChange((prev) => [...prev, result.data.question])
      return true
    }
  }

  async function handleInsertFromBank(bankItemId: string) {
    setInsertingFromBank(true)
    try {
      const result = await apiMutateToast<{ question: Question }>(
        `/api/exams/${examId}/questions/from-bank`,
        {
          body: { bankItemId },
          success: "Frage aus Fragenbank eingefügt",
          fallbackError: "Fehler beim Einfügen",
        }
      )
      if (!result.ok) return
      onQuestionsChange((prev) => [...prev, result.data.question])
      setBankPickerOpen(false)
    } finally {
      setInsertingFromBank(false)
    }
  }

  async function handleDeleteQuestion(id: string) {
    if (disabled) return
    const result = await apiMutateToast(
      `/api/exams/${examId}/questions/${id}`,
      {
        method: "DELETE",
        success: "Frage gelöscht",
        fallbackError: "Fehler beim Löschen",
      }
    )
    if (result.ok) onQuestionsChange((prev) => prev.filter((q) => q.id !== id))
  }

  async function handleDuplicateQuestion(question: Question) {
    if (disabled) return
    setDuplicatingId(question.id)
    // Keep the "(Kopie)" suffix within the 500-char title limit so the
    // duplicate can't fail validation for long titles.
    const suffix = " (Kopie)"
    const baseTitle =
      question.title.length + suffix.length > 500
        ? question.title.slice(0, 500 - suffix.length)
        : question.title
    try {
      const created = await apiMutateToast<{ question: Question }>(
        `/api/exams/${examId}/questions`,
        {
          body: {
            type: question.type,
            title: `${baseTitle}${suffix}`,
            points: question.points,
            required: question.required,
            config: question.config,
          },
          fallbackError: "Fehler beim Duplizieren",
        }
      )
      if (!created.ok) return
      const at = questions.findIndex((q) => q.id === question.id)
      const next = [...questions]
      next.splice(at + 1, 0, created.data.question)
      onQuestionsChange(() => next)

      // The POST appended the copy server-side (order = max+1); persist the
      // intended "right after the original" position so the stored order
      // matches what the teacher sees (mirrors handleDragEnd). Awaited so a
      // failure surfaces before the "success" toast claims the reorder held.
      await apiMutateToast(`/api/exams/${examId}/questions/reorder`, {
        method: "PUT",
        body: { questionIds: next.map((q) => q.id) },
        success: "Frage dupliziert",
        fallbackError: "Reihenfolge konnte nicht gespeichert werden",
      })
    } finally {
      setDuplicatingId(null)
    }
  }

  async function handleSaveToBank(question: Question) {
    if (disabled) return
    setSavingToBankId(question.id)
    try {
      await apiMutateToast<{ deduplicated?: boolean }>(
        "/api/question-bank/from-question",
        {
          body: { examId, questionId: question.id },
          success: (d) =>
            d.deduplicated
              ? "Diese Frage ist bereits in Ihrer Fragenbank"
              : "Frage in Fragenbank gespeichert",
          fallbackError: "Speichern fehlgeschlagen",
        }
      )
    } finally {
      setSavingToBankId(null)
    }
  }

  return (
    <div className="space-y-3">
      {sebRequired && (
        <p className="text-sm text-muted-foreground">
          {SEB_FILE_UPLOAD_MESSAGE}
        </p>
      )}
      {questions.length > 0 && (
        <AddQuestionButton
          disabled={disabled}
          sebRequired={sebRequired}
          lastType={readLastQuestionType()}
          onOpenPicker={() => setTypePickerOpen(true)}
          onQuickAdd={(type) => openNewQuestion(type)}
        />
      )}

      {questions.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ListChecks />
            </EmptyMedia>
            <EmptyTitle>Noch keine Fragen</EmptyTitle>
            <EmptyDescription>
              Fügen Sie Ihre erste Frage hinzu, um mit dieser Prüfung zu
              beginnen.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={questions.map((q) => q.id)}
            strategy={verticalListSortingStrategy}
          >
            {questions.map((q, i) => (
              <SortableQuestionCard
                key={q.id}
                question={q}
                index={i}
                onEdit={() => openEditQuestion(q)}
                onDelete={() => !disabled && setDeleteTarget(q)}
                onDuplicate={() => void handleDuplicateQuestion(q)}
                onSaveToBank={() => void handleSaveToBank(q)}
                savingToBank={savingToBankId === q.id}
                duplicating={duplicatingId === q.id}
                uploadBlocked={sebRequired && q.type === "FILE_UPLOAD"}
                disabled={disabled}
              />
            ))}
          </SortableContext>
        </DndContext>
      )}

      <div className="flex gap-2">
        <div className="flex-1">
          <AddQuestionButton
            disabled={disabled}
            sebRequired={sebRequired}
            lastType={readLastQuestionType()}
            onOpenPicker={() => setTypePickerOpen(true)}
            onQuickAdd={(type) => openNewQuestion(type)}
          />
        </div>
        <Button
          variant="outline"
          className="flex-1"
          onClick={() => setBankPickerOpen(true)}
          disabled={disabled || insertingFromBank}
        >
          <BookMarked className="mr-2 h-4 w-4" />
          Aus Fragenbank
        </Button>
      </div>

      <BankPickerDialog
        sebRequired={sebRequired}
        open={bankPickerOpen}
        onOpenChange={setBankPickerOpen}
        onSelect={(item) => void handleInsertFromBank(item.id)}
      />

      <QuestionTypePicker
        sebRequired={sebRequired}
        open={typePickerOpen}
        onOpenChange={setTypePickerOpen}
        onSelect={(type) => {
          setTypePickerOpen(false)
          openNewQuestion(type)
        }}
      />

      <QuestionSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        question={editingQuestion}
        onSave={handleSaveQuestion}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Frage löschen?</AlertDialogTitle>
            <AlertDialogDescription>
              &quot;{deleteTarget?.title || "(Ohne Titel)"}&quot; wird endgültig
              gelöscht.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (deleteTarget) void handleDeleteQuestion(deleteTarget.id)
                setDeleteTarget(null)
              }}
            >
              Löschen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
