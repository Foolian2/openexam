import React from "react"
import { Text, View } from "@react-pdf/renderer"
import type { PdfQuestionData } from "./types"
import { pdfStyles, pdfColors } from "./styles"
import { TemplateText } from "./question"
import type { QuestionConfig } from "@/lib/types/questions"

/**
 * Solution key for a single question, rendered from the raw (unsanitized)
 * config. Only ever included in teacher printouts (`withSolutions`).
 */
export function PdfSolution({ q }: { q: PdfQuestionData }) {
  if (!q.solution) return null

  let body: React.ReactNode = null
  // The config column is validated on write, so it is trusted here; this
  // pairs it with its type so each case below gets the right config shape.
  const sol = { type: q.type, config: q.solution } as QuestionConfig
  switch (sol.type) {
    case "MULTIPLE_CHOICE": {
      const correct = sol.config.options
        .filter((o) => o.isCorrect)
        .map((o) => o.text)
      body = (
        <Text style={pdfStyles.answerText}>
          Richtig: {correct.length > 0 ? correct.join("; ") : "—"}
        </Text>
      )
      break
    }
    case "FREE_TEXT": {
      const kw = sol.config.expectedKeywords
      body =
        kw && kw.length > 0 ? (
          <Text style={pdfStyles.answerText}>
            Erwartete Schlüsselwörter: {kw.join(", ")}
          </Text>
        ) : (
          <Text style={pdfStyles.answerText}>
            Keine automatische Lösung (manuell bewerten)
          </Text>
        )
      break
    }
    case "FILL_IN_THE_BLANK": {
      const c = sol.config
      body = (
        <TemplateText
          template={c.template}
          blankValue={(id) =>
            c.blanks.find((b) => b.id === id)?.acceptedAnswers.join(" / ") ?? ""
          }
        />
      )
      break
    }
    case "MATCHING": {
      const pairs = sol.config.pairs
      body = (
        <View>
          {pairs.map((p) => (
            <Text
              key={p.id}
              style={[pdfStyles.answerText, { marginBottom: 2 }]}
            >
              {p.left} → {p.right}
            </Text>
          ))}
        </View>
      )
      break
    }
    case "CODE": {
      const tests = sol.config.testCases
      body = (
        <View>
          {tests.map((tc, i) => (
            <Text key={i} style={[pdfStyles.answerText, { marginBottom: 2 }]}>
              {tc.hidden
                ? `Versteckter Testfall ${i + 1}`
                : `Testfall ${i + 1}: Eingabe ${JSON.stringify(tc.input)}`}
              {" → "}
              {JSON.stringify(tc.expectedOutput)}
            </Text>
          ))}
        </View>
      )
      break
    }
    case "TRUE_FALSE": {
      const isCorrect = sol.config.isCorrect
      body = (
        <Text style={pdfStyles.answerText}>
          Richtig: {isCorrect ? "Wahr" : "Falsch"}
        </Text>
      )
      break
    }
    case "SHORT_ANSWER": {
      const accepted = sol.config.acceptedAnswers
      body = (
        <Text style={pdfStyles.answerText}>
          Akzeptierte Antworten:{" "}
          {accepted.length > 0 ? accepted.join("; ") : "—"}
        </Text>
      )
      break
    }
    case "ORDERING": {
      const items = sol.config.items
      body = (
        <View>
          {items.map((item, i) => (
            <Text
              key={item.id}
              style={[pdfStyles.answerText, { marginBottom: 2 }]}
            >
              {i + 1}. {item.text}
            </Text>
          ))}
        </View>
      )
      break
    }
  }

  return (
    <View wrap={false} style={{ marginTop: 6, marginLeft: 10 }}>
      <Text
        style={[
          pdfStyles.answerLabel,
          { color: pdfColors.accent, fontSize: 9, marginBottom: 2 },
        ]}
      >
        Lösung
      </Text>
      {body}
    </View>
  )
}
