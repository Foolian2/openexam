// Exam provisioning helpers for use in setup(), mirroring
// e2e/helpers.ts's createActiveExam(). Always creates exams with
// sebRequired left at its default (false) — replicating the SEB Config Key
// crypto (ws-backend/main.go verifySebWsAccess) is out of scope for load
// testing, so every scenario avoids it entirely.
//
// authHeaders is the { Cookie, Origin } object from auth.js
// (createTeacherAuthHeaders / getStudentAuthHeaders) — every call here
// merges it with a Content-Type as needed.
import http from "k6/http"
import { check, fail, sleep } from "k6"
import { Trend } from "k6/metrics"
import { BASE_URL } from "../config.js"

function jsonHeaders(authHeaders) {
  return { ...authHeaders, "Content-Type": "application/json" }
}

// Question specs, keyed by the answer-content type the scenarios drive.
// Shapes mirror configSchemaByType in lib/validators/question.ts; the
// server rejects anything else at create time, so keep them in sync.
export const QUESTION_SPECS = {
  MULTIPLE_CHOICE: {
    title: "k6 load test question (MC)",
    points: 2,
    required: true,
    type: "MULTIPLE_CHOICE",
    config: {
      multiSelect: false,
      options: [
        { id: "opt-bern", text: "Bern", isCorrect: true },
        { id: "opt-zuerich", text: "Zürich", isCorrect: false },
      ],
    },
  },
  FREE_TEXT: {
    title: "k6 load test question (free text)",
    points: 5,
    required: true,
    type: "FREE_TEXT",
    config: { maxLength: 10000, richText: false },
  },
  SHORT_ANSWER: {
    title: "k6 load test question (short answer)",
    points: 1,
    required: true,
    type: "SHORT_ANSWER",
    config: { acceptedAnswers: ["Bern"], caseSensitive: false, maxLength: 1000 },
  },
  TRUE_FALSE: {
    title: "k6 load test question (true/false)",
    points: 1,
    required: true,
    type: "TRUE_FALSE",
    config: { isCorrect: true },
  },
  CODE: {
    title: "k6 load test question (code)",
    points: 5,
    required: true,
    type: "CODE",
    config: { language: "python", starterCode: "", testCases: [] },
  },
}

// The realistic multi-question exam used by the capacity scenarios: one of
// each type the payload mix can produce, so a single room can serve every
// answer shape without re-provisioning.
export const REALISTIC_QUESTION_TYPES = [
  "MULTIPLE_CHOICE",
  "FREE_TEXT",
  "SHORT_ANSWER",
  "TRUE_FALSE",
  "CODE",
]

// opts.questionTypes: array of QUESTION_SPECS keys. Defaults to a single
// MULTIPLE_CHOICE question so existing callers (scenarios 03/04/05 and the
// stress scripts) keep the exam shape they were written against.
//
// Returns questionId (the first question, for single-question callers) and
// questionIdsByType (for callers driving a payload mix).
export function createActiveExam(authHeaders, title, opts = {}) {
  const questionTypes = opts.questionTypes || ["MULTIPLE_CHOICE"]

  const createRes = http.post(
    `${BASE_URL}/api/exams`,
    JSON.stringify({ title, timeLimitMin: opts.timeLimitMin || 30 }),
    { headers: jsonHeaders(authHeaders) }
  )
  if (!check(createRes, { "exam create ok": (r) => r.status === 200 || r.status === 201 })) {
    fail(`exam create failed: ${createRes.status} ${createRes.body}`)
  }
  const { exam } = createRes.json()

  const questionIdsByType = {}
  for (const type of questionTypes) {
    const spec = QUESTION_SPECS[type]
    if (!spec) fail(`unknown question type "${type}" — add it to QUESTION_SPECS`)

    const questionRes = http.post(
      `${BASE_URL}/api/exams/${exam.id}/questions`,
      JSON.stringify(spec),
      { headers: jsonHeaders(authHeaders) }
    )
    if (!check(questionRes, { "question create ok": (r) => r.status === 201 })) {
      fail(`question create failed (${type}): ${questionRes.status} ${questionRes.body}`)
    }
    questionIdsByType[type] = questionRes.json().question.id
  }

  const publishRes = http.post(`${BASE_URL}/api/exams/${exam.id}/publish`, null, {
    headers: authHeaders,
  })
  if (!check(publishRes, { "publish ok": (r) => r.status === 200 })) {
    fail(`exam publish failed: ${publishRes.status} ${publishRes.body}`)
  }

  const activateRes = http.post(`${BASE_URL}/api/exams/${exam.id}/activate`, null, {
    headers: authHeaders,
  })
  if (!check(activateRes, { "activate ok": (r) => r.status === 200 })) {
    fail(`exam activate failed: ${activateRes.status} ${activateRes.body}`)
  }

  return {
    id: exam.id,
    accessCode: exam.accessCode,
    questionId: questionIdsByType[questionTypes[0]],
    questionIdsByType,
  }
}

// Time a VU spent held by the exam-start admission queue before its session
// was created, 0 when it walked straight in. Reported separately from
// http_req_duration on purpose: a queued wait is the server working as
// designed, and folding it into request latency would make a healthy
// staggered start look like a slow one.
export const admissionWait = new Trend("admission_wait_ms", true)

// How many times joinSession will come back after being queued. The server
// holds each student's place in line, so one return trip is normally all it
// takes; the rest is headroom for a cohort large enough to overflow the
// queue's capacity and receive the capped wait.
const MAX_JOIN_ATTEMPTS = 5

// Extra scatter on the retry, in seconds, mirroring the browser's own
// (components/exam-taking/join-exam-form.tsx): every student capped at the
// server's maximum wait gets the *same* wait, so returning exactly on time
// would rebuild a smaller burst.
const RETRY_JITTER_SEC = 2

// Joins an exam by access code as the given identity, waiting out the
// admission queue the way a real client does (202 + waitMs — see
// lib/exam-admission.ts). Set EXAM_ADMISSION_MAX_WAIT_SEC=0 on the server to
// measure the unqueued ceiling instead; see load/README.md.
//
// Subject to the 10 joins/60s per-user rate limit (app/api/sessions/route.ts)
// — and a queued join spends one attempt per round, not one per student — so
// callers must still join each student exactly once (in setup() when
// pre-joining, or once per VU on its first iteration), never in a loop.
export function joinSession(authHeaders, accessCode) {
  let waitedMs = 0
  for (let attempt = 0; attempt < MAX_JOIN_ATTEMPTS; attempt++) {
    const res = http.post(`${BASE_URL}/api/sessions`, JSON.stringify({ accessCode }), {
      headers: jsonHeaders(authHeaders),
      tags: { name: "join_session" },
    })
    if (res.status === 202) {
      // Queued, not refused: the place in line is reserved and this is when
      // to take it. No check() here — a 202 is a success for this helper, and
      // recording it as a failed check would make every staggered start look
      // like a broken run.
      const waitMs = Number(res.json("waitMs")) || 0
      waitedMs += waitMs
      sleep(waitMs / 1000 + Math.random() * RETRY_JITTER_SEC)
      continue
    }
    if (!check(res, { "join ok": (r) => r.status === 200 || r.status === 201 })) {
      fail(`session join failed: ${res.status} ${res.body}`)
    }
    admissionWait.add(waitedMs)
    return res.json() // { sessionId, examId, exam, resumed }
  }
  fail(
    `session join still queued after ${MAX_JOIN_ATTEMPTS} attempts (${waitedMs}ms waited) — ` +
      `is EXAM_ADMISSION_RATE_PER_SEC far below the offered join rate?`
  )
}
