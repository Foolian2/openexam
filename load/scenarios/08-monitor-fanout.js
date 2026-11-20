// Times the teacher-monitor path, which 05 and 06 only ever connect to and
// count. Two distinct costs, measured separately:
//
//   monitor_snapshot_latency — WS open -> first monitor:snapshot. Building a
//     snapshot calls ListMonitorSessions, a Postgres query executed inside
//     the single-goroutine room loop (ws-backend/AUDIT.md flags this as the
//     top performance risk), so every teacher connecting to a busy room
//     stalls that room's answer processing for the duration of the query.
//     This is a pure client-side round trip — no clock skew involved.
//
//   monitor_update_lag — INVALID AS MEASURED. DO NOT QUOTE. Kept only so the
//     defect stays visible in the output rather than being silently dropped.
//
//     The intent was: server-stamped save time -> teacher receives the
//     monitor:update carrying it, i.e. Date.now() - Date.parse(lastSeenAt).
//     But nowRFC3339() in internal/hub/room.go formats with time.RFC3339,
//     which carries WHOLE-SECOND precision — no fractional part. So every
//     lastSeenAt is truncated down to its second, and the metric measures
//     that truncation, uniformly distributed over [0, 1000) ms, not the lag.
//     A first run showed exactly that fingerprint: min 0ms, median 499ms,
//     max 999ms, on a path whose real cost is a same-goroutine enqueue.
//
//     Fixing it needs time.RFC3339Nano on the server (a real improvement —
//     any consumer of lastSeenAt has the same problem), which is an app
//     change and so out of scope for a benchmark run. Until then the honest
//     measures of this path are monitor_snapshot_latency (a pure client-side
//     round trip, unaffected) and the monitor-cost A/B: run 06 with
//     MONITORS_PER_CLASS=0 vs 3 and compare ws_answer_ack_latency, which has
//     millisecond precision and no clock-skew term.
//
//   k6 run load/scenarios/08-monitor-fanout.js -e CLASSES=8 -e MONITORS_PER_CLASS=3
// Requires: pnpm load:seed -- --count <CLASSES*STUDENTS_PER_CLASS> --teachers <CLASSES>
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
import { parsePayloadMix, pickAnswer, DEFAULT_PAYLOAD_MIX } from "../lib/answers.js"
import { durationToMs } from "../lib/helpers.js"

const CLASSES = Number(__ENV.CLASSES || 4)
const STUDENTS_PER_CLASS = Number(__ENV.STUDENTS_PER_CLASS || 25)
// Several teachers per room is the realistic worst case: an invigilator, a
// subject teacher and the exam admin all watching the same class.
const MONITORS_PER_CLASS = Number(__ENV.MONITORS_PER_CLASS || 3)
const RAMP_TIME = __ENV.RAMP_TIME || "30s"
const HOLD_TIME = __ENV.HOLD_TIME || "2m"
const SEND_INTERVAL_MS = 500

const STUDENTS = CLASSES * STUDENTS_PER_CLASS
const MONITORS = CLASSES * MONITORS_PER_CLASS
const TOTAL_VUS = STUDENTS + MONITORS

const payloadMix = parsePayloadMix(__ENV.PAYLOAD_MIX || DEFAULT_PAYLOAD_MIX)

export const monitorSnapshotLatency = new Trend("monitor_snapshot_latency", true)
export const monitorUpdateLag = new Trend("monitor_update_lag", true)
export const monitorUpdatesReceived = new Counter("monitor_updates_received")
export const monitorSnapshotsReceived = new Counter("monitor_snapshots_received")
export const monitorConnectSuccess = new Rate("monitor_connect_success")
export const wsConnectSuccess = new Rate("ws_connect_success")
export const answerErrorCount = new Counter("answer_error_count")

export const options = {
  ...TLS_OPTIONS,
  setupTimeout: "30m",
  scenarios: {
    fanout: {
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
    // No prior target for either metric — this scenario establishes the
    // baseline. Only the liveness assertions are hard failures.
    monitor_connect_success: ["rate>0.99"],
    ws_connect_success: ["rate>0.99"],
    monitor_updates_received: ["count>0"],
    monitor_snapshots_received: [`count>=${MONITORS}`],
  },
}

export function setup() {
  return provisionClassrooms("fanout", {
    classes: CLASSES,
    studentsPerClass: STUDENTS_PER_CLASS,
  })
}

let role = null

export default function fanout(data) {
  const index = __VU - 1
  if (role === null) role = index < STUDENTS ? "student" : "monitor"

  if (role === "monitor") {
    monitor(data, (index - STUDENTS) % CLASSES)
    return
  }

  const assigned = roomForVU(data, __VU)
  if (assigned) student(assigned)
}

// Students exist here only to generate monitor:update traffic — their ack
// latency is 06's job, so it isn't measured again.
function student(assigned) {
  const holdMs = durationToMs(RAMP_TIME) + durationToMs(HOLD_TIME)
  let opened = false

  connectExamSocket(authHeadersForUser(assigned.user), assigned.sessionId, function (socket) {
    socket.on("open", () => {
      opened = true
      wsConnectSuccess.add(true)
      socket.setInterval(() => {
        const { content, questionType } = pickAnswer(payloadMix)
        const questionId = assigned.room.questionIdsByType[questionType]
        if (questionId) socket.send(answerSaveEnvelope(questionId, content))
      }, SEND_INTERVAL_MS)
    })
    socket.on("error", () => {
      if (!opened) wsConnectSuccess.add(false)
    })
    socket.on("message", (raw) => {
      const msg = parseEnvelope(raw)
      if (msg.type === "answer:error") answerErrorCount.add(1)
    })
    socket.setTimeout(() => socket.close(), holdMs)
  })
}

function monitor(data, roomIndex) {
  const room = data.rooms[roomIndex]
  if (!room) return

  const holdMs = durationToMs(RAMP_TIME) + durationToMs(HOLD_TIME)
  const connectedAt = Date.now()
  let opened = false
  let sawSnapshot = false

  connectMonitorSocket(room.teacherHeaders, room.examId, function (socket) {
    socket.on("open", () => {
      opened = true
      monitorConnectSuccess.add(true)
    })

    socket.on("error", () => {
      if (!opened) monitorConnectSuccess.add(false)
    })

    socket.on("message", (raw) => {
      const msg = parseEnvelope(raw)

      if (msg.type === "monitor:snapshot" && !sawSnapshot) {
        sawSnapshot = true
        // Measured from connect rather than open: the handshake itself is
        // part of what a teacher waits through, and the snapshot query runs
        // in the room goroutine after the upgrade completes.
        monitorSnapshotLatency.add(Date.now() - connectedAt)
        monitorSnapshotsReceived.add(1)
        return
      }

      if (msg.type === "monitor:update") {
        monitorUpdatesReceived.add(1)
        const lastSeenAt = msg.data && msg.data.patch && msg.data.patch.lastSeenAt
        if (lastSeenAt) {
          const stamped = Date.parse(lastSeenAt)
          // Negative values mean the generator clock trails the SUT's;
          // dropping them silently would bias the Trend low, so they're
          // recorded and the skew shows up as a suspiciously fast p95.
          if (!Number.isNaN(stamped)) monitorUpdateLag.add(Date.now() - stamped)
        }
      }
    })

    socket.setTimeout(() => socket.close(), holdMs)
  })
}
