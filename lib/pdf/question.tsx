import React from "react"
import { Text, View } from "@react-pdf/renderer"
import { pdfStyles, pdfColors } from "./styles"
import type { QuestionType } from "@/lib/validators/question"
import type { MCConfig, StudentQuestionConfig } from "@/lib/types/questions"

export const BLANK_MARK = "________"

/** Splits a fill-blank template into text parts and {n} blank placeholders. */
export function templateParts(
  template: string
): { kind: "text" | "blank"; value: string }[] {
  return template
    .split(/(\{\d+\})/g)
    .filter((part) => part.length > 0)
    .map((part) =>
      /^\{\d+\}$/.test(part)
        ? { kind: "blank" as const, value: part }
        : { kind: "text" as const, value: part }
    )
}

/** Renders template text with blanks replaced by the given filler (or mark). */
export function TemplateText({
  template,
  blankValue,
}: {
  template: string
  blankValue?: (id: string) => string | undefined
}) {
  return (
    <Text style={pdfStyles.answerText}>
      {templateParts(template).map((part, i) =>
        part.kind === "text" ? (
          <Text key={i}>{part.value}</Text>
        ) : (
          <Text key={i} style={pdfStyles.blank}>
            {blankValue
              ? blankValue(part.value.slice(1, -1)) || BLANK_MARK
              : BLANK_MARK}
          </Text>
        )
      )}
    </Text>
  )
}

function OptionList({ config }: { config: MCConfig }) {
  return (
    <View>
      {config.options.map((opt, i) => (
        <View key={opt.id} style={pdfStyles.optionRow}>
          <Text style={pdfStyles.optionText}>
            {String.fromCharCode(97 + i)}) {opt.text}
          </Text>
        </View>
      ))}
    </View>
  )
}

function MatchingColumns({ config }: { config: unknown }) {
  // Sanitized shape: decoupled left/right columns with opaque right ids.
  const sanitized = config as {
    left?: { id: string; text: string }[]
    right?: { id: string; text: string }[]
  }
  // Raw shape (teacher answer sheets): pairs with the coupling visible.
  const raw = config as {
    pairs?: { id: string; left: string; right: string }[]
  }

  const left =
    sanitized.left ?? raw.pairs?.map((p) => ({ id: p.id, text: p.left })) ?? []
  const right =
    sanitized.right ??
    raw.pairs?.map((p) => ({ id: p.id, text: p.right })) ??
    []

  return (
    <View style={{ flexDirection: "row", gap: 24, marginBottom: 4 }}>
      <View style={{ flexGrow: 1 }}>
        {left.map((item, i) => (
          <Text
            key={item.id}
            style={[pdfStyles.optionText, { marginBottom: 3 }]}
          >
            {i + 1}. {item.text}
          </Text>
        ))}
      </View>
      <View style={{ flexGrow: 1 }}>
        {right.map((item, i) => (
          <Text
            key={item.id}
            style={[pdfStyles.optionText, { marginBottom: 3 }]}
          >
            {String.fromCharCode(65 + i)}) {item.text}
          </Text>
        ))}
      </View>
    </View>
  )
}

/** Question prompt rendered from a student-safe config (no solutions). */
export function PdfQuestion({
  q,
}: {
  q: {
    index: number
    type: QuestionType
    title: string
    points: number
    config: unknown
  }
}) {
  let body: React.ReactNode = null

  // The config column is validated on write, so it is trusted here; this
  // pairs it with its type so each case below gets the right config shape.
  const sq = { type: q.type, config: q.config } as StudentQuestionConfig
  switch (sq.type) {
    case "MULTIPLE_CHOICE":
      body = <OptionList config={sq.config} />
      break
    case "FILL_IN_THE_BLANK":
      body = <TemplateText template={sq.config.template ?? ""} />
      break
    case "MATCHING":
      body = <MatchingColumns config={sq.config} />
      break
    case "CODE": {
      const c = sq.config
      body = (
        <View>
          {c.starterCode && (
            <Text style={pdfStyles.code}>
              {c.starterCode.split("\n").join("\n")}
            </Text>
          )}
          {c.testCases.length > 0 && (
            <Text style={[pdfStyles.answerText, { color: pdfColors.muted }]}>
              Sichtbare Testfälle: {c.testCases.length}
            </Text>
          )}
        </View>
      )
      break
    }
    case "TRUE_FALSE":
      body = (
        <View>
          <Text style={[pdfStyles.optionText, { marginBottom: 3 }]}>
            a) Wahr
          </Text>
          <Text style={pdfStyles.optionText}>b) Falsch</Text>
        </View>
      )
      break
    case "SHORT_ANSWER":
      body = (
        <Text style={[pdfStyles.answerText, { color: pdfColors.muted }]}>
          Kurze Antwort (max. {sq.config.maxLength} Zeichen)
        </Text>
      )
      break
    case "ORDERING": {
      const c = sq.config
      body = (
        <View>
          {c.items.map((item, i) => (
            <Text
              key={item.id}
              style={[pdfStyles.optionText, { marginBottom: 3 }]}
            >
              {i + 1}. {item.text}
            </Text>
          ))}
        </View>
      )
      break
    }
    case "FREE_TEXT": {
      const c = sq.config
      body = (
        <Text style={[pdfStyles.answerText, { color: pdfColors.muted }]}>
          Freitextantwort (max. {c.maxLength} Zeichen)
        </Text>
      )
      break
    }
    case "FILE_UPLOAD": {
      const c = sq.config
      body = (
        <View>
          {c.instructions && (
            <Text style={pdfStyles.answerText}>{c.instructions}</Text>
          )}
          <Text style={[pdfStyles.answerText, { color: pdfColors.muted }]}>
            Datei-Upload (erlaubt:{" "}
            {(c.allowedExtensions ?? []).join(", ") || "alle"})
          </Text>
        </View>
      )
      break
    }
  }

  return (
    <View wrap={false}>
      <View style={pdfStyles.questionHeader}>
        <Text style={pdfStyles.questionTitle}>
          {q.index}. {q.title}
        </Text>
        <Text style={pdfStyles.points}>{q.points} P.</Text>
      </View>
      {body}
    </View>
  )
}
