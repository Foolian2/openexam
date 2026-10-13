// REST answer-spam: pre-join all VUs in setup(), then every VU hammers
// answer saves as fast as possible with no debounce and no sleep.
// This isolates the answer-save bottleneck from join rate limiting.
import { fail } from "k6"
import http from "k6/http"
import { BASE_URL, ORIGIN_HEADER, TLS_OPTIONS } from "../config.js"
import { seedUsers } from "../lib/seedUsers.js"
import { seedTeachers } from "../lib/seedTeachers.js"
import { authHeadersForUser } from "../lib/auth.js"
import { createActiveExam } from "../lib/exam.js"

const SAVE_VUS = Number(__ENV.SAVE_VUS || 200)
const BURST_DURATION = __ENV.BURST_DURATION || "30s"

const BASE = BASE_URL
const ORIGIN = ORIGIN_HEADER

export const options = {
  ...TLS_OPTIONS,
  setupTimeout: "10m",
  scenarios: {
    spam: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "2s", target: SAVE_VUS },
        { duration: BURST_DURATION, target: SAVE_VUS },
        { duration: "5s", target: 0 },
      ],
    },
  },
  thresholds: {
    "http_req_duration{name:answer_spam}": ["p(95)<200"],
    http_req_failed: ["rate<0.05"],
  },
}

export function setup() {
  const teacherHeaders = authHeadersForUser(seedTeachers[0])
  const exam = createActiveExam(teacherHeaders, `k6 SPAM ${Date.now()}`)

  // Pre-join every VU with a distinct seeded student.
  const sessions = []
  for (let i = 0; i < SAVE_VUS; i++) {
    const user = seedUsers[i % seedUsers.length]
    const res = http.post(
      `${BASE}/api/sessions`,
      JSON.stringify({ accessCode: exam.accessCode }),
      { headers: { ...authHeadersForUser(user), "Content-Type": "application/json" } }
    )
    if (res.status !== 200 && res.status !== 201) {
      fail(`pre-join VU ${i} failed: ${res.status} ${res.body}`)
    }
    const { sessionId } = res.json()

    // Also fetch the questionId once.
    const takeRes = http.get(`${BASE}/api/sessions/${sessionId}`, {
      headers: authHeadersForUser(user),
    })
    if (takeRes.status !== 200) fail(`session load failed for VU ${i}: ${takeRes.status}`)
    const { questions } = takeRes.json()

    sessions.push({
      sessionId,
      questionId: questions[0].id,
      cookie: user.sessionCookie,
    })
  }

  return { sessions }
}

export default function answerSpam(data) {
  const slot = data.sessions[(__VU - 1) % data.sessions.length]
  if (!slot) return

  const authHeaders = {
    Cookie: `better-auth.session_token=${slot.cookie}`,
    ...ORIGIN,
    "Content-Type": "application/json",
  }

  // No debounce, no sleep — hit it as fast as k6 can loop.
  http.put(
    `${BASE}/api/sessions/${slot.sessionId}/answers`,
    JSON.stringify({
      questionId: slot.questionId,
      content: { type: "MULTIPLE_CHOICE", selectedOptionIds: ["opt-bern"] },
      clientTimestamp: Date.now(),
    }),
    {
      headers: authHeaders,
      tags: { name: "answer_spam" },
    }
  )
}
