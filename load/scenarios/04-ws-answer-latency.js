// The headline scenario: measures WS answer:save -> answer:ack round-trip
// latency and directly enforces the README's p95 < 100ms target.
//
// Correlation note: ws-backend/internal/protocol/messages.go's
// AnswerAckData only carries { questionId, savedAt } — no echoed client
// `id`. That's fine here because each VU has exactly one question and
// keeps at most one send in flight at a time (see pendingSentAt below);
// extend this if a scenario ever needs multiple concurrent questions.
//
//   pnpm load:ws-latency
//   k6 run load/scenarios/04-ws-answer-latency.js -e ANSWER_VUS=100 -e SEND_DURATION=3m
// Requires: pnpm load:seed (needs >= ANSWER_VUS seeded student sessions)
import { Trend, Counter, Rate } from "k6/metrics"
import { TLS_OPTIONS } from "../config.js"
import { seedUsers } from "../lib/seedUsers.js"
import { getStudentAuthHeaders } from "../lib/auth.js"
import { provisionRoom } from "../lib/room.js"
import { connectExamSocket, answerSaveEnvelope, parseEnvelope } from "../lib/ws.js"
import { multipleChoiceAnswer } from "../lib/answers.js"
import { durationToMs } from "../lib/helpers.js"

const ANSWER_VUS = Number(__ENV.ANSWER_VUS || 100)
const RAMP_TIME = __ENV.RAMP_TIME || "30s"
const SEND_DURATION = __ENV.SEND_DURATION || "3m"
const SEND_INTERVAL_MS = 500 // mirrors the app's real client autosave debounce

export const wsAnswerAckLatency = new Trend("ws_answer_ack_latency", true)
export const answerErrorCount = new Counter("answer_error_count")
export const wsConnectSuccess = new Rate("ws_connect_success")

export const options = {
  ...TLS_OPTIONS,
  setupTimeout: "10m",
  scenarios: {
    ws_answer_latency: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: RAMP_TIME, target: ANSWER_VUS },
        { duration: SEND_DURATION, target: ANSWER_VUS },
        { duration: "10s", target: 0 },
      ],
    },
  },
  thresholds: {
    ws_answer_ack_latency: ["p(95)<100"], // README perf target
    answer_error_count: ["count<1"],
    ws_connect_success: ["rate>0.99"],
  },
}

export function setup() {
  return provisionRoom("wslatency", ANSWER_VUS)
}

export default function wsAnswerLatency(data) {
  const authHeaders = getStudentAuthHeaders(seedUsers)
  const user = seedUsers[(__VU - 1) % seedUsers.length]
  const sessionId = data.sessionIdByEmail[user.email]
  if (!sessionId) return // beyond ANSWER_VUS pre-joined sessions; nothing to drive

  const content = multipleChoiceAnswer()
  let pendingSentAt = null
  let opened = false
  let ending = false

  connectExamSocket(authHeaders, sessionId, function (socket) {
    socket.on("open", () => {
      opened = true
      wsConnectSuccess.add(true)

      // Only start sending once the handshake has actually completed —
      // sending against a socket that never opened would silently produce
      // no acks rather than a visible failure.
      socket.setInterval(() => {
        if (ending || pendingSentAt !== null) return // stop sending during orderly close
        pendingSentAt = Date.now()
        socket.send(answerSaveEnvelope(data.questionId, content))
      }, SEND_INTERVAL_MS)
    })

    socket.on("error", () => {
      if (!opened) wsConnectSuccess.add(false)
    })

    socket.on("message", (raw) => {
      const msg = parseEnvelope(raw)
      if (msg.type === "answer:ack" && pendingSentAt !== null) {
        wsAnswerAckLatency.add(Date.now() - pendingSentAt)
        pendingSentAt = null
        if (ending) socket.close()
      } else if (msg.type === "answer:error") {
        answerErrorCount.add(1, { code: msg.data?.code || "UNKNOWN" })
        pendingSentAt = null
        if (ending) socket.close()
      }
    })

    socket.on("close", () => {
      // A save was sent but never acked or errored before the socket shut
      // — the connection dropped mid-round-trip, which is a real failure,
      // not silence in the latency Trend.
      if (pendingSentAt !== null) answerErrorCount.add(1, { code: "UNACKED_ON_CLOSE" })
    })

    // Total connection lifetime = ramp-in slack + the sustained send
    // window, so a VU that connects late in the ramp still gets a full
    // SEND_DURATION of sampling before closing.
    socket.setTimeout(() => {
      ending = true
      if (pendingSentAt === null) socket.close()
      // Do not manufacture an unacked save by closing on the same timer tick
      // as the last send. Drain that one reply, bounded so a lost reply is
      // still counted by the close handler rather than hidden.
      else socket.setTimeout(() => socket.close(), 2000)
    }, durationToMs(RAMP_TIME) + durationToMs(SEND_DURATION))
  })
}


