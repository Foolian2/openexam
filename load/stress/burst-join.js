// Stress test: synchronized burst of session joins to find the breaking
// point of the join flow. All VUs join simultaneously (as close as k6
// permits with a 1s ramp), then hammer answer saves with no debounce.
//
//   k6 run load/stress/burst-join.js
import { sleep } from "k6"
import http from "k6/http"
import { Trend } from "k6/metrics"
import { BASE_URL, TLS_OPTIONS } from "../config.js"
import { seedUsers } from "../lib/seedUsers.js"
import { seedTeachers } from "../lib/seedTeachers.js"
import { authHeadersForUser } from "../lib/auth.js"
import { createActiveExam } from "../lib/exam.js"

const JOIN_VUS = Number(__ENV.JOIN_VUS || 200)
const BURST_DURATION = __ENV.BURST_DURATION || "1m"

export const joinDuration = new Trend("burst_join_duration", true)

export const options = {
  ...TLS_OPTIONS,
  scenarios: {
    burst: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "1s", target: JOIN_VUS },
        { duration: BURST_DURATION, target: JOIN_VUS },
        { duration: "10s", target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.05"],
  },
}

export function setup() {
  const teacherHeaders = authHeadersForUser(seedTeachers[0])
  const exam = createActiveExam(teacherHeaders, `k6 BURST ${Date.now()}`)
  // questionId has to come from setup() — the answer PUTs below are only
  // meaningful against a real question on this exam.
  return { accessCode: exam.accessCode, questionId: exam.questionId }
}

let joined = false
let sessionId = null

export default function burstJoin(data) {
  const user = seedUsers[(__VU - 1) % seedUsers.length]
  const authHeaders = authHeadersForUser(user)

  if (!joined) {
    const start = Date.now()
    const res = http.post(
      `${BASE_URL}/api/sessions`,
      JSON.stringify({ accessCode: data.accessCode }),
      { headers: { ...authHeaders, "Content-Type": "application/json" }, tags: { name: "join" } }
    )
    joinDuration.add(Date.now() - start)

    if (res.status === 200 || res.status === 201) {
      const body = res.json()
      sessionId = body.sessionId
      joined = true
    } else if (res.status === 429) {
      return // rate limited, try next iteration
    } else {
      console.error(`VU ${__VU} join failed: ${res.status} ${res.body}`)
      return
    }
  }

  if (!sessionId) return

  // Once joined, hammer the answer save endpoint as fast as possible.
  // No debounce — each iteration fires immediately.
  http.put(
    `${BASE_URL}/api/sessions/${sessionId}/answers`,
    JSON.stringify({
      questionId: data.questionId,
      content: { type: "MULTIPLE_CHOICE", selectedOptionIds: ["opt-bern"] },
      clientTimestamp: Date.now(),
    }),
    {
      headers: { ...authHeaders, "Content-Type": "application/json" },
      tags: { name: "answer_spam" },
    }
  )

  sleep(0.1)
}
