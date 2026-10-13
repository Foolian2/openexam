import React from "react"
import { Text, View } from "@react-pdf/renderer"
import type { PdfAnswerData } from "./types"
import { pdfStyles, pdfColors } from "./styles"
import { TemplateText } from "./question"
import type { ViewerQuestionConfig } from "@/lib/types/questions"

function MatchingTexts({ config }: { config: unknown }) {
  if (
    config &&
    typeof config === "object" &&
    "pairs" in config &&
    Array.isArray((config as { pairs?: unknown }).pairs)
  ) {
    const c = config as { pairs: { id: string; left: string; right: string }[] }
    return {
      leftText: (id: string) => c.pairs.find((p) => p.id === id)?.left,
      rightText: (id: string) => c.pairs.find((p) => p.id === id)?.right,
    }
  }
  const c = config as {
    left?: { id: string; text: string }[]
    right?: { id: string; text: string }[]
  }
  return {
    leftText: (id: string) => c.left?.find((l) => l.id === id)?.text,
    rightText: (id: string) => c.right?.find((r) => r.id === id)?.text,
  }
}

/** Renders multi-line text as separate lines (react-pdf has no whiteSpace style). */
function MultiLine({
  text,
  style,
}: {
  text: string
  style?: (typeof pdfStyles)[keyof typeof pdfStyles]
}) {
  const lines = text.split("\n")
  return (
    <View>
      {lines.map((line, i) => (
        <Text key={i} style={style}>
          {line}
        </Text>
      ))}
    </View>
  )
}

/** A student's recorded answer, rendered read-only (id-based lookups against `config`). */
export function PdfAnswer({ a }: { a: PdfAnswerData }) {
  const answer = a.answer as Record<string, unknown> | undefined
  let body: React.ReactNode = null

  // The config column is validated on write, so it is trusted here; this
  // pairs it with its type so each case below gets the right config shape.
  const av = { type: a.type, config: a.config } as ViewerQuestionConfig
  switch (av.type) {
    case "MULTIPLE_CHOICE": {
      const selected = (answer?.selectedOptionIds as string[] | undefined) ?? []
      body = (
        <View>
          {av.config.options.map((opt) => (
            <View key={opt.id} style={pdfStyles.optionRow}>
              <Text style={pdfStyles.optionText}>
                {selected.includes(opt.id) ? "[X] " : "[ ] "}
                {opt.text}
              </Text>
            </View>
          ))}
        </View>
      )
      break
    }
    case "FREE_TEXT":
    case "SHORT_ANSWER": {
      const text = (answer?.text as string | undefined) ?? ""
      body =
        text.trim().length > 0 ? (
          <MultiLine text={text} style={pdfStyles.answerText} />
        ) : (
          <Text style={[pdfStyles.answerText, { color: pdfColors.faint }]}>
            Keine Antwort
          </Text>
        )
      break
    }
    case "FILL_IN_THE_BLANK": {
      const blanks =
        (answer?.blanks as { id: string; value: string }[] | undefined) ?? []
      body = (
        <TemplateText
          template={av.config.template ?? ""}
          blankValue={(id) => blanks.find((b) => b.id === id)?.value}
        />
      )
      break
    }
    case "FILE_UPLOAD": {
      const fileName = (answer?.fileName as string | undefined) ?? ""
      body = (
        <Text style={pdfStyles.answerText}>
          {fileName ? `Datei: ${fileName}` : "Keine Datei abgegeben"}
        </Text>
      )
      break
    }
    case "MATCHING": {
      const matches =
        (answer?.matches as
          { leftId: string; rightId: string }[] | undefined) ?? []
      const { leftText, rightText } = MatchingTexts({ config: av.config })
      body = (
        <View>
          {matches.map((m) => (
            <Text
              key={`${m.leftId}:${m.rightId}`}
              style={[pdfStyles.answerText, { marginBottom: 3 }]}
            >
              {leftText(m.leftId) ?? m.leftId} → {rightText(m.rightId) ?? "?"}
            </Text>
          ))}
          {matches.length === 0 && (
            <Text style={[pdfStyles.answerText, { color: pdfColors.faint }]}>
              Keine Zuordnung
            </Text>
          )}
        </View>
      )
      break
    }
    case "CODE": {
      const code = (answer?.code as string | undefined) ?? ""
      body =
        code.trim().length > 0 ? (
          <MultiLine text={code} style={pdfStyles.code} />
        ) : (
          <Text style={[pdfStyles.answerText, { color: pdfColors.faint }]}>
            Kein Code abgegeben
          </Text>
        )
      break
    }
    case "TRUE_FALSE": {
      const selected = answer?.selected as boolean | undefined
      body = (
        <Text style={pdfStyles.answerText}>
          {selected === undefined
            ? "Keine Antwort"
            : selected
              ? "[X] Wahr   [ ] Falsch"
              : "[ ] Wahr   [X] Falsch"}
        </Text>
      )
      break
    }
    case "ORDERING": {
      const items = av.config.items ?? []
      const orderedIds = (answer?.orderedIds as string[] | undefined) ?? []
      body = (
        <View>
          {orderedIds.map((id, i) => {
            const item = items.find((it) => it.id === id)
            return (
              <Text
                key={id}
                style={[pdfStyles.optionText, { marginBottom: 3 }]}
              >
                {i + 1}. {item?.text ?? id}
              </Text>
            )
          })}
          {orderedIds.length === 0 && (
            <Text style={[pdfStyles.answerText, { color: pdfColors.faint }]}>
              Keine Antwort
            </Text>
          )}
        </View>
      )
      break
    }
  }

  return (
    <View style={pdfStyles.answerBlock} wrap={false}>
      {a.grade && (
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            marginBottom: 2,
          }}
        >
          <Text style={pdfStyles.answerLabel}>Antwort</Text>
          <Text
            style={[
              pdfStyles.gradePill,
              {
                color:
                  a.grade.points >= a.grade.maxPoints
                    ? pdfColors.success
                    : pdfColors.ink,
              },
            ]}
          >
            {a.grade.points} / {a.grade.maxPoints} P.
          </Text>
        </View>
      )}
      {!a.grade && <Text style={pdfStyles.answerLabel}>Antwort</Text>}
      {body}
      {a.grade?.feedback && (
        <Text style={pdfStyles.feedback}>Feedback: {a.grade.feedback}</Text>
      )}
    </View>
  )
}
