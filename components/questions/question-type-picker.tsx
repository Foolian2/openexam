"use client"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  CheckSquare,
  FileText,
  AlignLeft,
  Upload,
  Link2,
  Code2,
  ToggleLeft,
  Type,
  ListOrdered,
} from "lucide-react"
import { SEB_FILE_UPLOAD_MESSAGE } from "@/lib/seb-question-policy"
import type { QuestionType } from "@/generated/prisma/client"

const questionTypes: {
  type: QuestionType
  label: string
  description: string
  icon: React.ReactNode
}[] = [
  {
    type: "MULTIPLE_CHOICE",
    label: "Multiple Choice",
    description: "Ein- oder Mehrfachauswahl aus vorgegebenen Optionen",
    icon: <CheckSquare className="h-6 w-6" />,
  },
  {
    type: "FREE_TEXT",
    label: "Freitext",
    description: "Kurz- oder Langantworteingabe",
    icon: <AlignLeft className="h-6 w-6" />,
  },
  {
    type: "FILL_IN_THE_BLANK",
    label: "Lückentext",
    description: "Text mit ausfüllbaren Lücken",
    icon: <FileText className="h-6 w-6" />,
  },
  {
    type: "FILE_UPLOAD",
    label: "Datei-Upload",
    description: "Dateiabgabe (PDF, Bilder, Dokumente)",
    icon: <Upload className="h-6 w-6" />,
  },
  {
    type: "MATCHING",
    label: "Zuordnung",
    description: "Begriffe und Definitionen einander zuordnen",
    icon: <Link2 className="h-6 w-6" />,
  },
  {
    type: "CODE",
    label: "Programmieraufgabe",
    description: "Code schreiben, Bewertung durch die Lehrperson",
    icon: <Code2 className="h-6 w-6" />,
  },
  {
    type: "TRUE_FALSE",
    label: "Wahr/Falsch",
    description: "Einzelne Aussage als richtig oder falsch markieren",
    icon: <ToggleLeft className="h-6 w-6" />,
  },
  {
    type: "SHORT_ANSWER",
    label: "Kurzantwort",
    description: "Kurze exakte Textantwort (automatisch bewertet)",
    icon: <Type className="h-6 w-6" />,
  },
  {
    type: "ORDERING",
    label: "Reihenfolge",
    description: "Elemente in die richtige Reihenfolge bringen",
    icon: <ListOrdered className="h-6 w-6" />,
  },
]

interface QuestionTypePickerProps {
  open: boolean
  sebRequired?: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (type: QuestionType) => void
}

export function QuestionTypePicker({
  open,
  sebRequired = false,
  onOpenChange,
  onSelect,
}: QuestionTypePickerProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Fragetyp auswählen</DialogTitle>
          <DialogDescription>
            Wählen Sie den Fragetyp für die neue Frage aus.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-3 pt-2 sm:grid-cols-2 md:grid-cols-3">
          {questionTypes.map(({ type, label, description, icon }) => (
            <button
              key={type}
              disabled={sebRequired && type === "FILE_UPLOAD"}
              onClick={() => {
                onSelect(type)
                onOpenChange(false)
              }}
              className="flex flex-col gap-2 rounded-lg border p-4 text-left transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <div className="text-muted-foreground">{icon}</div>
              <div>
                <p className="text-sm font-medium">{label}</p>
                <p className="text-xs leading-snug text-muted-foreground">
                  {sebRequired && type === "FILE_UPLOAD"
                    ? SEB_FILE_UPLOAD_MESSAGE
                    : description}
                </p>
              </div>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
