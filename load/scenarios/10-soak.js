// Long steady-state run at the SLO-passing N, to catch what a 3-minute hold
// cannot: goroutine and room leaks, heap growth, write-behind backlog that
// never drains, and latency that degrades slowly rather than immediately.
//
// The interesting output is NOT the aggregate p95 — it's the comparison
// between the first and last few minutes, and the shape of the telemetry
// curves over the same window (docker stats on the host). ws-backend exposes
// goroutine and heap counters at GET /debugz for exactly this.
//
// Tagged by phase so the drift can be read straight out of the summary:
//   ws_answer_ack_latency{phase:early}  — first SOAK_PHASE_WINDOW of the hold
//   ws_answer_ack_latency{phase:late}   — last SOAK_PHASE_WINDOW of the hold
//
//   k6 run load/scenarios/10-soak.js -e CLASSES=8 -e SOAK_DURATION=60m
// Requires: pnpm load:seed -- --count <CLASSES*STUDENTS_PER_CLASS> --teachers <CLASSES>
//
// Rooms self-destruct after ROOM_IDLE_TIMEOUT (60s) with no clients, so a
// soak also exercises room teardown/recreation if any student drops.
import { Trend, Counter, Rate } from "k6/metrics"
import { TLS_OPTIONS } from "../config.js"
import { authHeadersForUser } from "../lib/auth.js"
import { provisionClassrooms, roomForVU } from "../lib/room.js"
import { connectExamSocket, answerSaveEnvelope, parseEnvelope } from "../lib/ws.js"
import { parsePayloadMix, pickAnswer, DEFAULT_PAYLOAD_MIX } from "../lib/answers.js"
import { durationToMs } from "../lib/helpers.js"

const CLASSES = Number(__ENV.CLASSES || 4)
const STUDENTS_PER_CLASS = Number(__ENV.STUDENTS_PER_CLASS || 25)
const RAMP_TIME = __ENV.RAMP_TIME || "60s"
const SOAK_DURATION = __ENV.SOAK_DURATION || "60m"
// How much of each end of the hold counts as "early" / "late".
const PHASE_WINDOW = __ENV.SOAK_PHASE_WINDOW || "5m"
const SEND_INTERVAL_MS = 500

const STUDENTS = CLASSES * STUDENTS_PER_CLASS
const RAMP_MS = durationToMs(RAMP_TIME)
const SOAK_MS = durationToMs(SOAK_DURATION)
const PHASE_MS = durationToMs(PHASE_WINDOW)

if (PHASE_MS * 2 >= SOAK_MS) {
  throw new Error(
    `SOAK_PHASE_WINDOW (${PHASE_WINDOW}) x2 must be shorter than SOAK_DURATION ` +
      `(${SOAK_DURATION}), or the early and late windows overlap and the drift ` +
      `comparison is meaningless.`
  )
}

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
export const wsReconnects = new Counter("ws_reconnects")

// Module scope, so the EXPIRED warning is emitted once per VU rather than
// once per rejected save.
let expiredReported = false
let expiredLogged = 0

export const options = {
  ...TLS_OPTIONS,
  setupTimeout: "30m",
  scenarios: {
    soak: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: RAMP_TIME, target: STUDENTS },
        { duration: SOAK_DURATION, target: STUDENTS },
        { duration: "30s", target: 0 },
      ],
      gracefulRampDown: "30s",
    },
  },
  thresholds: {
    "ws_answer_ack_latency{phase:early}": ["p(95)<100"],
    // Held to the same bar as early: if the system degrades over an hour,
    // this is the threshold that catches it.
    "ws_answer_ack_latency{phase:late}": ["p(95)<100"],
    // ramp and mid carry no real bar — they exist only because k6 breaks a
    // tagged sub-metric out into the summary ONLY if a threshold names it.
    // Without these two lines the first run's export showed early and late
    // and nothing else, so "did the connection storm during ramp cost
    // anything?" was unanswerable from the artifact. The limits are
    // deliberately unreachable: these must never fail a run.
    "ws_answer_ack_latency{phase:ramp}": ["p(95)<600000"],
    "ws_answer_ack_latency{phase:mid}": ["p(95)<600000"],
    answer_error_count: ["count<1"],
    ws_connect_success: ["rate>0.99"],
    // A socket dropping mid-soak and reconnecting is a finding, not noise.
    ws_reconnects: ["count<1"],
  },
}

// The exam must outlive the run. ws-backend rejects every answer:save with
// EXPIRED once effectiveEndTime + the 30s submit grace has passed, so an exam
// shorter than the soak turns the back half of the run into a measurement of
// the rejection path. Observed with the 30-minute default under a 60-minute
// soak: 5.9M EXPIRED errors and no samples at all in the `late` phase, which
// is the one phase the scenario exists to measure.
const EXAM_TIME_LIMIT_MIN = Math.ceil((RAMP_MS + SOAK_MS) / 60000) + 15

export function setup() {
  const provisioned = provisionClassrooms("soak", {
    classes: CLASSES,
    studentsPerClass: STUDENTS_PER_CLASS,
    timeLimitMin: EXAM_TIME_LIMIT_MIN,
  })
  // Phase tagging has to be relative to the START OF THE RUN, not to each
  // VU's own first iteration — VUs enter across the whole ramp, so a
  // per-VU clock would label a late-arriving VU's first samples "early".
  // setup() finishes immediately before stage 1 begins, so this is the
  // closest run-wide t0 available to every VU.
  return { ...provisioned, runStartedAt: Date.now() }
}

// Start of the steady hold, in run-relative ms. Used to tag samples by phase.
const HOLD_START_MS = RAMP_MS
const HOLD_END_MS = RAMP_MS + SOAK_MS

function phaseFor(runElapsedMs) {
  if (runElapsedMs < HOLD_START_MS) return "ramp"
  if (runElapsedMs < HOLD_START_MS + PHASE_MS) return "early"
  if (runElapsedMs > HOLD_END_MS - PHASE_MS) return "late"
  return "mid"
}

export default function soak(data) {
  const assigned = roomForVU(data, __VU)
  if (!assigned) return

  // Each VU holds one connection for the rest of the run; a close before
  // its scheduled timeout means the socket dropped, which the counter
  // records. Remaining lifetime shrinks for VUs that ramp in late, so they
  // still stop with the run rather than overrunning it.
  const elapsedAtStart = Date.now() - data.runStartedAt
  const remainingMs = RAMP_MS + SOAK_MS - elapsedAtStart
  // Past the steady stage k6 is draining VUs. Opening another socket here
  // just to close it a second later inflates ws_sessions with connections
  // that measure nothing — one 10-VU run logged 175 sessions this way.
  if (remainingMs < 5000) return
  const holdMs = remainingMs
  let pendingSentAt = null
  let opened = false
  let closedEarly = true

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
    })

    socket.on("error", () => {
      if (!opened) wsConnectSuccess.add(false)
    })

    socket.on("message", (raw) => {
      const msg = parseEnvelope(raw)
      if (msg.type === "answer:ack" && pendingSentAt !== null) {
        wsAnswerAckLatency.add(Date.now() - pendingSentAt, {
          phase: phaseFor(Date.now() - data.runStartedAt),
        })
        pendingSentAt = null
      } else if (msg.type === "answer:error") {
        const code = msg.data && msg.data.code
        answerErrorCount.add(1)
        // EXPIRED means the exam's clock ran out underneath the run — a
        // harness misconfiguration, not a server fault, and it will repeat for
        // every save from every VU until the soak ends. Say so once, loudly,
        // instead of emitting millions of identical lines.
        if (code === "EXPIRED" && !expiredReported) {
          expiredReported = true
          console.error(
            `answer:error EXPIRED — the exam's time limit (${EXAM_TIME_LIMIT_MIN}min) ` +
              `elapsed during the run. Every remaining save will be rejected and the ` +
              `late-phase numbers are meaningless. Raise SOAK_DURATION's exam budget.`
          )
        } else if (code !== "EXPIRED" && expiredLogged < 5) {
          expiredLogged++
          console.error(`answer:error ${code}`)
        }
        pendingSentAt = null
      }
    })

    socket.on("close", () => {
      if (pendingSentAt !== null) wsClosedWithPending.add(1)
      if (closedEarly) wsReconnects.add(1)
    })

    socket.setTimeout(() => {
      closedEarly = false
      socket.close()
    }, holdMs)
  })
}
