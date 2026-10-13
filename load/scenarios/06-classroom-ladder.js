// The primary capacity scenario: N students spread across CLASSES parallel
// exam rooms, each room with its own teacher watching /ws/monitor. This is
// the shape a school actually runs (many classes of ~25 at once), and it
// loads room count, Redis pub/sub breadth and the DB pool rather than a
// single room goroutine's fan-out the way 05 does.
//
// Run one rung:
//   k6 run load/scenarios/06-classroom-ladder.js -e CLASSES=8 -e STUDENTS_PER_CLASS=25
// Requires: pnpm load:seed -- --count <CLASSES*STUDENTS_PER_CLASS> --teachers <CLASSES>
//
// Role assignment: students and monitors deliberately share ONE k6 scenario
// and split on VU index. Two scenarios would each get their own VU-id block
// with no guaranteed ordering (see the note in 05), so a monitor VU could
// land on a student's id and open a second exam socket for that session —
// which the hub treats as SESSION_REPLACED and evicts, quietly corrupting
// the run rather than failing it.
import { sleep } from "k6"
import { Trend, Counter, Rate } from "k6/metrics"
import { TLS_OPTIONS } from "../config.js"
import { authHeadersForUser } from "../lib/auth.js"
import { provisionClassrooms, roomForVU } from "../lib/room.js"
import {
  connectExamSocket,
  connectMonitorSocket,
  answerSaveEnvelope,
  parseEnvelope,
} from "../lib/ws.js"
import {
  parsePayloadMix,
  pickAnswer,
  saveAnswerRest,
  DEFAULT_PAYLOAD_MIX,
} from "../lib/answers.js"
import { durationToMs } from "../lib/helpers.js"

const CLASSES = Number(__ENV.CLASSES || 4)
const STUDENTS_PER_CLASS = Number(__ENV.STUDENTS_PER_CLASS || 25)
const MONITORS_PER_CLASS = Number(__ENV.MONITORS_PER_CLASS || 1)
const REST_FALLBACK_FRACTION = Number(__ENV.REST_FALLBACK_FRACTION || 0.05)
const RAMP_TIME = __ENV.RAMP_TIME || "60s"
const HOLD_TIME = __ENV.HOLD_TIME || "3m"
const SEND_INTERVAL_MS = 500 // mirrors the app's real client autosave debounce

const STUDENTS = CLASSES * STUDENTS_PER_CLASS
const MONITORS = CLASSES * MONITORS_PER_CLASS
const TOTAL_VUS = STUDENTS + MONITORS

// A threshold on a metric with zero samples passes trivially (load/README.md
// warns about this), which would turn a run where every socket failed into a
// green result. Require most students to have acked at least a few saves.
const MIN_ACK_SAMPLES = Math.floor(STUDENTS * (durationToMs(HOLD_TIME) / SEND_INTERVAL_MS) * 0.5)

const payloadMix = parsePayloadMix(__ENV.PAYLOAD_MIX || DEFAULT_PAYLOAD_MIX)

export const wsAnswerAckLatency = new Trend("ws_answer_ack_latency", true)
// answer_error_count counts ONLY answer:error messages from the server. A
// save still in flight when the socket closes is tracked separately: at
// ramp-down and on interrupted iterations k6 tears down sockets mid-round-trip
// by design, so folding that into the error count made a clean run fail its
// own threshold (observed: 9 "errors", 0 actual answer:error messages).
export const answerErrorCount = new Counter("answer_error_count")
export const wsClosedWithPending = new Counter("ws_closed_with_pending")
export const wsConnectSuccess = new Rate("ws_connect_success")
export const monitorConnectSuccess = new Rate("monitor_connect_success")
export const monitorUpdatesReceived = new Counter("monitor_updates_received")
// k6 rejects a count threshold on a Trend ("unsupported aggregation method
// count on metric of type trend"), so the zero-sample guard needs its own
// Counter incremented alongside every latency sample.
export const wsAcksReceived = new Counter("ws_acks_received")

export const options = {
  ...TLS_OPTIONS,
  // Provisioning is CLASSES exam creations plus STUDENTS sequential joins
  // over the network, which at the top rungs runs into the tens of minutes.
  setupTimeout: "30m",
  scenarios: {
    classroom: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: RAMP_TIME, target: TOTAL_VUS },
        { duration: HOLD_TIME, target: TOTAL_VUS },
        { duration: "15s", target: 0 },
      ],
      gracefulRampDown: "15s",
    },
  },
  thresholds: {
    ws_answer_ack_latency: ["p(95)<100"], // README perf target
    // A threshold on a Trend with zero samples passes trivially, which would
    // turn a run where every socket failed into a green result.
    ws_acks_received: [`count>${MIN_ACK_SAMPLES}`],
    "http_req_duration{name:answer_save_rest}": ["p(95)<200"], // README perf target
    // Without this, a rung where the REST path is returning 500s still passes:
    // the latency percentiles only see the requests that SURVIVED, so mass
    // failure reads as an improvement. Observed at 2400 students — 77% of HTTP
    // requests failed while p95 latency "improved" from 101ms to 29ms and the
    // rung was recorded as PASS.
    http_req_failed: ["rate<0.01"],
    answer_error_count: ["count<1"],
    ws_connect_success: ["rate>0.99"],
    monitor_connect_success: ["rate>0.99"],
  },
}

export function setup() {
  console.log(
    `provisioning ${CLASSES} classes x ${STUDENTS_PER_CLASS} students ` +
      `(${STUDENTS} students, ${MONITORS} monitors, ${TOTAL_VUS} VUs)`
  )
  return provisionClassrooms("ladder", {
    classes: CLASSES,
    studentsPerClass: STUDENTS_PER_CLASS,
  })
}

// Decided once per VU from its id, so a VU's role and behaviour are stable
// across iterations.
let role = null
let isRestFallback = false

export default function classroom(data) {
  const index = __VU - 1

  if (role === null) {
    role = index < STUDENTS ? "student" : "monitor"
    isRestFallback =
      role === "student" && __VU % Math.round(1 / REST_FALLBACK_FRACTION) === 0
  }

  if (role === "monitor") {
    teacherMonitor(data, (index - STUDENTS) % CLASSES)
    return
  }

  const assigned = roomForVU(data, __VU)
  if (!assigned) return // VU outside the provisioned set

  if (isRestFallback) {
    // "WS is down" students, per the app's documented dual-path design.
    const { content, questionType } = pickAnswer(payloadMix)
    saveAnswerRest(
      authHeadersForUser(assigned.user),
      assigned.sessionId,
      assigned.room.questionIdsByType[questionType],
      content
    )
    sleep(SEND_INTERVAL_MS / 1000)
    return
  }

  examStudent(data, assigned)
}

function examStudent(data, assigned) {
  const authHeaders = authHeadersForUser(assigned.user)
  const holdMs = durationToMs(RAMP_TIME) + durationToMs(HOLD_TIME)

  let pendingSentAt = null
  let opened = false

  connectExamSocket(authHeaders, assigned.sessionId, function (socket) {
    socket.on("open", () => {
      opened = true
      wsConnectSuccess.add(true)

      socket.setInterval(() => {
        if (pendingSentAt !== null) return // previous save unacked; don't pile up
        const { content, questionType } = pickAnswer(payloadMix)
        const questionId = assigned.room.questionIdsByType[questionType]
        if (!questionId) return // room doesn't carry this type
        pendingSentAt = Date.now()
        socket.send(answerSaveEnvelope(questionId, content))
      }, SEND_INTERVAL_MS)
    })

    socket.on("error", () => {
      if (!opened) wsConnectSuccess.add(false)
    })

    socket.on("message", (raw) => {
      const msg = parseEnvelope(raw)
      if (msg.type === "answer:ack" && pendingSentAt !== null) {
        wsAnswerAckLatency.add(Date.now() - pendingSentAt)
        wsAcksReceived.add(1)
        pendingSentAt = null
      } else if (msg.type === "answer:error") {
        // Surfaces INVALID_ANSWER from a payload/question-type mismatch as
        // loudly as a real failure — it would otherwise look like silence.
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

function teacherMonitor(data, roomIndex) {
  const room = data.rooms[roomIndex]
  if (!room) return

  const holdMs = durationToMs(RAMP_TIME) + durationToMs(HOLD_TIME)
  let opened = false

  connectMonitorSocket(room.teacherHeaders, room.examId, function (socket) {
    socket.on("open", () => {
      opened = true
      monitorConnectSuccess.add(true)
    })

    socket.on("error", () => {
      if (!opened) monitorConnectSuccess.add(false)
    })

    // Counted, not just idled on as in 05 — a monitor that connects but
    // receives nothing means the fan-out path is broken, which connection
    // success alone cannot distinguish. 08 times this path properly.
    socket.on("message", (raw) => {
      const msg = parseEnvelope(raw)
      if (msg.type === "monitor:update") monitorUpdatesReceived.add(1)
    })

    socket.setTimeout(() => socket.close(), holdMs)
  })
}
