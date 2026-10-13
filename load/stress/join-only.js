// Isolated burst join test — join only, no answer spam.
// All VUs join simultaneously to isolate the join bottleneck.
import http from "k6/http"
// `sleep` was used at the bottom of the default function without ever being
// imported, which made every iteration die with a ReferenceError.
import { sleep } from "k6"
import { Trend, Counter } from "k6/metrics"
import { BASE_URL, ORIGIN_HEADER, TLS_OPTIONS } from "../config.js"
import { seedUsers } from "../lib/seedUsers.js"
import { seedTeachers } from "../lib/seedTeachers.js"
import { authHeadersForUser } from "../lib/auth.js"
import { createActiveExam } from "../lib/exam.js"

const JOIN_VUS = Number(__ENV.JOIN_VUS || 200)

export const joinDuration = new Trend("join_duration", true)
export const joinStatus = new Trend("join_status")
// A 202 is the admission queue holding a place rather than an error, so it is
// counted on its own instead of landing in the error log below. This script
// deliberately does NOT wait the queue out (unlike lib/exam.js's
// joinSession): its whole purpose is to hammer the join endpoint, and the
// split between admitted and queued is the measurement. Set
// EXAM_ADMISSION_MAX_WAIT_SEC=0 on the server for the unqueued ceiling.
export const joinQueued = new Counter("join_queued")

export const options = {
  ...TLS_OPTIONS,
  scenarios: {
    burst: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "1s", target: JOIN_VUS },
        { duration: "10s", target: JOIN_VUS },
        { duration: "10s", target: 0 },
      ],
    },
  },
}

const BASE = BASE_URL
const ORIGIN = ORIGIN_HEADER

export function setup() {
  const teacherHeaders = authHeadersForUser(seedTeachers[0])
  const exam = createActiveExam(teacherHeaders, `k6 JOIN-ONLY ${Date.now()}`)
  return { accessCode: exam.accessCode }
}

export default function burstJoin(data) {
  const user = seedUsers[(__VU - 1) % seedUsers.length]
  const authHeaders = {
    Cookie: `better-auth.session_token=${user.sessionCookie}`,
    ...ORIGIN,
    "Content-Type": "application/json",
  }

  const start = Date.now()
  const res = http.post(
    `${BASE}/api/sessions`,
    JSON.stringify({ accessCode: data.accessCode }),
    { headers: authHeaders, tags: { name: "join" } }
  )
  joinDuration.add(Date.now() - start)
  joinStatus.add(res.status)

  if (res.status === 202) joinQueued.add(1)

  if (
    res.status !== 200 &&
    res.status !== 201 &&
    res.status !== 202 &&
    res.status !== 429
  ) {
    // Log the first non-OK, non-rate-limit error for diagnosis.
    if (__VU <= 3) {
      console.error(`VU ${__VU} status=${res.status} body=${res.body.substring(0, 200)}`)
    }
  }

  sleep(0.1)
}
