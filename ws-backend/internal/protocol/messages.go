// Package protocol defines the JSON envelope exchanged over the exam and
// monitor WebSocket connections.
package protocol

import "encoding/json"

// Envelope is the wire format for every message in both directions.
// Id is an optional client-supplied correlation id, echoed back on acks.
type Envelope struct {
	Type string          `json:"type"`
	ID   string          `json:"id,omitempty"`
	Data json.RawMessage `json:"data,omitempty"`
}

// Message types, student <-> server.
const (
	TypeAnswerSave     = "answer:save"
	TypePing           = "ping"
	TypeAnswerAck      = "answer:ack"
	TypeAnswerError    = "answer:error"
	TypeExamControl    = "exam:control"
	TypeTimerSync      = "timer:sync"
	TypePong           = "pong"
	TypeIntegrityEvent = "integrity:event"
)

// IntegrityEventKinds is the allow-list of client-reported integrity signals;
// anything else is dropped rather than persisted, since the payload comes
// from student-controlled browser JS and must not be trusted blindly.
var IntegrityEventKinds = map[string]bool{
	"TAB_HIDDEN":           true,
	"WINDOW_BLUR":          true,
	"PAGE_FOCUS_LOST":      true,
	"COPY_BLOCKED":         true,
	"PASTE_BLOCKED":        true,
	"CONTEXT_MENU_BLOCKED": true,
	"DEVTOOLS_SUSPECTED":   true,
	"SHORTCUT_BLOCKED":     true,
}

// Message types, teacher <-> server.
const (
	TypeMonitorSnapshot = "monitor:snapshot"
	TypeMonitorUpdate   = "monitor:update"
)

// Control actions carried by exam:control, mirrored from the Next.js
// EXAM_ACTIVATED/EXAM_CLOSED publishes and the session lock/extend/submit
// routes added alongside this backend.
const (
	ActionExamActivated    = "EXAM_ACTIVATED"
	ActionExamClosed       = "EXAM_CLOSED"
	ActionSessionLocked    = "SESSION_LOCKED"
	ActionSessionUnlocked  = "SESSION_UNLOCKED"
	ActionSessionExtended  = "SESSION_EXTENDED"
	ActionSessionSubmitted = "SESSION_SUBMITTED"
)

// AnswerSaveData is the payload of an answer:save message from a student.
type AnswerSaveData struct {
	QuestionID string          `json:"questionId"`
	Content    json.RawMessage `json:"content"`
	// ClientSeq orders saves of the same question across the WS and REST
	// paths (see lib/answer-seq.ts). Optional so a client loaded before the
	// field existed keeps saving; such saves are written unconditionally.
	ClientSeq *int64 `json:"clientSeq,omitempty"`
}

// MaxClientSeq mirrors the zod bound in lib/validators/answer.ts: the
// sequence is stored as double precision, which is exact up to 2^53-1.
const MaxClientSeq int64 = 1<<53 - 1

// IntegrityEventData is the payload of an integrity:event message from a
// student — a best-effort client-side behavioral signal (tab switch,
// window blur, clipboard/devtools attempt). Fire-and-forget: no ack is
// sent back, and the server never treats these as proof, only as a signal
// surfaced to the teacher's live monitor.
type IntegrityEventData struct {
	Kind       string `json:"kind"`
	Detail     string `json:"detail,omitempty"`
	ClientTime string `json:"clientTime"`
}

// AnswerAckData acknowledges a buffered (not yet flushed) answer save.
type AnswerAckData struct {
	QuestionID string `json:"questionId"`
	SavedAt    string `json:"savedAt"`
}

// AnswerErrorData reports why an answer:save was rejected.
type AnswerErrorData struct {
	Code string `json:"code"`
}

// ControlEventData is published by Next.js on exam:{id}:control and relayed
// to every connected student in the room, plus SESSION_* variants that only
// target one session (SessionID empty means "all sessions").
type ControlEventData struct {
	Action           string  `json:"action"`
	SessionID        string  `json:"sessionId,omitempty"`
	EffectiveEndTime *string `json:"effectiveEndTime,omitempty"`
	TimeExtensionMin *int    `json:"timeExtensionMin,omitempty"`
}

// TimerSyncData tells a student client the authoritative deadline, sent on
// connect and whenever a SESSION_EXTENDED event changes it.
type TimerSyncData struct {
	EffectiveEndTime *string `json:"effectiveEndTime"`
	ServerNow        string  `json:"serverNow"`
}

// PongData answers a client ping with the server's clock for drift
// correction.
type PongData struct {
	ServerNow string `json:"serverNow"`
}

// MonitorUpdateData is a partial patch to one session row in the teacher's
// live monitor table.
type MonitorUpdateData struct {
	SessionID string         `json:"sessionId"`
	Patch     map[string]any `json:"patch"`
}

func Encode(msgType string, id string, data any) ([]byte, error) {
	raw, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	return json.Marshal(Envelope{Type: msgType, ID: id, Data: raw})
}
