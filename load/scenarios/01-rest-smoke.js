// Baseline authenticated REST latency, no WebSocket involved. Cheapest
// scenario in the suite — run this first to validate the harness (auth
// headers, seed data) before touching anything WS-related.
//
//   pnpm load:smoke
//   k6 run load/scenarios/01-rest-smoke.js -e BASE_URL=http://localhost:3000
// Requires: pnpm load:seed (needs >= peak VU count seeded student sessions)
import { check, sleep } from "k6"
import http from "k6/http"
import { BASE_URL, TLS_OPTIONS } from "../config.js"
import { seedUsers } from "../lib/seedUsers.js"
import { seedTeachers } from "../lib/seedTeachers.js"
import { authHeadersForUser, getStudentAuthHeaders } from "../lib/auth.js"
import { createActiveExam, joinSession } from "../lib/exam.js"

export const options = {
  ...TLS_OPTIONS,
  scenarios: {
    rest_smoke: {
      executor: "constant-arrival-rate",
      rate: 30,
      timeUnit: "1s",
      duration: "2m",
      preAllocatedVUs: 60,
      maxVUs: 100,
    },
  },
  thresholds: {
    "http_req_duration{scenario:rest_smoke}": ["p(95)<200"], // README perf target
    http_req_failed: ["rate<0.01"],
  },
}

export function setup() {
  const teacherHeaders = authHeadersForUser(seedTeachers[0])
  const exam = createActiveExam(teacherHeaders, `k6 REST smoke ${Date.now()}`)
  return { accessCode: exam.accessCode }
}

// Each VU joins the exam exactly once (join is rate-limited 10/60s/user —
// looping it would trip the limiter for no benefit to this scenario).
let joinedThisVU = false

export default function restSmoke(data) {
  const authHeaders = getStudentAuthHeaders(seedUsers)
  if (!joinedThisVU) {
    joinSession(authHeaders, data.accessCode)
    joinedThisVU = true
  }

  const sessionsRes = http.get(`${BASE_URL}/api/sessions`, { headers: authHeaders })
  check(sessionsRes, { "list sessions ok": (r) => r.status === 200 })

  const healthRes = http.get(`${BASE_URL}/api/health`)
  check(healthRes, { "health ok": (r) => r.status === 200 })

  sleep(1)
}
