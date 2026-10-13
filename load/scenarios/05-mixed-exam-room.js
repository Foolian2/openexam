// Composite, most realistic "concurrent participants" simulation: combines
// 03 (WS connect) + 04 (WS answer:save/ack) and adds two more traffic
// shapes from the same production exam room:
//   - a small fraction of students on the REST fallback autosave path
//     (PUT /api/sessions/{id}/answers), modeling "WS is down" per the
//     app's documented dual-path design (see load/lib/answers.js);
//   - a handful of teacher connections to /ws/monitor/{examId}, loading
//     the hub's fan-out/Redis pub-sub the same way the live-monitor
//     dashboard does.
//
// Scale this one up only after 03 and 04 are clean at a smaller VU count
// — it's the most resource-intensive script in the suite and the most
// exposed to the local-machine contention risk noted in load/README.md.
//
//   pnpm load:mixed
//   k6 run load/scenarios/05-mixed-exam-room.js -e MIXED_VUS=100 -e MONITOR_VUS=2
// Requires: pnpm load:seed
// (needs >= MIXED_VUS + MONITOR_VUS seeded student sessions)
import { sleep } from "k6"
import { Trend, Counter, Rate } from "k6/metrics"
import { TLS_OPTIONS } from "../config.js"
import { seedUsers } from "../lib/seedUsers.js"
import { getStudentAuthHeaders } from "../lib/auth.js"
import { provisionRoom } from "../lib/room.js"
import { connectExamSocket, connectMonitorSocket, answerSaveEnvelope, parseEnvelope } from "../lib/ws.js"
import { multipleChoiceAnswer, saveAnswerRest } from "../lib/answers.js"
import { durationToMs } from "../lib/helpers.js"

const MIXED_VUS = Number(__ENV.MIXED_VUS || 100)
const MONITOR_VUS = Number(__ENV.MONITOR_VUS || 2)
const REST_FALLBACK_FRACTION = Number(__ENV.REST_FALLBACK_FRACTION || 0.05)
const RAMP_TIME = __ENV.RAMP_TIME || "30s"
const HOLD_TIME = __ENV.HOLD_TIME || "2m"
const WS_HOLD_MS = durationToMs(__ENV.WS_HOLD_TIME || "60s")
const SEND_INTERVAL_MS = 500 // mirrors the app's real client autosave debounce
// Sends stop this long before each socket's scheduled close. WS_HOLD_MS is an
// exact multiple of SEND_INTERVAL_MS, so without it the final send and the
// close landed on the same tick and every run "lost" ~160 saves the server
// was never given time to ack (0 actual answer:error messages). 2s is 20x the
// 100ms ack target, so a save still pending at close was really never acked.
const ACK_DRAIN_MS = 2000

export const wsAnswerAckLatency = new Trend("ws_answer_ack_latency", true)
// answer_error_count counts answer:error replies from the server;
// answer_unacked counts saves still waiting for an ack when the socket closed
// (see ACK_DRAIN_MS). Both fail the run: a backend that accepts the socket but
// stops acking must not pass just because it never says "error".
export const answerErrorCount = new Counter("answer_error_count")
export const answerUnacked = new Counter("answer_unacked")
export const wsConnectSuccess = new Rate("ws_connect_success")
export const monitorConnectSuccess = new Rate("monitor_connect_success")

export const options = {
  ...TLS_OPTIONS,
  setupTimeout: "10m",
  scenarios: {
    exam_room: {
      executor: "ramping-vus",
      exec: "examRoom",
      startVUs: 0,
      stages: [
        { duration: RAMP_TIME, target: MIXED_VUS },
        { duration: HOLD_TIME, target: MIXED_VUS },
        { duration: "10s", target: 0 },
      ],
    },
    teacher_monitor: {
      executor: "ramping-vus",
      exec: "teacherMonitor",
      startVUs: 0,
      stages: [
        { duration: RAMP_TIME, target: MONITOR_VUS },
        { duration: HOLD_TIME, target: MONITOR_VUS },
        { duration: "10s", target: 0 },
      ],
    },
  },
  thresholds: {
    ws_answer_ack_latency: ["p(95)<100"], // README perf target
    answer_error_count: ["count<1"],
    answer_unacked: ["count<1"],
    "http_req_duration{name:answer_save_rest}": ["p(95)<200"], // README perf target
    ws_connect_success: ["rate>0.99"],
    monitor_connect_success: ["rate>0.99"],
  },
}

// k6 does not guarantee VU ids 1..MIXED_VUS for the exam_room scenario
// when a second scenario (teacher_monitor) shares the run — the two
// scenarios' VU pools land in two contiguous blocks, but which one comes
// first is not guaranteed (observed: teacher_monitor took VU 1, pushing
// exam_room to start at VU 2). Pre-joining MIXED_VUS + MONITOR_VUS
// sessions, rather than just MIXED_VUS, guarantees every VU id either
// scenario can be assigned still lands on a pre-joined session via the
// `(__VU - 1) % seedUsers.length` lookup below.
export function setup() {
  return provisionRoom("mixedroom", MIXED_VUS + MONITOR_VUS)
}

// ~REST_FALLBACK_FRACTION of VUs behave as students whose WS is down and
// fall back to REST autosave; the rest drive the primary WS answer:save
// path. Decided once per VU (from its id) so a VU's behavior is stable
// across iterations.
let isRestFallback = null

export function examRoom(data) {
  if (isRestFallback === null) {
    isRestFallback = __VU % Math.round(1 / REST_FALLBACK_FRACTION) === 0
  }

  const authHeaders = getStudentAuthHeaders(seedUsers)
  const user = seedUsers[(__VU - 1) % seedUsers.length]
  const sessionId = data.sessionIdByEmail[user.email]
  if (!sessionId) return // shouldn't happen — see the setup() comment above

  if (isRestFallback) {
    saveAnswerRest(authHeaders, sessionId, data.questionId, multipleChoiceAnswer())
    sleep(2)
    return
  }

  let pendingSentAt = null
  let opened = false
  let draining = false
  connectExamSocket(authHeaders, sessionId, function (socket) {
    socket.on("open", () => {
      opened = true
      wsConnectSuccess.add(true)

      socket.setInterval(() => {
        if (draining || pendingSentAt !== null) return
        pendingSentAt = Date.now()
        socket.send(answerSaveEnvelope(data.questionId, multipleChoiceAnswer()))
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
      } else if (msg.type === "answer:error") {
        answerErrorCount.add(1)
        pendingSentAt = null
      }
    })

    socket.on("close", () => {
      if (pendingSentAt !== null) answerUnacked.add(1)
    })

    socket.setTimeout(() => {
      draining = true
    }, Math.max(0, WS_HOLD_MS - ACK_DRAIN_MS))
    socket.setTimeout(() => socket.close(), WS_HOLD_MS)
  })
}

export function teacherMonitor(data) {
  let opened = false
  connectMonitorSocket(data.teacherHeaders, data.examId, function (socket) {
    socket.on("open", () => {
      opened = true
      monitorConnectSuccess.add(true)
    })
    socket.on("error", () => {
      if (!opened) monitorConnectSuccess.add(false)
    })
    socket.setTimeout(() => socket.close(), WS_HOLD_MS)
  })
}
