// Answer-content builders and the REST autosave helper.
//
// Shapes mirror the discriminated union in lib/validators/answer.ts. Three
// different size ceilings apply to the same payload and they do not agree —
// a scenario that ignores this silently generates INVALID_ANSWER errors
// instead of load:
//
//   - lib/validators/answer.ts   per-field caps (FREE_TEXT 10 000 chars,
//                                SHORT_ANSWER 1 000, CODE 50 000)
//   - ws-backend/internal/hub/answer_validation.go:35
//                                whole `content` object capped at 52 KiB,
//                                which CODE at its 50 000-char maximum can
//                                exceed once JSON-escaped
//   - ws-backend/main.go         readLimitBytes 64 KiB for the entire
//                                envelope; past it the socket is closed,
//                                not answered with answer:error
//
// So the builders below stay well inside all three by default; use
// oversizedCodeAnswer() to probe the boundary on purpose.
import http from "k6/http"
import { check } from "k6"
import { BASE_URL } from "../config.js"

export const WS_CONTENT_LIMIT_BYTES = 52 * 1024 // answer_validation.go
export const WS_READ_LIMIT_BYTES = 64 * 1024 // main.go readLimitBytes

function filler(chars) {
  // Deterministic, non-repeating enough that gzip/JSON escaping behaves like
  // real prose rather than a single run-length-compressible run.
  const base = "Die Hauptstadt der Schweiz ist Bern, nicht Zuerich oder Genf. "
  let out = ""
  while (out.length < chars) out += base
  return out.slice(0, chars)
}

export function multipleChoiceAnswer(optionId = "opt-bern") {
  return { type: "MULTIPLE_CHOICE", selectedOptionIds: [optionId] }
}

export function freeTextAnswer(chars = 800) {
  return { type: "FREE_TEXT", text: filler(Math.min(chars, 10000)) }
}

export function shortAnswerAnswer(chars = 40) {
  return { type: "SHORT_ANSWER", text: filler(Math.min(chars, 1000)) }
}

export function trueFalseAnswer(selected = true) {
  return { type: "TRUE_FALSE", selected }
}

export function codeAnswer(chars = 2000) {
  return { type: "CODE", code: filler(Math.min(chars, 50000)), language: "python" }
}

// Deliberately past answer_validation.go's 52 KiB content cap but inside the
// 64 KiB socket read limit — the server should answer INVALID_ANSWER and keep
// the connection open. Used by the boundary probe, never by the payload mix.
export function oversizedCodeAnswer() {
  return { type: "CODE", code: filler(50000), language: "python" }
}

const BUILDERS = {
  mc: () => multipleChoiceAnswer(),
  text: () => freeTextAnswer(),
  short: () => shortAnswerAnswer(),
  tf: () => trueFalseAnswer(),
  code: () => codeAnswer(),
}

// Maps a mix key to the question type it must be answered against — the
// server checks content.type against the question's own type
// (answer_validation.go's expectedType), so a mix entry is only usable if the
// room's exam actually carries that question.
export const QUESTION_TYPE_BY_MIX_KEY = {
  mc: "MULTIPLE_CHOICE",
  text: "FREE_TEXT",
  short: "SHORT_ANSWER",
  tf: "TRUE_FALSE",
  code: "CODE",
}

export const DEFAULT_PAYLOAD_MIX = "mc:0.5,text:0.35,short:0.1,code:0.05"

// Parses "mc:0.5,text:0.35,..." into cumulative weights once, at init time.
// Weights need not sum to 1; they're normalised.
export function parsePayloadMix(spec = DEFAULT_PAYLOAD_MIX) {
  const entries = spec
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [key, weight] = part.split(":")
      if (!BUILDERS[key]) throw new Error(`unknown payload mix key "${key}" in "${spec}"`)
      const parsed = Number(weight)
      if (!(parsed > 0)) throw new Error(`payload mix weight for "${key}" must be > 0`)
      return { key, weight: parsed }
    })
  if (entries.length === 0) throw new Error(`empty payload mix: "${spec}"`)

  const total = entries.reduce((sum, e) => sum + e.weight, 0)
  let cumulative = 0
  return entries.map((e) => {
    cumulative += e.weight / total
    return { key: e.key, upTo: cumulative }
  })
}

// Picks one answer from a parsed mix. Returns { key, questionType, content }
// so the caller can look up the matching questionId for this room.
export function pickAnswer(mix, random = Math.random()) {
  const chosen = mix.find((e) => random <= e.upTo) || mix[mix.length - 1]
  return {
    key: chosen.key,
    questionType: QUESTION_TYPE_BY_MIX_KEY[chosen.key],
    content: BUILDERS[chosen.key](),
  }
}

// PUT /api/sessions/{id}/answers — the REST fallback autosave path, used
// directly by scenario 02 and as the "WS down" fallback fraction in
// scenarios 05 and 06. authHeaders is the { Cookie, Origin } object from
// auth.js.
export function saveAnswerRest(authHeaders, sessionId, questionId, content) {
  const res = http.put(
    `${BASE_URL}/api/sessions/${sessionId}/answers`,
    JSON.stringify({ questionId, content, clientTimestamp: Date.now() }),
    {
      headers: { ...authHeaders, "Content-Type": "application/json" },
      tags: { name: "answer_save_rest" },
    }
  )
  // Log the first few failures with their body. A 500 storm on this endpoint
  // otherwise produces no diagnostic anywhere: k6 only counts it, and the
  // Next.js route rethrows non-AnswerError exceptions without logging, so the
  // web container's stdout stays completely silent through tens of thousands
  // of 500s.
  if (!check(res, { "answer save ok": (r) => r.status === 200 }) && restSaveFailuresLogged < 3) {
    restSaveFailuresLogged++
    console.error(`answer_save_rest ${res.status}: ${String(res.body).slice(0, 300)}`)
  }
  return res
}

let restSaveFailuresLogged = 0
