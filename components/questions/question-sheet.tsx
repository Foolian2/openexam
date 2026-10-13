"use client"

import { useMemo, useRef, useState, type ComponentType } from "react"
import { nanoid } from "nanoid"
import { Eye } from "lucide-react"
import {
  MAX_QUESTION_POINTS,
  configSchemaByType,
} from "@/lib/validators/question"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetFooter,
} from "@/components/ui/sheet"
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
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  InteractivePreview,
  previewStructureKey,
} from "./viewer/interactive-preview"
import { MCEditor } from "./editor/mc-editor"
import { FreeTextEditor } from "./editor/free-text-editor"
import { FillBlankEditor } from "./editor/fill-blank-editor"
import { FileUploadEditor } from "./editor/file-upload-editor"
import { MatchingEditor } from "./editor/matching-editor"
import { CodeEditor } from "./editor/code-editor"
import { TrueFalseEditor } from "./editor/true-false-editor"
import { ShortAnswerEditor } from "./editor/short-answer-editor"
import { OrderingEditor } from "./editor/ordering-editor"
import { QUESTION_TYPE_LABELS as TYPE_LABELS } from "@/lib/constants/question-types"
import type {
  ConfigByType,
  QuestionConfig,
  QuestionType,
} from "@/lib/types/questions"

/** Starting config for a new question — typed per type, so it can't drift from the editor. */
const DEFAULT_CONFIGS: { [T in QuestionType]: () => ConfigByType[T] } = {
  MULTIPLE_CHOICE: () => ({
    multiSelect: false,
    options: [
      { id: nanoid(), text: "", isCorrect: false },
      { id: nanoid(), text: "", isCorrect: false },
    ],
  }),
  FREE_TEXT: () => ({ maxLength: 500, richText: false }),
  FILL_IN_THE_BLANK: () => ({ template: "", blanks: [] }),
  FILE_UPLOAD: () => ({
    allowedExtensions: [".pdf"],
    maxFileSizeMB: 10,
    instructions: "",
  }),
  MATCHING: () => ({
    pairs: [
      { id: nanoid(), left: "", right: "" },
      { id: nanoid(), left: "", right: "" },
      { id: nanoid(), left: "", right: "" },
    ],
    shuffleSides: false,
  }),
  CODE: () => ({ language: "python", starterCode: "", testCases: [] }),
  TRUE_FALSE: () => ({ isCorrect: true }),
  SHORT_ANSWER: () => ({
    acceptedAnswers: [""],
    caseSensitive: false,
    maxLength: 200,
  }),
  ORDERING: () => ({
    items: [
      { id: nanoid(), text: "" },
      { id: nanoid(), text: "" },
      { id: nanoid(), text: "" },
    ],
    shuffle: true,
  }),
}

interface EditorProps<T extends QuestionType> {
  config: ConfigByType[T]
  onChange: (config: ConfigByType[T]) => void
  /** Used by the editors with a rubric (FREE_TEXT, SHORT_ANSWER). */
  questionPoints: number
}

/** One editor per question type — a missing type is a compile error. */
const EDITORS: { [T in QuestionType]: ComponentType<EditorProps<T>> } = {
  MULTIPLE_CHOICE: MCEditor,
  FREE_TEXT: FreeTextEditor,
  FILL_IN_THE_BLANK: FillBlankEditor,
  FILE_UPLOAD: FileUploadEditor,
  MATCHING: MatchingEditor,
  CODE: CodeEditor,
  TRUE_FALSE: TrueFalseEditor,
  SHORT_ANSWER: ShortAnswerEditor,
  ORDERING: OrderingEditor,
}

const PATH_LABELS: Record<string, string> = {
  options: "Optionen",
  pairs: "Paare",
  items: "Elemente",
  blanks: "Lücken",
  acceptedAnswers: "Akzeptierte Antworten",
  testCases: "Testfälle",
  template: "Vorlage",
  multiSelect: "Mehrfachauswahl",
  shuffle: "Zufallsreihenfolge",
  shuffleSides: "Seiten mischen",
  caseSensitive: "Gross-/Kleinschreibung",
  richText: "Formatierung",
  maxLength: "Maximale Länge",
  maxFileSizeMB: "Maximale Dateigrösse",
  allowedExtensions: "Erlaubte Dateitypen",
  language: "Programmiersprache",
  instructions: "Anleitung",
  starterCode: "Startcode",
  isCorrect: "Korrekte Antwort",
  left: "Linke Seite",
  right: "Rechte Seite",
  text: "Text",
  id: "ID",
  rubric: "Bewertungsraster",
  criterion: "Kriterium",
}

function formatIssuePath(path: PropertyKey[], config: unknown): string {
  const parts: string[] = []
  // Walk the config alongside the path so a blank is named by its own id:
  // the editor labels blanks "Lücke 3" after {3}, which is not their
  // position once a middle placeholder has been removed.
  let node: unknown = config
  let parentKey: PropertyKey | undefined
  for (const seg of path) {
    const child =
      node !== null && typeof node === "object"
        ? (node as Record<PropertyKey, unknown>)[seg]
        : undefined
    if (typeof seg === "number") {
      const blankId =
        parentKey === "blanks" &&
        child !== null &&
        typeof child === "object" &&
        typeof (child as { id?: unknown }).id === "string"
          ? (child as { id: string }).id
          : null
      parts[parts.length - 1] =
        blankId !== null
          ? `Lücke ${blankId}`
          : `${parts[parts.length - 1]} ${seg + 1}`
    } else if (typeof seg === "string") {
      parts.push(PATH_LABELS[seg] ?? seg)
    } else {
      parts.push(String(seg))
    }
    node = child
    parentKey = seg
  }
  return parts.length === 0 ? "Konfiguration" : parts.join(" · ")
}

export interface QuestionDraft {
  id?: string
  type: QuestionType
  title: string
  points: number
  required: boolean
  config: unknown
}

interface QuestionSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  question: QuestionDraft | null
  /** Returns whether the save succeeded — on failure the sheet stays open. */
  onSave: (q: QuestionDraft) => Promise<boolean>
}

function QuestionSheetInner({
  question,
  onSave,
  onRequestClose,
  onDirtyChange,
}: {
  question: QuestionDraft
  onSave: (q: QuestionDraft) => Promise<boolean>
  onRequestClose: () => void
  onDirtyChange: (dirty: boolean) => void
}) {
  const [initialConfig] = useState<unknown>(
    () => question.config ?? DEFAULT_CONFIGS[question.type]()
  )
  const [initialTitle] = useState(question.title)
  const [initialPointsInput] = useState(String(question.points))
  const [initialRequired] = useState(question.required)
  const [title, setTitle] = useState(initialTitle)
  const [pointsInput, setPointsInput] = useState(initialPointsInput)
  const [required, setRequired] = useState(initialRequired)
  const [config, setConfig] = useState<unknown>(initialConfig)
  const [isSaving, setIsSaving] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)

  const points = pointsInput === "" ? NaN : Number(pointsInput)
  const pointsValid =
    Number.isFinite(points) && points > 0 && points <= MAX_QUESTION_POINTS

  // The per-type editors replace the config object on every change, so a
  // reference comparison is a cheap and reliable "has anything changed"
  // check. Kept in sync with the parent so closing (Escape, outside click,
  // the X button) can be intercepted before unsaved work is lost.
  const dirty = useMemo(() => {
    if (title !== initialTitle || required !== initialRequired) return true
    if (pointsInput !== initialPointsInput) return true
    return config !== initialConfig
  }, [
    title,
    required,
    pointsInput,
    config,
    initialTitle,
    initialRequired,
    initialPointsInput,
    initialConfig,
  ])

  // Written synchronously during render (not in an effect) so the parent's
  // dirtyRef is always current by the time a close request is handled —
  // an effect-based update lags a render behind and can let an Escape or
  // outside-click close slip past the guard right after an edit.
  onDirtyChange(dirty)

  const configIssues = useMemo(() => {
    const result = configSchemaByType[question.type].safeParse(config)
    return result.success ? [] : result.error.issues
  }, [question.type, config])
  const configValid = configIssues.length === 0

  async function handleSave() {
    if (!pointsValid || !configValid) return
    setIsSaving(true)
    try {
      const saved = await onSave({
        ...question,
        title,
        points,
        required,
        config,
      })
      // Only close (and clear the dirty flag) when the save actually
      // succeeded — otherwise the edits would be silently discarded.
      if (saved) {
        onDirtyChange(false)
        onRequestClose()
      }
    } finally {
      setIsSaving(false)
    }
  }

  const type = question.type
  const Editor = EDITORS[type] as ComponentType<EditorProps<QuestionType>>

  return (
    <>
      <SheetHeader className="border-b px-6 pt-6 pb-4">
        <SheetTitle>{TYPE_LABELS[type]}</SheetTitle>
      </SheetHeader>

      <ScrollArea className="min-h-0 flex-1 px-6 py-4">
        <div className="space-y-5 pb-4">
          <div>
            <Label htmlFor="q-title">Fragestellung *</Label>
            <Input
              id="q-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="z.B. Was ist die Hauptstadt der Schweiz?"
              className="mt-1"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="q-points">Punkte</Label>
              <Input
                id="q-points"
                type="number"
                min={0.5}
                max={MAX_QUESTION_POINTS}
                step={0.5}
                value={pointsInput}
                onChange={(e) => setPointsInput(e.target.value)}
                aria-invalid={!pointsValid}
                className="mt-1"
              />
              {!pointsValid && (
                <p className="mt-1 text-xs text-destructive">
                  {points > MAX_QUESTION_POINTS
                    ? `Maximal ${MAX_QUESTION_POINTS} Punkte`
                    : "Punkte müssen grösser als 0 sein"}
                </p>
              )}
            </div>
            <div className="flex items-end gap-2 pb-0.5">
              <Switch
                id="q-required"
                checked={required}
                onCheckedChange={setRequired}
              />
              <Label htmlFor="q-required" className="font-normal">
                Pflichtfrage
              </Label>
            </div>
          </div>

          <div className="border-t pt-4">
            <Editor
              // The draft config is only validated for save/preview
              // (configIssues); the editor is what makes it valid, so it
              // receives the draft as-is.
              config={config as never}
              onChange={setConfig}
              questionPoints={pointsValid ? points : 0}
            />

            <div className="pt-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setPreviewOpen((o) => !o)}
              >
                <Eye className="mr-1 h-3.5 w-3.5" />
                Schülervorschau {previewOpen ? "ausblenden" : "anzeigen"}
              </Button>
              {previewOpen && (
                <div className="mt-2 rounded-lg border p-4">
                  {configValid ? (
                    // The viewers read the config once on mount (ordering's
                    // reset baseline, matching's slot layout), so the preview
                    // is remounted whenever the config's structure changes.
                    <InteractivePreview
                      key={previewStructureKey(type, config)}
                      // Validated by configIssues above.
                      question={{ type, config } as QuestionConfig}
                    />
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Vorschau verfügbar, sobald die Konfiguration vollständig
                      ist.
                    </p>
                  )}
                </div>
              )}
            </div>

            {configIssues.length > 0 && (
              <ul className="mt-2 space-y-1 text-xs text-destructive">
                {configIssues.map((issue, i) => (
                  <li key={i}>
                    {formatIssuePath(issue.path, config)}: {issue.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </ScrollArea>

      <SheetFooter className="gap-2 border-t px-6 py-4">
        <Button variant="outline" onClick={onRequestClose}>
          Abbrechen
        </Button>
        <Button
          onClick={handleSave}
          disabled={isSaving || !title.trim() || !pointsValid || !configValid}
        >
          {isSaving ? "Wird gespeichert…" : "Speichern"}
        </Button>
      </SheetFooter>
    </>
  )
}

export function QuestionSheet({
  open,
  onOpenChange,
  question,
  onSave,
}: QuestionSheetProps) {
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false)
  const dirtyRef = useRef(false)

  const handleOpenChange = (next: boolean) => {
    if (!next && dirtyRef.current) {
      setDiscardConfirmOpen(true)
      return
    }
    onOpenChange(next)
  }

  const discard = () => {
    setDiscardConfirmOpen(false)
    dirtyRef.current = false
    onOpenChange(false)
  }

  return (
    <>
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
          {question && (
            <QuestionSheetInner
              key={question.id ?? question.type}
              question={question}
              onSave={onSave}
              onRequestClose={() => handleOpenChange(false)}
              onDirtyChange={(dirty) => {
                dirtyRef.current = dirty
              }}
            />
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog
        open={discardConfirmOpen}
        onOpenChange={setDiscardConfirmOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Änderungen verwerfen?</AlertDialogTitle>
            <AlertDialogDescription>
              Die Frage enthält nicht gespeicherte Änderungen. Wenn Sie
              fortfahren, gehen diese verloren.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Weiter bearbeiten</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={discard}
            >
              Verwerfen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
