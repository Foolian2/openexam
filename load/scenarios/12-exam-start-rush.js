// Exam-start rush through the real admission queue (lib/exam-admission.ts).
//
// Unlike 06, nobody is pre-joined in setup(): setup() only creates and
// activates the exams. Every student VU then starts in the same second and
// walks the full client path inside the measured window:
//
//   POST /api/sessions (202 + waitMs while queued, see joinSession)
//   -> GET /exam/<id>/take (SSR) -> WS /ws/exam/<session> -> first answer:ack
//
// and keeps answering for HOLD_TIME, so the start wave overlaps real save
// traffic. One teacher per exam watches /ws/monitor from the first second.
//
// The queue counts per exam at EXAM_ADMISSION_RATE_PER_SEC (default 25/s),
// so exams of 25 students never queue. STUDENTS_PER_EXAM sets the cohort per
// exam: 25 models parallel classes, 600 models a whole year group sitting one
// exam, which is where the staggered admission actually engages.
//
//   k6 run load/scenarios/12-exam-start-rush.js -e EXAMS=4 -e STUDENTS_PER_EXAM=600
import http from "k6/http"
import { check, sleep } from "k6"
import { Trend, Counter, Rate } from "k6/metrics"
import { BASE_URL, TLS_OPTIONS } from "../config.js"
import { seedUsers } from "../lib/seedUsers.js"
import { seedTeachers } from "../lib/seedTeachers.js"
import { authHeadersForUser } from "../lib/auth.js"
import {
  createActiveExam,
  joinSession,
  REALISTIC_QUESTION_TYPES,
} from "../lib/exam.js"
import {
  connectExamSocket,
  connectMonitorSocket,
  answerSaveEnvelope,
  parseEnvelope,
} from "../lib/ws.js"
import {
  parsePayloadMix,
  pickAnswer,
  DEFAULT_PAYLOAD_MIX,
} from "../lib/answers.js"
import { durationToMs } from "../lib/helpers.js"

const EXAMS = Number(__ENV.EXAMS || 4)
const STUDENTS_PER_EXAM = Number(__ENV.STUDENTS_PER_EXAM || 600)
const HOLD_TIME = __ENV.HOLD_TIME || "3m"
const SEND_INTERVAL_MS = 500
// Upper bound for the queue wait we accept: the server cap (45 s default)
// plus joinSession's retry jitter (2 s) and one round trip of slack.
const MAX_ADMISSION_WAIT_MS = Number(__ENV.MAX_ADMISSION_WAIT_MS || 50000)

const STUDENTS = EXAMS * STUDENTS_PER_EXAM
const TOTAL_VUS = STUDENTS + EXAMS
const payloadMix = parsePayloadMix(__ENV.PAYLOAD_MIX || DEFAULT_PAYLOAD_MIX)

// Click on "Teilnehmen" until the session exists (queue wait included).
export const timeToAdmitted = new Trend("rush_time_to_admitted", true)
// Click until the take page has rendered.
export const timeToTakePage = new Trend("rush_time_to_take_page", true)
// Click until the first answer is confirmed over WS.
export const timeToFirstAck = new Trend("rush_time_to_first_ack", true)
export const joinSuccess = new Rate("rush_join_success")
export const takePageOk = new Rate("rush_take_page_ok")
export const queuedStudents = new Counter("rush_queued_students")
export const wsAnswerAckLatency = new Trend("ws_answer_ack_latency", true)
export const wsAcksReceived = new Counter("ws_acks_received")
// One sample per student socket: did it get at least one ack before closing?
// Without it a socket that opens, sends and stalls counts as a success.
export const firstAckOk = new Rate("rush_first_ack_ok")
export const wsClosedWithPending = new Counter("ws_closed_with_pending")
export const answerErrorCount = new Counter("answer_error_count")
export const wsConnectSuccess = new Rate("ws_connect_success")
export const monitorConnectSuccess = new Rate("monitor_connect_success")
export const monitorUpdatesReceived = new Counter("monitor_updates_received")

export const options = {
  ...TLS_OPTIONS,
  setupTimeout: "10m",
  scenarios: {
    rush: {
      // Every VU runs exactly once and all start together: the burst.
      executor: "per-vu-iterations",
      vus: TOTAL_VUS,
      iterations: 1,
      maxDuration: `${Math.ceil((durationToMs(HOLD_TIME) + 120000) / 1000)}s`,
    },
  },
  thresholds: {
    rush_join_success: ["rate>0.99"],
    rush_take_page_ok: ["rate>0.99"],
    // Nobody may wait longer than the configured cap (plus jitter).
    admission_wait_ms: [`max<=${MAX_ADMISSION_WAIT_MS}`],
    "http_req_duration{name:join_session}": ["p(95)<2000"],
    "http_req_duration{name:take_page}": ["p(95)<2000"],
    http_req_failed: ["rate<0.01"],
    ws_connect_success: ["rate>0.99"],
    monitor_connect_success: ["rate>0.99"],
    ws_answer_ack_latency: ["p(95)<100"],
    rush_first_ack_ok: ["rate>0.99"],
    answer_error_count: ["count<1"],
  },
}

export function setup() {
  if (seedUsers.length < STUDENTS) {
    throw new Error(
      `need ${STUDENTS} seeded students, have ${seedUsers.length}`
    )
  }
  const stamp = Date.now()
  const exams = []
  for (let e = 0; e < EXAMS; e++) {
    const teacherHeaders = authHeadersForUser(
      seedTeachers[e % seedTeachers.length]
    )
    const exam = createActiveExam(teacherHeaders, `k6 rush e${e} ${stamp}`, {
      questionTypes: REALISTIC_QUESTION_TYPES,
      timeLimitMin: 90,
    })
    exams.push({
      examId: exam.id,
      accessCode: exam.accessCode,
      questionIdsByType: exam.questionIdsByType,
      teacherHeaders,
    })
  }
  console.log(
    `rush: ${EXAMS} exams x ${STUDENTS_PER_EXAM} students, ${TOTAL_VUS} VUs`
  )
  // `rooms` lets scripts/close-test-exams.py close these afterwards.
  return { rooms: exams }
}

export default function rush(data) {
  const index = __VU - 1
  const holdMs = durationToMs(HOLD_TIME)

  if (index >= STUDENTS) {
    const exam = data.rooms[index - STUDENTS]
    let opened = false
    connectMonitorSocket(exam.teacherHeaders, exam.examId, (socket) => {
      socket.on("open", () => {
        opened = true
        monitorConnectSuccess.add(true)
      })
      socket.on("error", () => {
        if (!opened) monitorConnectSuccess.add(false)
      })
      socket.on("message", (raw) => {
        if (parseEnvelope(raw).type === "monitor:update")
          monitorUpdatesReceived.add(1)
      })
      socket.setTimeout(() => socket.close(), holdMs + 60000)
    })
    return
  }

  const exam = data.rooms[Math.floor(index / STUDENTS_PER_EXAM)]
  const headers = authHeadersForUser(seedUsers[index])
  const clickedAt = Date.now()

  let joined
  try {
    joined = joinSession(headers, exam.accessCode)
  } catch (err) {
    joinSuccess.add(false)
    throw err
  }
  joinSuccess.add(true)
  timeToAdmitted.add(Date.now() - clickedAt)
  if (Date.now() - clickedAt >= 1000) queuedStudents.add(1)

  const page = http.get(`${BASE_URL}/exam/${exam.examId}/take`, {
    headers,
    tags: { name: "take_page" },
    redirects: 0,
  })
  const pageOk = check(page, { "take page 200": (r) => r.status === 200 })
  takePageOk.add(pageOk)
  timeToTakePage.add(Date.now() - clickedAt)
  if (!pageOk) return

  let pendingSentAt = null
  let opened = false
  let firstAck = true
  connectExamSocket(headers, joined.sessionId, (socket) => {
    socket.on("open", () => {
      opened = true
      wsConnectSuccess.add(true)
      socket.setInterval(() => {
        if (pendingSentAt !== null) return
        const { content, questionType } = pickAnswer(payloadMix)
        const questionId = exam.questionIdsByType[questionType]
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
        wsAnswerAckLatency.add(Date.now() - pendingSentAt)
        wsAcksReceived.add(1)
        if (firstAck) {
          timeToFirstAck.add(Date.now() - clickedAt)
          firstAck = false
        }
        pendingSentAt = null
      } else if (msg.type === "answer:error") {
        console.error(`answer:error ${msg.data && msg.data.code}`)
        answerErrorCount.add(1)
        pendingSentAt = null
      }
    })
    socket.on("close", () => {
      if (pendingSentAt !== null) wsClosedWithPending.add(1)
      if (opened) firstAckOk.add(!firstAck)
    })
    socket.setTimeout(() => socket.close(), holdMs)
  })
  sleep(0.1)
}
