// End-to-end happy path without WebSocket: join an active exam, then
// autosave answers over the REST fallback path (PUT
// /api/sessions/{id}/answers) — the same endpoint the client falls back to
// when its WebSocket connection is down.
//
//   pnpm load:join
// Requires: pnpm load:seed (needs >= peak VU count seeded student sessions)
import { sleep } from "k6"
import { TLS_OPTIONS } from "../config.js"
import { seedUsers } from "../lib/seedUsers.js"
import { seedTeachers } from "../lib/seedTeachers.js"
import { authHeadersForUser, getStudentAuthHeaders } from "../lib/auth.js"
import { createActiveExam, joinSession } from "../lib/exam.js"
import { multipleChoiceAnswer, saveAnswerRest } from "../lib/answers.js"

export const options = {
  ...TLS_OPTIONS,
  scenarios: {
    join_and_autosave: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "30s", target: 100 },
        { duration: "2m", target: 100 },
        { duration: "30s", target: 0 },
      ],
    },
  },
  thresholds: {
    "http_req_duration{name:join_session}": ["p(95)<200"], // README perf target
    "http_req_duration{name:answer_save_rest}": ["p(95)<200"],
    http_req_failed: ["rate<0.01"],
  },
}

export function setup() {
  const teacherHeaders = authHeadersForUser(seedTeachers[0])
  const exam = createActiveExam(teacherHeaders, `k6 join+autosave ${Date.now()}`)
  return { accessCode: exam.accessCode, questionId: exam.questionId }
}

// Each VU joins once (join is rate-limited 10/60s/user) then autosaves
// repeatedly, mirroring a student answering one question over and over
// through the exam duration.
let session = null

export default function joinAndAutosave(data) {
  const authHeaders = getStudentAuthHeaders(seedUsers)
  if (!session) {
    session = joinSession(authHeaders, data.accessCode)
  }

  saveAnswerRest(authHeaders, session.sessionId, data.questionId, multipleChoiceAnswer())
  sleep(2)
}
