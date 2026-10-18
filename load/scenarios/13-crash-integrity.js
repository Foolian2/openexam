// Do confirmed answers survive an abrupt server failure?
//
// Students answer one FREE_TEXT question over WS. Every save carries a
// strictly increasing number n (in the text and as clientSeq). On each
// answer:ack the VU prints "ACK <sessionId> <n> <unix ms>" — run k6 with
// --console-output=<file> to keep that log on the generator. The server is
// then killed from outside (load/bench/crash-kill.sh). Clients deliberately do
// NOT reconnect and there is no REST fallback: a resend from the browser's
// local copy would hide exactly the server-side loss this test looks for.
//
// After recovery, load/bench/crash-reconcile.py compares, per session, the
// highest acknowledged n with the n stored in PostgreSQL. A stored n lower
// than the last ack (or no row) is a lost confirmed answer.
//
//   k6 run --console-output=acks.log load/scenarios/13-crash-integrity.js -e CLASSES=16
import { Counter, Trend, Rate } from "k6/metrics"
import { TLS_OPTIONS } from "../config.js"
import { authHeadersForUser } from "../lib/auth.js"
import { provisionClassrooms, roomForVU } from "../lib/room.js"
import {
  connectExamSocket,
  answerSaveEnvelope,
  parseEnvelope,
} from "../lib/ws.js"
import { durationToMs } from "../lib/helpers.js"

const CLASSES = Number(__ENV.CLASSES || 16)
const STUDENTS_PER_CLASS = Number(__ENV.STUDENTS_PER_CLASS || 25)
// Long enough to cover the kill; the run ends when the sockets die.
const HOLD_TIME = __ENV.HOLD_TIME || "6m"
const SEND_INTERVAL_MS = 500
const STUDENTS = CLASSES * STUDENTS_PER_CLASS

export const wsAnswerAckLatency = new Trend("ws_answer_ack_latency", true)
export const wsAcksReceived = new Counter("ws_acks_received")
export const answerErrorCount = new Counter("answer_error_count")
export const wsConnectSuccess = new Rate("ws_connect_success")

export const options = {
  ...TLS_OPTIONS,
  setupTimeout: "15m",
  scenarios: {
    crash: {
      executor: "per-vu-iterations",
      vus: STUDENTS,
      iterations: 1,
      maxDuration: `${Math.ceil(durationToMs(HOLD_TIME) / 1000) + 60}s`,
    },
  },
}

export function setup() {
  return provisionClassrooms("crash", {
    classes: CLASSES,
    studentsPerClass: STUDENTS_PER_CLASS,
    questionTypes: ["FREE_TEXT"],
    timeLimitMin: 120,
  })
}

function text(vu, n) {
  return `crash|${vu}|${n}|Die Hauptstadt der Schweiz ist Bern.`
}

export default function crashStudent(data) {
  const assigned = roomForVU(data, __VU)
  if (!assigned) return
  const headers = authHeadersForUser(assigned.user)
  const questionId = assigned.room.questionIdsByType.FREE_TEXT
  const seqBase = Date.now() * 1000 // above anything a browser would send
  let n = 0
  let pending = null
  let opened = false

  // Stagger socket opening over 30 s so the start is not the measured event.
  const delayMs = Math.floor(Math.random() * 30000)

  connectExamSocket(headers, assigned.sessionId, (socket) => {
    socket.on("open", () => {
      opened = true
      wsConnectSuccess.add(true)
      socket.setTimeout(() => {
        socket.setInterval(() => {
          if (pending !== null) return
          n += 1
          pending = { n, sentAt: Date.now() }
          const envelope = JSON.parse(
            answerSaveEnvelope(questionId, {
              type: "FREE_TEXT",
              text: text(__VU, n),
            })
          )
          envelope.data.clientSeq = seqBase + n
          socket.send(JSON.stringify(envelope))
        }, SEND_INTERVAL_MS)
      }, delayMs)
    })
    socket.on("error", () => {
      if (!opened) wsConnectSuccess.add(false)
    })
    socket.on("message", (raw) => {
      const msg = parseEnvelope(raw)
      if (msg.type === "answer:ack" && pending !== null) {
        const now = Date.now()
        wsAnswerAckLatency.add(now - pending.sentAt)
        wsAcksReceived.add(1)
        console.log(`ACK ${assigned.sessionId} ${pending.n} ${now}`)
        pending = null
      } else if (msg.type === "answer:error") {
        answerErrorCount.add(1)
        console.log(
          `ERR ${assigned.sessionId} ${pending && pending.n} ${msg.data && msg.data.code}`
        )
        pending = null
      }
    })
    // No reconnect on close: see the header comment.
    socket.setTimeout(() => socket.close(), durationToMs(HOLD_TIME))
  })
}
