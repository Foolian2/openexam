// A/B against 06: identical student load, plus integrity:event traffic.
//
// integrity:event is the only inbound message that does a synchronous
// Postgres write (SaveIntegrityEvent) inside the room's single goroutine —
// while that INSERT is in flight the room processes no answer:save for
// anyone in it. In a browser these fire on tab-switch, blur, blocked copy or
// paste, so a room full of students glancing away generates a steady stream.
//
// Method: run 06 and 09 at the same CLASSES/STUDENTS_PER_CLASS, then compare
// ws_answer_ack_latency p(95). The delta is the cost of the blocking write.
// Both scenarios keep the same 500ms autosave cadence so answer load is
// identical and the integrity traffic is the only variable.
//
//   k6 run load/scenarios/09-integrity-load.js -e CLASSES=8 -e STUDENTS_PER_CLASS=25
// Requires: pnpm load:seed -- --count <CLASSES*STUDENTS_PER_CLASS> --teachers <CLASSES>
import { Trend, Counter, Rate } from "k6/metrics"
import { TLS_OPTIONS } from "../config.js"
import { authHeadersForUser } from "../lib/auth.js"
import { provisionClassrooms, roomForVU } from "../lib/room.js"
import {
  connectExamSocket,
  answerSaveEnvelope,
  integrityEventEnvelope,
  parseEnvelope,
  INTEGRITY_RATE_LIMIT_MS,
} from "../lib/ws.js"
import { parsePayloadMix, pickAnswer, DEFAULT_PAYLOAD_MIX } from "../lib/answers.js"
import { durationToMs } from "../lib/helpers.js"

const CLASSES = Number(__ENV.CLASSES || 4)
const STUDENTS_PER_CLASS = Number(__ENV.STUDENTS_PER_CLASS || 25)
const RAMP_TIME = __ENV.RAMP_TIME || "60s"
const HOLD_TIME = __ENV.HOLD_TIME || "3m"
const SEND_INTERVAL_MS = 500

// The server rate-limits each kind to one event per 2s per session
// (integrityEventRateLimit in internal/hub/room.go) and stops persisting past
// 200 rows per session. Sending faster than that measures the rate limiter,
// not the write path — so cycle through kinds at exactly the limit to keep
// every event doing real work.
const INTEGRITY_KINDS = [
  "TAB_HIDDEN",
  "WINDOW_BLUR",
  "COPY_BLOCKED",
  "PASTE_BLOCKED",
  "CONTEXT_MENU_BLOCKED",
]
const INTEGRITY_INTERVAL_MS = Number(
  __ENV.INTEGRITY_INTERVAL_MS || INTEGRITY_RATE_LIMIT_MS / INTEGRITY_KINDS.length
)

const STUDENTS = CLASSES * STUDENTS_PER_CLASS
const payloadMix = parsePayloadMix(__ENV.PAYLOAD_MIX || DEFAULT_PAYLOAD_MIX)

export const wsAnswerAckLatency = new Trend("ws_answer_ack_latency", true)
export const integrityEventsSent = new Counter("integrity_events_sent")
// answer_error_count counts ONLY answer:error messages from the server. A
// save still in flight when the socket closes is tracked separately: at
// ramp-down and on interrupted iterations k6 tears down sockets mid-round-trip
// by design, so folding that into the error count made a clean run fail its
// own threshold (observed: 9 "errors", 0 actual answer:error messages).
export const answerErrorCount = new Counter("answer_error_count")
export const wsClosedWithPending = new Counter("ws_closed_with_pending")
export const wsConnectSuccess = new Rate("ws_connect_success")

export const options = {
  ...TLS_OPTIONS,
  setupTimeout: "30m",
  scenarios: {
    integrity: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: RAMP_TIME, target: STUDENTS },
        { duration: HOLD_TIME, target: STUDENTS },
        { duration: "15s", target: 0 },
      ],
      gracefulRampDown: "15s",
    },
  },
  thresholds: {
    // Intentionally NOT asserting p95<100 here: this scenario exists to
    // measure how far integrity traffic pushes latency past the target, and
    // an abort-on-fail would throw away the number being looked for.
    ws_connect_success: ["rate>0.99"],
    answer_error_count: ["count<1"],
    integrity_events_sent: ["count>0"],
  },
}

export function setup() {
  return provisionClassrooms("integrity", {
    classes: CLASSES,
    studentsPerClass: STUDENTS_PER_CLASS,
  })
}

export default function integrityLoad(data) {
  const assigned = roomForVU(data, __VU)
  if (!assigned) return

  const holdMs = durationToMs(RAMP_TIME) + durationToMs(HOLD_TIME)
  let pendingSentAt = null
  let opened = false
  let kindIndex = 0

  connectExamSocket(authHeadersForUser(assigned.user), assigned.sessionId, function (socket) {
    socket.on("open", () => {
      opened = true
      wsConnectSuccess.add(true)

      socket.setInterval(() => {
        if (pendingSentAt !== null) return
        const { content, questionType } = pickAnswer(payloadMix)
        const questionId = assigned.room.questionIdsByType[questionType]
        if (!questionId) return
        pendingSentAt = Date.now()
        socket.send(answerSaveEnvelope(questionId, content))
      }, SEND_INTERVAL_MS)

      socket.setInterval(() => {
        const kind = INTEGRITY_KINDS[kindIndex % INTEGRITY_KINDS.length]
        kindIndex++
        socket.send(integrityEventEnvelope(kind, `k6 vu ${__VU}`))
        integrityEventsSent.add(1)
      }, INTEGRITY_INTERVAL_MS)
    })

    socket.on("error", () => {
      if (!opened) wsConnectSuccess.add(false)
    })

    socket.on("message", (raw) => {
      const msg = parseEnvelope(raw)
      if (msg.type === "answer:ack" && pendingSentAt !== null) {
        wsAnswerAckLatency.add(Date.now() - pendingSentAt)
        pendingSentAt = null
      } else if (msg.type === "answer:error") {
        console.error(`answer:error ${msg.data && msg.data.code}`)
        answerErrorCount.add(1)
        pendingSentAt = null
      }
    })

    socket.on("close", () => {
      if (pendingSentAt !== null) wsClosedWithPending.add(1)
    })

    socket.setTimeout(() => socket.close(), holdMs)
  })
}
