import type { QuestionType } from "@/generated/prisma/client"

// MULTIPLE_CHOICE covers single and multi select, so it must not be called
// "Mehrfachauswahl" — that is the name of the multi-select toggle, and it
// mislabelled every single-choice question.
export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  MULTIPLE_CHOICE: "Multiple Choice",
  FREE_TEXT: "Freitext",
  FILL_IN_THE_BLANK: "Lückentext",
  FILE_UPLOAD: "Datei-Upload",
  MATCHING: "Zuordnung",
  CODE: "Programmieraufgabe",
  TRUE_FALSE: "Wahr/Falsch",
  SHORT_ANSWER: "Kurzantwort",
  ORDERING: "Reihenfolge",
}
