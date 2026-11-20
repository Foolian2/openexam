// Thundering herd: every student in every room submits inside a few seconds,
// the way a real exam ends when the timer runs out and 500 people click
// "Abgeben" at once.
//
// This is the heaviest burst the system can experience and nothing exercised
// it before. One POST /api/sessions/{id}/submit costs, per
// app/api/sessions/[id]/submit/route.ts: a session lookup, a SEB guard, a
// serialisable transaction, autoGradeSession(), an audit-log write and a
// Redis SESSION_SUBMITTED publish — which ws-backend turns into a
// FlushExamNow (internal/store/buffer.go), forcing the write-behind buffer
// for that exam straight to Postgres instead of waiting for the 5s tick.
//
//   k6 run load/scenarios/07-mass-submit.js -e CLASSES=8 -e STUDENTS_PER_CLASS=25
// Requires: pnpm load:seed -- --count <CLASSES*STUDENTS_PER_CLASS> --teachers <CLASSES>
//
// Each session can only be submitted once, so this is a single-iteration
// scenario: shared-iterations with exactly one iteration per VU. Re-running
// it needs freshly joined sessions — run-ladder.sh re-provisions between
// repeats.
import http from "k6/http"
import { check, sleep } from "k6"
import { Trend, Counter, Rate } from "k6/metrics"
import { BASE_URL, TLS_OPTIONS } from "../config.js"
import { authHeadersForUser } from "../lib/auth.js"
import { provisionClassrooms, roomForVU } from "../lib/room.js"
import { parsePayloadMix, pickAnswer, saveAnswerRest, DEFAULT_PAYLOAD_MIX } from "../lib/answers.js"
import { durationToMs } from "../lib/helpers.js"

const CLASSES = Number(__ENV.CLASSES || 4)
const STUDENTS_PER_CLASS = Number(__ENV.STUDENTS_PER_CLASS || 25)
// How tightly the herd bunches. 5s is realistic for "the timer hit zero";
// drop it to 1s to find the hard breaking point.
const SUBMIT_WINDOW = __ENV.SUBMIT_WINDOW || "5s"
// Pre-load each session with one answer so submit has real grading work to
// do and a non-empty write-behind buffer to flush.
const PRELOAD_ANSWERS = __ENV.PRELOAD_ANSWERS !== "false"

const STUDENTS = CLASSES * STUDENTS_PER_CLASS

const payloadMix = parsePayloadMix(__ENV.PAYLOAD_MIX || DEFAULT_PAYLOAD_MIX)

export const submitDuration = new Trend("submit_duration", true)
export const submitSuccess = new Rate("submit_success")
export const submitConflict = new Counter("submit_conflict")
// Counter, not a count threshold on the submit_duration Trend — k6 rejects
// count aggregation on trends.
export const submitTotal = new Counter("submit_total")

export const options = {
  ...TLS_OPTIONS,
  setupTimeout: "30m",
  scenarios: {
    herd: {
      executor: "shared-iterations",
      vus: STUDENTS,
      iterations: STUDENTS, // exactly one submit per session
      maxDuration: "10m",
    },
  },
  thresholds: {
    // No prior target exists for submit — this run establishes one. The
    // assertions that matter here are that everyone gets through and nobody
    // double-submits.
    submit_success: ["rate>0.99"],
    submit_conflict: ["count<1"],
    submit_total: [`count>=${STUDENTS}`],
  },
}

export function setup() {
  return provisionClassrooms("submit", {
    classes: CLASSES,
    studentsPerClass: STUDENTS_PER_CLASS,
  })
}

export default function massSubmit(data) {
  const assigned = roomForVU(data, __VU)
  if (!assigned) return

  const authHeaders = authHeadersForUser(assigned.user)

  if (PRELOAD_ANSWERS) {
    const { content, questionType } = pickAnswer(payloadMix)
    saveAnswerRest(
      authHeaders,
      assigned.sessionId,
      assigned.room.questionIdsByType[questionType],
      content
    )
  }

  // Spread the submits across SUBMIT_WINDOW rather than firing every VU the
  // instant it finishes preloading — otherwise the herd's shape is decided by
  // how long the preload happened to take per VU, not by the window.
  sleep((Math.random() * durationToMs(SUBMIT_WINDOW)) / 1000)

  const start = Date.now()
  const res = http.post(
    `${BASE_URL}/api/sessions/${assigned.sessionId}/submit`,
    JSON.stringify({ idempotencyKey: `k6-submit-${assigned.sessionId}` }),
    {
      headers: { ...authHeaders, "Content-Type": "application/json" },
      tags: { name: "submit" },
    }
  )
  submitDuration.add(Date.now() - start)
  submitTotal.add(1)

  const ok = res.status === 200 || res.status === 201
  submitSuccess.add(ok)
  // 409 means the session was already submitted under a different key —
  // a real double-submit bug, distinct from the idempotent replay path.
  if (res.status === 409) submitConflict.add(1)
  check(res, { "submit ok": () => ok })
  if (!ok) console.error(`submit failed: ${res.status} ${res.body}`)
}
