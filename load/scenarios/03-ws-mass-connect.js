// PRD T1 analogue: ramp CONNECT_VUS students onto /ws/exam/{sessionId}
// within a short window (default 10s, matching the PRD's "1000 students
// within 10s" scenario) and hold the connections open to observe
// steady-state behavior. Sessions are pre-joined in setup() (see
// lib/room.js) so the timed portion is pure WS handshake load.
//
//   pnpm load:ws-connect
//   k6 run load/scenarios/03-ws-mass-connect.js -e CONNECT_VUS=1000 -e RAMP_TIME=10s
// Requires: pnpm load:seed (needs >= CONNECT_VUS seeded student sessions)
import { sleep } from "k6"
import { Trend, Rate } from "k6/metrics"
import { TLS_OPTIONS } from "../config.js"
import { seedUsers } from "../lib/seedUsers.js"
import { getStudentAuthHeaders } from "../lib/auth.js"
import { provisionRoom } from "../lib/room.js"
import { connectExamSocket } from "../lib/ws.js"
import { durationToMs } from "../lib/helpers.js"

const CONNECT_VUS = Number(__ENV.CONNECT_VUS || 100)
const RAMP_TIME = __ENV.RAMP_TIME || "10s"
const HOLD_TIME = __ENV.HOLD_TIME || "30s"

export const wsConnectDuration = new Trend("ws_connect_duration", true)
export const wsConnectSuccess = new Rate("ws_connect_success")

export const options = {
  ...TLS_OPTIONS,
  // Pre-joining CONNECT_VUS sessions in setup() is CONNECT_VUS sequential
  // HTTP round trips (each a different user, so it can't be batched
  // through one rate-limited identity) — bump well past k6's 60s default
  // for large CONNECT_VUS.
  setupTimeout: "10m",
  scenarios: {
    ws_mass_connect: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: RAMP_TIME, target: CONNECT_VUS },
        { duration: HOLD_TIME, target: CONNECT_VUS },
        { duration: "10s", target: 0 },
      ],
    },
  },
  thresholds: {
    ws_connect_success: ["rate>0.99"],
  },
}

export function setup() {
  return provisionRoom("wsconnect", CONNECT_VUS)
}

export default function wsMassConnect(data) {
  const authHeaders = getStudentAuthHeaders(seedUsers)
  const user = seedUsers[(__VU - 1) % seedUsers.length]
  const sessionId = data.sessionIdByEmail[user.email]
  if (!sessionId) return // beyond CONNECT_VUS pre-joined sessions; nothing to connect to

  const connectStart = Date.now()
  let opened = false

  connectExamSocket(authHeaders, sessionId, function (socket) {
    socket.on("open", () => {
      opened = true
      wsConnectDuration.add(Date.now() - connectStart)
      wsConnectSuccess.add(true)
    })
    socket.on("error", () => {
      if (!opened) wsConnectSuccess.add(false)
    })
    // Keep the socket open through the full ramp+hold window so early VUs
    // don't reconnect mid-hold and get measured as reconnect churn instead
    // of sustained connections.
    socket.setTimeout(() => socket.close(), durationToMs(RAMP_TIME) + durationToMs(HOLD_TIME))
  })

  sleep(1)
}
