// WebSocket connect helpers for ws-backend (ws-backend/main.go).
//
// Two headers are mandatory on the upgrade request, or the server rejects
// the handshake before it ever reaches application code:
//   - Cookie: the same Better Auth session cookie a browser would send.
//   - Origin: ws-backend accepts the connection via
//     websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: cfg.AllowedOrigins})
//     (ws-backend/main.go:163) — a missing/mismatched Origin fails the
//     handshake the same way a CSRF-rejected REST call would.
//
// authHeaders is the { Cookie, Origin } object auth.js already builds for
// REST calls — k6's ws.connect() takes plain headers (not a CookieJar), so
// it can be passed straight through.
import ws from "k6/ws"
import { WS_URL } from "../config.js"

export function connectExamSocket(authHeaders, sessionId, callback) {
  return ws.connect(`${WS_URL}/ws/exam/${sessionId}`, { headers: authHeaders }, callback)
}

export function connectMonitorSocket(authHeaders, examId, callback) {
  return ws.connect(`${WS_URL}/ws/monitor/${examId}`, { headers: authHeaders }, callback)
}

// Envelope shape per ws-backend/internal/protocol/messages.go:
// { type: string, id?: string, data?: object }
export function buildEnvelope(type, data, id) {
  const envelope = { type }
  if (id !== undefined) envelope.id = id
  if (data !== undefined) envelope.data = data
  return JSON.stringify(envelope)
}

export function parseEnvelope(raw) {
  return JSON.parse(raw)
}

export function answerSaveEnvelope(questionId, content, id) {
  return buildEnvelope("answer:save", { questionId, content }, id)
}

// integrity:event — the one inbound path that does a synchronous Postgres
// write inside the room goroutine (internal/hub/room.go). The server allow-lists `kind`, rate-limits each kind
// to one event per 2s per session, caps `detail` at 200 chars and stops
// persisting after 200 rows per session; a scenario driving this faster than
// 2s/kind measures the rate limiter, not the write path.
export const INTEGRITY_RATE_LIMIT_MS = 2000

export function integrityEventEnvelope(kind, detail) {
  return buildEnvelope("integrity:event", { kind, detail: (detail || "").slice(0, 200) })
}

