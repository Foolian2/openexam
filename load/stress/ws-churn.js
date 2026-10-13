// Stress test: rapid WebSocket connect/disconnect churn.
// Connects, sends one answer, waits for ack, disconnects, repeats.
// Tests the ws-backend's ability to handle rapid connection turnover
// rather than sustained steady-state connections.
//
//   k6 run load/stress/ws-churn.js -e CHURN_VUS=100 -e CHURN_DURATION=2m
import { Trend, Rate } from "k6/metrics"
import { TLS_OPTIONS } from "../config.js"
import { seedUsers } from "../lib/seedUsers.js"
import { authHeadersForUser } from "../lib/auth.js"
import { provisionRoom } from "../lib/room.js"
import { connectExamSocket, answerSaveEnvelope } from "../lib/ws.js"

const CHURN_VUS = Number(__ENV.CHURN_VUS || 100)
const CHURN_DURATION = __ENV.CHURN_DURATION || "1m"

export const churnHandshake = new Trend("ws_churn_handshake", true)
export const churnNewConn = new Rate("ws_churn_new_conn_success")

export const options = {
  ...TLS_OPTIONS,
  setupTimeout: "10m",
  scenarios: {
    churn: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "5s", target: CHURN_VUS },
        { duration: CHURN_DURATION, target: CHURN_VUS },
        { duration: "10s", target: 0 },
      ],
    },
  },
  thresholds: {
    // Must be the *metric* name, not the JS binding above — k6 aborts on a
    // threshold naming a metric it can't find, which made this script
    // unrunnable when it read `churnNewConn`.
    ws_churn_new_conn_success: ["rate>0.90"],
  },
}

export function setup() {
  return provisionRoom("churn", CHURN_VUS)
}

export default function wsChurn(data) {
  const user = seedUsers[(__VU - 1) % seedUsers.length]
  const sessionId = data.sessionIdByEmail[user.email]
  if (!sessionId) return

  const authHeaders = authHeadersForUser(user)

  const start = Date.now()
  let connectDone = false

  connectExamSocket(authHeaders, sessionId, function (socket) {
    socket.on("open", () => {
      if (!connectDone) {
        connectDone = true
        churnHandshake.add(Date.now() - start)
        churnNewConn.add(true)

        if (socket.readyState === 1) {
          socket.send(
            answerSaveEnvelope(data.questionId, {
              type: "MULTIPLE_CHOICE",
              selectedOptionIds: ["opt-bern"],
            })
          )
        }

        // Close quickly — the point is churn, not long-lived connections.
        socket.setTimeout(() => socket.close(), 500)
      }
    })

    socket.on("error", () => {
      if (!connectDone) churnNewConn.add(false)
    })
  })
}
