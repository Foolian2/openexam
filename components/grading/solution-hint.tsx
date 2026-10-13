import type { GradedQuestion } from "./answer-display"

/** Shows the expected solution next to the student's answer. */
export function SolutionHint({ question }: { question: GradedQuestion }) {
  switch (question.type) {
    case "MULTIPLE_CHOICE": {
      const { config } = question
      const correct = config.options.filter((o) => o.isCorrect)
      return (
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Korrekt:</span>{" "}
          {correct.map((o) => o.text).join(", ")}
        </p>
      )
    }
    case "FILL_IN_THE_BLANK": {
      const { config } = question
      return (
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Akzeptiert:</span>{" "}
          {config.blanks
            .map((b, i) => `Lücke ${i + 1}: ${b.acceptedAnswers.join(" / ")}`)
            .join(" · ")}
        </p>
      )
    }
    case "MATCHING": {
      const { config } = question
      return (
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Korrekte Paare:</span>{" "}
          {config.pairs.map((p) => `${p.left} → ${p.right}`).join(" · ")}
        </p>
      )
    }
    case "FREE_TEXT": {
      const { config } = question
      if (!config.expectedKeywords?.length) return null
      return (
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">
            Erwartete Stichworte:
          </span>{" "}
          {config.expectedKeywords.join(", ")}
        </p>
      )
    }
    case "TRUE_FALSE": {
      const { config } = question
      return (
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Korrekt:</span>{" "}
          {config.isCorrect ? "Wahr" : "Falsch"}
        </p>
      )
    }
    case "SHORT_ANSWER": {
      const { config } = question
      return (
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Akzeptiert:</span>{" "}
          {config.acceptedAnswers.join(" / ")}
          {!config.caseSensitive && " ( Gross-/Kleinschreibung ignoriert)"}
        </p>
      )
    }
    case "ORDERING": {
      const { config } = question
      return (
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">
            Korrekte Reihenfolge:
          </span>{" "}
          {config.items.map((i) => i.text).join(" → ")}
        </p>
      )
    }
    default:
      return null
  }
}
