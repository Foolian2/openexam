package hub

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"openexam/ws-backend/internal/metrics"
	"openexam/ws-backend/internal/protocol"
	"openexam/ws-backend/internal/recovery"
	"openexam/ws-backend/internal/store"
)

// answerSaveBurst and answerSaveRefillRate bound how many answer:save
// messages one session can push through the room goroutine. The real client
// debounces per question (~2 saves/s), so a 60-token burst (a reconnect
// replay of a long exam) plus a 10/s refill is generous headroom; an abusive
// client that floods the socket is throttled to 10/s instead of stalling the
// room behind its Redis round trips on every keystroke.
const (
	answerSaveBurst         = 60.0
	answerSaveRefillRate    = 10.0 // tokens per second
	answerStateCheckTimeout = time.Second
)

// sessionState is the room's in-memory view of one ExamSession, kept in
// sync by control events for timer/UI state and cheap validation. The
// database remains authoritative for each answer save.
type sessionState struct {
	submitted bool
	// EXAM_CLOSED is tracked room-wide on Room.closed (all sessions of the
	// exam end together) — see handleAnswerSave.
	effectiveEndTime *time.Time
	questionTypes    map[string]string

	// Integrity-event bookkeeping. lastIntegrityAt rate-limits per kind so a
	// buggy/hostile client can't flood the room or Postgres; integrityCount
	// keeps growing past maxStoredIntegrityEvents even once we stop
	// persisting individual rows, so the teacher-visible counter stays
	// accurate. Both are seeded/carried over in handleRegister so a
	// reconnect doesn't reset them.
	lastIntegrityAt map[string]time.Time
	integrityCount  int

	// Answer-save token bucket (single-goroutine owned like the rest of
	// sessionState).
	saveTokens     float64
	lastSaveRefill time.Time
}

// allowAnswerSave is a token bucket; call it only from the room goroutine.
func (st *sessionState) allowAnswerSave(now time.Time) bool {
	if st.saveTokens < answerSaveBurst {
		elapsed := now.Sub(st.lastSaveRefill).Seconds()
		if elapsed > 0 {
			st.saveTokens = min(answerSaveBurst, st.saveTokens+elapsed*answerSaveRefillRate)
		}
	}
	st.lastSaveRefill = now
	if st.saveTokens < 1 {
		return false
	}
	st.saveTokens--
	return true
}

type registration struct {
	client      *Client
	sessionAuth *store.ExamSessionAuth // student only
}

// monitorBroadcast carries a monitor delta produced OUTSIDE the room
// goroutine onto it. `patch` is handed over to the room and must not be
// mutated by the sender afterwards.
type monitorBroadcast struct {
	sessionID string
	patch     map[string]any
}

type inboundMsg struct {
	client *Client
	raw    []byte
	// recvAt is stamped by the read pump, not by the room goroutine, so the
	// gap between the two is measurable. See metrics.InboundQueueSeconds.
	recvAt time.Time
}

// redisControlMessage is the JSON shape Next.js publishes on
// exam:{id}:control (see app/api/exams/[id]/activate|close and the
// lock/extend/submit routes).
type redisControlMessage struct {
	Type             string  `json:"type"`
	SessionID        string  `json:"sessionId,omitempty"`
	EffectiveEndTime *string `json:"effectiveEndTime,omitempty"`
	TimeExtensionMin *int    `json:"timeExtensionMin,omitempty"`
	NamApplied       *bool   `json:"namApplied,omitempty"`
}

// redisMonitorMessage is what Go instances publish to exam:{id}:monitor to
// relay a Go-originated delta (e.g. an answer:save) to monitor clients
// connected to *other* instances. OriginID lets a publishing instance skip
// re-delivering to its own already-updated local monitors.
type redisMonitorMessage struct {
	OriginID  string         `json:"originId"`
	SessionID string         `json:"sessionId"`
	Patch     map[string]any `json:"patch"`
}

// RoomStore is the subset of *store.Store a Room needs, narrowed to an
// interface so tests can drive a Room without a real Postgres connection.
type RoomStore interface {
	ListMonitorSessions(ctx context.Context, examID string) ([]store.MonitorSession, error)
	GetAnswerSaveState(ctx context.Context, examID, sessionID string, receivedAt time.Time) (*store.AnswerSaveState, error)
	SaveIntegrityEvent(ctx context.Context, sessionID, kind, detail string, clientTime time.Time) error
}

// AnswerBuffer is the subset of *store.Buffer a Room needs.
type AnswerBuffer interface {
	SaveAnswer(ctx context.Context, examID, sessionID, questionID string, content json.RawMessage, meta store.AnswerMeta) error
}

// ExamFlusher is the subset of *store.Flusher a Room needs.
type ExamFlusher interface {
	FlushExamNow(ctx context.Context, examID string) error
}

// Room owns all WebSocket state for one exam in a single goroutine, so
// student/monitor maps and session state never need locks.
type Room struct {
	examID string

	students map[string]*Client // keyed by ExamSession.id
	monitors map[*Client]struct{}
	state    map[string]*sessionState // keyed by ExamSession.id

	register   chan registration
	unregister chan *Client
	inbound    chan inboundMsg
	control    chan redisControlMessage
	monitorRel chan redisMonitorMessage
	// extBroadcast funnels BroadcastMonitorUpdate onto the room goroutine.
	extBroadcast chan monitorBroadcast
	// async carries blocking I/O off this room's goroutine. See async.go for
	// the contract jobs must honour — in short, I/O only, no room state.
	async chan asyncJob
	// saveLanes run answer-save I/O per session; results come back on
	// saveResults. stopping is closed at teardown. See saves.go.
	saveLanes   map[string]*saveLane
	saveResults chan saveResult
	stopping    chan struct{}

	store      RoomStore
	buffer     AnswerBuffer
	flusher    ExamFlusher
	publish    func(channel string, payload []byte) error
	instanceID string

	idleTimeout time.Duration
	submitGrace time.Duration

	// closed is set once EXAM_CLOSED is handled. It closes the window in
	// which answer:save messages that were already queued in the inbound
	// channel keep being accepted after the exam ended: without it, saves
	// processed after the control event (select may drain inbound first)
	// would still be acked and buffered.
	closed bool

	stopped atomic.Bool
	done    chan struct{}
	log     *slog.Logger

	// flushWg receives the goroutines offloadFlush starts. The Hub points
	// this at its own WaitGroup so shutdown can drain them; rooms built
	// outside a Hub (tests) get a local one in newRoom.
	flushWg *sync.WaitGroup
}

func newRoom(examID string, st RoomStore, buf AnswerBuffer, fl ExamFlusher, publish func(string, []byte) error, instanceID string, idleTimeout, submitGrace time.Duration, log *slog.Logger) *Room {
	if log == nil {
		log = slog.Default()
	}
	return &Room{
		examID:       examID,
		students:     make(map[string]*Client),
		monitors:     make(map[*Client]struct{}),
		state:        make(map[string]*sessionState),
		register:     make(chan registration),
		unregister:   make(chan *Client),
		inbound:      make(chan inboundMsg, 256),
		control:      make(chan redisControlMessage, 32),
		monitorRel:   make(chan redisMonitorMessage, 32),
		extBroadcast: make(chan monitorBroadcast, 32),
		async:        make(chan asyncJob, asyncQueueDepth),
		saveLanes:    make(map[string]*saveLane),
		saveResults:  make(chan saveResult, 256),
		stopping:     make(chan struct{}),
		store:        st,
		buffer:       buf,
		flusher:      fl,
		publish:      publish,
		instanceID:   instanceID,
		idleTimeout:  idleTimeout,
		submitGrace:  submitGrace,
		done:         make(chan struct{}),
		log:          log,
		flushWg:      &sync.WaitGroup{},
	}
}

// IsStopped reports whether this room has already torn itself down (used by
// the Hub to know whether a map entry needs replacing).
func (r *Room) IsStopped() bool { return r.stopped.Load() }

// RegisterStudent joins a student connection to the room, evicting any
// existing connection for the same session (e.g. a browser refresh).
func (r *Room) RegisterStudent(c *Client, sessionAuth *store.ExamSessionAuth) {
	select {
	case r.register <- registration{client: c, sessionAuth: sessionAuth}:
	case <-r.done:
	}
}

// RegisterMonitor joins a teacher connection to the room; it receives a
// snapshot immediately and deltas thereafter.
func (r *Room) RegisterMonitor(c *Client) {
	select {
	case r.register <- registration{client: c}:
	case <-r.done:
	}
}

// Unregister removes a client from the room, whichever kind it is.
func (r *Room) Unregister(c *Client) {
	select {
	case r.unregister <- c:
	case <-r.done:
	}
}

// HandleMessage feeds one raw inbound frame from a client into the room's
// single-goroutine processing loop.
func (r *Room) HandleMessage(c *Client, raw []byte) {
	select {
	case r.inbound <- inboundMsg{client: c, raw: raw, recvAt: time.Now()}:
	case <-r.done:
	}
}

func (r *Room) run(ctx context.Context) {
	idle := time.NewTimer(r.idleTimeout)

	// One background I/O worker for the lifetime of this room. It is started
	// and joined here rather than by the Hub so Hub.wg keeps meaning "all room
	// work has finished" — the worker cannot outlive run(), so shutdown needs
	// no new bookkeeping.
	asyncDone := make(chan struct{})
	go r.runAsync(asyncDone)

	// Deferred calls run LIFO, so these execute bottom-up:
	//   1. stopped.Store(true) — tell the Hub to create a fresh room for any
	//      new joiner, BEFORE the drain below, so a connecting client is never
	//      parked behind queued I/O.
	//   2. drain — close the queue and wait for in-flight jobs to land. Both
	//      teardown paths (ctx cancel and the idle timer) come through here,
	//      so queued integrity writes are never abandoned.
	//   3. close(r.done) — only now do the callers blocked in RegisterStudent
	//      /HandleMessage/Unregister get released, so `done` keeps its meaning
	//      of "this room is completely finished".
	defer idle.Stop()
	defer close(r.done)
	defer func() {
		close(r.async)
		<-asyncDone
	}()
	defer r.stopped.Store(true)
	defer r.stopSaveLanes()
	defer metrics.ActiveRooms.Dec()

	resetIdle := func() {
		if !idle.Stop() {
			select {
			case <-idle.C:
			default:
			}
		}
		if len(r.students) == 0 && len(r.monitors) == 0 {
			idle.Reset(r.idleTimeout)
		}
	}

	for {
		select {
		case <-ctx.Done():
			r.closeAll(websocket.StatusGoingAway, "server shutting down")
			return

		case <-idle.C:
			if len(r.students) == 0 && len(r.monitors) == 0 {
				// A handler may have grabbed this room (GetOrCreateRoom) just
				// as the idle timer fired. Its Register* send blocks on the
				// unbuffered register channel until this loop receives, so
				// draining pending registration traffic once before tearing
				// down is what keeps a just-joined client from being silently
				// left unregistered (no timer:sync, no control events). The
				// handler-side retry in Hub.JoinRoom covers the case where
				// the send lands after this final drain.
				select {
				case reg := <-r.register:
					r.handleRegister(ctx, reg)
					resetIdle()
				case c := <-r.unregister:
					r.handleUnregister(c)
					resetIdle()
				default:
					return
				}
				continue
			}
			idle.Reset(r.idleTimeout)

		case reg := <-r.register:
			r.handleRegister(ctx, reg)
			resetIdle()

		case c := <-r.unregister:
			r.handleUnregister(c)
			resetIdle()

		case msg := <-r.inbound:
			r.handleInbound(ctx, msg)

		case res := <-r.saveResults:
			r.handleSaveResult(res)

		case msg := <-r.control:
			r.handleControl(ctx, msg)

		case b := <-r.extBroadcast:
			r.broadcastMonitorUpdate(b.sessionID, b.patch)

		case msg := <-r.monitorRel:
			if msg.OriginID != r.instanceID {
				r.sendToMonitors(protocol.TypeMonitorUpdate, protocol.MonitorUpdateData{
					SessionID: msg.SessionID, Patch: msg.Patch,
				})
			}
		}
	}
}

func (r *Room) handleRegister(ctx context.Context, reg registration) {
	c := reg.client
	if c.kind == KindMonitor {
		r.monitors[c] = struct{}{}
		metrics.ActiveConnections.WithLabelValues("monitor").Inc()
		r.sendSnapshot(ctx, c)
		return
	}

	// Validate the registration before touching any room state: a broken
	// registration must not evict or replace a working connection, and must
	// not leave an unservable client inserted into r.students.
	if reg.sessionAuth == nil {
		r.log.Error("register: student sessionAuth is nil", "sessionId", c.sessionID)
		c.requestClose(websocket.StatusProtocolError, "internal error")
		return
	}

	if old, ok := r.students[c.sessionID]; ok && old != c {
		old.enqueue(mustEncode(protocol.TypeExamControl, "", protocol.ControlEventData{Action: "SESSION_REPLACED"}))
		old.requestClose(websocket.StatusNormalClosure, "replaced by new connection")
	}
	r.students[c.sessionID] = c
	metrics.ActiveConnections.WithLabelValues("student").Inc()

	st := &sessionState{
		submitted: reg.sessionAuth.Status == "SUBMITTED" || reg.sessionAuth.Status == "AUTO_SUBMITTED",
	}
	// Integrity bookkeeping has to survive reconnects (an expected event
	// mid-exam) and room restarts, otherwise the teacher-visible counter
	// jumps back to 1, the per-session row cap resets, and the per-kind
	// rate limit is bypassed once per reconnect. The DB count is the
	// durable floor; a live count already past maxStoredIntegrityEvents is
	// higher than the DB's and wins.
	st.integrityCount = reg.sessionAuth.IntegrityEventCount
	if prev, ok := r.state[c.sessionID]; ok && prev != nil {
		if prev.integrityCount > st.integrityCount {
			st.integrityCount = prev.integrityCount
		}
		st.lastIntegrityAt = prev.lastIntegrityAt
	}
	st.questionTypes = make(map[string]string, len(reg.sessionAuth.Questions))
	for _, question := range reg.sessionAuth.Questions {
		st.questionTypes[question.ID] = question.Type
	}
	if reg.sessionAuth.EffectiveEndTime != nil {
		t := *reg.sessionAuth.EffectiveEndTime
		st.effectiveEndTime = &t
	}
	r.state[c.sessionID] = st

	c.enqueue(mustEncode(protocol.TypeTimerSync, "", timerSyncPayload(st.effectiveEndTime)))
}

func (r *Room) handleUnregister(c *Client) {
	if c.kind == KindMonitor {
		if _, ok := r.monitors[c]; ok {
			delete(r.monitors, c)
			metrics.ActiveConnections.WithLabelValues("monitor").Dec()
		}
		return
	}
	if cur, ok := r.students[c.sessionID]; ok && cur == c {
		delete(r.students, c.sessionID)
		delete(r.state, c.sessionID)
		metrics.ActiveConnections.WithLabelValues("student").Dec()
	}
}

func (r *Room) handleInbound(ctx context.Context, m inboundMsg) {
	var env protocol.Envelope
	if err := json.Unmarshal(m.raw, &env); err != nil {
		r.log.Warn("dropping malformed inbound message", "examId", r.examID, "error", err)
		return
	}

	metrics.InboundQueueSeconds.
		WithLabelValues(queueLabel(env.Type)).
		Observe(time.Since(m.recvAt).Seconds())

	switch env.Type {
	case protocol.TypePing:
		m.client.enqueue(mustEncode(protocol.TypePong, env.ID, protocol.PongData{ServerNow: nowRFC3339()}))

	case protocol.TypeAnswerSave:
		r.handleAnswerSave(ctx, m.client, env, m.recvAt)

	case protocol.TypeIntegrityEvent:
		r.handleIntegrityEvent(ctx, m.client, env)
	}
}

// queueLabel clamps an envelope type to the set this room actually dispatches
// on. env.Type comes straight off the wire from a student's browser: using it
// as a Prometheus label unfiltered would let one client mint unbounded series
// and take the monitoring stack down with it.
func queueLabel(t string) string {
	switch t {
	case protocol.TypePing, protocol.TypeAnswerSave, protocol.TypeIntegrityEvent:
		return t
	default:
		return "other"
	}
}

// integrityEventRateLimit bounds how often the same kind of event is
// accepted from one session — a rapid alt-tabber or a buggy client
// shouldn't be able to flood the room or Postgres.
const integrityEventRateLimit = 2 * time.Second

// maxStoredIntegrityEvents caps how many rows we persist per session; past
// this the count keeps incrementing (still visible to the teacher) but
// individual events stop being written.
const maxStoredIntegrityEvents = 200

// maxIntegrityDetailLen bounds the free-form detail field. The real client
// only ever sends short tokens ("cut", "F12", ...), but the payload is
// student-controlled and otherwise only bounded by the 64 KB WS read limit.
const maxIntegrityDetailLen = 200

func (r *Room) handleIntegrityEvent(ctx context.Context, c *Client, env protocol.Envelope) {
	var data protocol.IntegrityEventData
	if err := json.Unmarshal(env.Data, &data); err != nil || !protocol.IntegrityEventKinds[data.Kind] {
		return
	}

	st := r.state[c.sessionID]
	if st == nil {
		return
	}

	now := time.Now()
	if st.lastIntegrityAt == nil {
		st.lastIntegrityAt = make(map[string]time.Time)
	}
	if last, ok := st.lastIntegrityAt[data.Kind]; ok && now.Sub(last) < integrityEventRateLimit {
		return
	}
	st.lastIntegrityAt[data.Kind] = now

	detail := data.Detail
	if len(detail) > maxIntegrityDetailLen {
		detail = detail[:maxIntegrityDetailLen]
	}

	if st.integrityCount < maxStoredIntegrityEvents {
		clientTime := now
		if t, err := time.Parse(time.RFC3339Nano, data.ClientTime); err == nil {
			clientTime = t
		}
		// The write is deliberately NOT awaited. It used to be: the counter and
		// the monitor badge were only updated after a successful INSERT, so the
		// badge could never run ahead of the DB-backed REST count. That
		// ordering cost more than it bought — a synchronous Postgres write on
		// the room goroutine, in front of every student's answer save.
		//
		// The new contract is that the badge is OPTIMISTIC. It reflects what
		// the room has accepted, not what Postgres has committed. If a write
		// fails it is logged and the badge is briefly ahead of the database;
		// the two only visibly diverge if that failure is followed by a room
		// teardown (60s idle) whose fresh room re-seeds integrityCount from the
		// DB, at which point the badge steps back. Rate limiting, the stored
		// cap and truncation all still happen on the room goroutine above, so
		// the volume reaching Postgres is unchanged.
		sessionID, kind := c.sessionID, data.Kind
		r.offloadDurable("integrity-write", func(ctx context.Context) {
			if err := r.store.SaveIntegrityEvent(ctx, sessionID, kind, detail, clientTime); err != nil {
				r.log.Error("integrity:event save failed", "sessionId", sessionID, "error", err)
			}
		})
	}
	st.integrityCount++

	r.broadcastMonitorUpdate(c.sessionID, map[string]any{
		"integrityEventCount": st.integrityCount,
		"lastIntegrityEvent":  map[string]any{"kind": data.Kind, "detail": detail, "at": nowRFC3339()},
	})
}

func (r *Room) handleAnswerSave(ctx context.Context, c *Client, env protocol.Envelope, recvAt time.Time) {
	// Every rejection path out of this function replies to the client, and
	// there are ten of them. A deferred observation records all of them
	// without a metrics call before each `return` — and, more importantly,
	// without the next rejection path added here quietly going unmeasured.
	// The success path is different: it does NOT observe here. enqueue only
	// performs a nonblocking write to the client's send buffer, so recording
	// "ok" at this point would call a save "acked" the instant it was merely
	// queued, even if the write pump is congested and the frame reaches the
	// client seconds later or never. Success is instead observed from
	// enqueueWithCallback's onSent, which the write pump runs only once the
	// frame is actually on the wire — that's what makes this the
	// client-visible answer-save-to-ack latency the SLO alert assumes.
	outcome := "rejected"
	defer func() {
		if outcome != "ok" {
			metrics.AnswerAckSeconds.WithLabelValues(outcome).Observe(time.Since(recvAt).Seconds())
		}
	}()

	var data protocol.AnswerSaveData
	if err := json.Unmarshal(env.Data, &data); err != nil || data.QuestionID == "" {
		c.enqueue(mustEncode(protocol.TypeAnswerError, env.ID, protocol.AnswerErrorData{Code: "INVALID_MESSAGE"}))
		return
	}

	st := r.state[c.sessionID]
	if st == nil {
		return
	}
	// A session that submitted keeps its socket open (the client needs the
	// exam:control event), but the room must not keep accepting saves: the
	// REST submit path re-checks status and would reject them, so without
	// this check a submitted student could keep editing answers over the WS
	// and have the edits flushed to the DB after submission. The in-memory
	// flag only flips when the SESSION_SUBMITTED control message is
	// processed, which happens after the REST submit commit. The authoritative
	// Postgres check below closes that missed-control window.
	if st.submitted {
		c.enqueue(mustEncode(protocol.TypeAnswerError, env.ID, protocol.AnswerErrorData{Code: "ALREADY_SUBMITTED"}))
		return
	}
	// Lock state is not tracked in memory: a frame can have been received before
	// lockedAt but reach this goroutine after the lock control event. The
	// authoritative check below compares the read-pump receive time with the
	// committed transition timestamp.
	// EXAM_CLOSED is handled on the same goroutine; saves that were already
	// queued when it arrived could otherwise be processed (and acked) after
	// the exam ended.
	if r.closed {
		c.enqueue(mustEncode(protocol.TypeAnswerError, env.ID, protocol.AnswerErrorData{Code: "EXAM_CLOSED"}))
		return
	}
	if !st.allowAnswerSave(time.Now()) {
		c.enqueue(mustEncode(protocol.TypeAnswerError, env.ID, protocol.AnswerErrorData{Code: "RATE_LIMITED"}))
		return
	}
	questionType, exists := st.questionTypes[data.QuestionID]
	if !exists || !validAnswerContent(data.Content, questionType, c.sessionID, data.QuestionID) ||
		(data.ClientSeq != nil && (*data.ClientSeq <= 0 || *data.ClientSeq > protocol.MaxClientSeq)) {
		c.enqueue(mustEncode(protocol.TypeAnswerError, env.ID, protocol.AnswerErrorData{Code: "INVALID_ANSWER"}))
		return
	}

	// Room state and Redis pub/sub are hints only: the control event that
	// marks a session locked can be dropped, and unlock clears lockedAt. The
	// committed Postgres lifecycle state is checked before any answer goes
	// into Redis, so a save received while locked can never survive a later
	// unlock. That check and the buffer write run on the session's save lane,
	// off this goroutine (saves.go); the reply comes back via saveResults.
	if !r.dispatchSave(saveJob{
		client:   c,
		envID:    env.ID,
		data:     data,
		recvAt:   recvAt,
		examID:   r.examID,
		session:  c.sessionID,
		question: data.QuestionID,
	}) {
		c.enqueue(mustEncode(protocol.TypeAnswerError, env.ID, protocol.AnswerErrorData{Code: "SAVE_UNAVAILABLE"}))
		return
	}
	// The lane owns the reply from here, including its latency metric.
	outcome = "ok"
}

// answerSaveRejection applies the same timestamp boundary as the flusher. A
// pre-transition frame may be accepted after a concurrent lock/submit/close,
// while a frame received after the committed transition is rejected. Unknown
// or incomplete lifecycle state fails closed.
func answerSaveRejection(state *store.AnswerSaveState, receivedAt time.Time, grace time.Duration) string {
	if state == nil {
		return "SAVE_UNAVAILABLE"
	}
	if state.ReceivedWhileLocked {
		return "LOCKED"
	}
	if state.ExamStatus != "ACTIVE" &&
		(state.ExamStatus != "CLOSED" || state.ExamClosedAt == nil || receivedAt.After(*state.ExamClosedAt)) {
		return "EXAM_CLOSED"
	}
	if state.EffectiveEndTime != nil && receivedAt.After(state.EffectiveEndTime.Add(grace)) {
		return "EXPIRED"
	}
	if state.SubmittedAt != nil && receivedAt.After(*state.SubmittedAt) {
		return "ALREADY_SUBMITTED"
	}
	switch state.SessionStatus {
	case "IN_PROGRESS":
		return ""
	case "LOCKED":
		if state.LockedAt != nil && !receivedAt.After(*state.LockedAt) {
			return ""
		}
		return "LOCKED"
	case "SUBMITTED", "AUTO_SUBMITTED":
		if state.SubmittedAt != nil && !receivedAt.After(*state.SubmittedAt) {
			return ""
		}
		return "ALREADY_SUBMITTED"
	default:
		return "SAVE_UNAVAILABLE"
	}
}

func (r *Room) handleControl(ctx context.Context, msg redisControlMessage) {
	switch msg.Type {
	case protocol.ActionExamActivated, protocol.ActionExamClosed:
		if msg.Type == protocol.ActionExamClosed {
			// Set before flushing/closing: queued inbound saves processed
			// between this event and closeAll must be rejected, not acked.
			r.closed = true
		}
		r.sendToAllStudents(protocol.TypeExamControl, protocol.ControlEventData{Action: msg.Type})
		if msg.Type == protocol.ActionExamClosed {
			r.offloadFlush("force flush on EXAM_CLOSED")
			r.closeAll(websocket.StatusNormalClosure, "exam closed")
		}

	case protocol.ActionSessionLocked, protocol.ActionSessionUnlocked:
		// No in-memory lock flag: saves are gated by the durable lock
		// intervals in Postgres (see handleAnswerSave), never by this event.
		if c, ok := r.students[msg.SessionID]; ok {
			c.enqueue(mustEncode(protocol.TypeExamControl, "", protocol.ControlEventData{Action: msg.Type, SessionID: msg.SessionID}))
		}
		r.broadcastMonitorUpdate(msg.SessionID, map[string]any{"status": statusFor(msg.Type)})

	case protocol.ActionSessionExtended:
		var end *time.Time
		if msg.EffectiveEndTime != nil {
			// RFC3339Nano since Next.js sends Date#toISOString(), which always
			// includes millisecond fractions RFC3339's plain layout lacks.
			if t, err := time.Parse(time.RFC3339Nano, *msg.EffectiveEndTime); err == nil {
				end = &t
			}
		}
		if st, ok := r.state[msg.SessionID]; ok {
			st.effectiveEndTime = end
		}
		if c, ok := r.students[msg.SessionID]; ok {
			c.enqueue(mustEncode(protocol.TypeTimerSync, "", timerSyncPayload(end)))
		}
		patch := map[string]any{}
		if msg.EffectiveEndTime != nil {
			patch["effectiveEndTime"] = *msg.EffectiveEndTime
		}
		if msg.TimeExtensionMin != nil {
			patch["timeExtensionMin"] = *msg.TimeExtensionMin
		}
		if msg.NamApplied != nil {
			patch["namApplied"] = *msg.NamApplied
		}
		r.broadcastMonitorUpdate(msg.SessionID, patch)

	case protocol.ActionSessionSubmitted:
		// Tracked so a submit landing mid-connection (the client stays on
		// the socket to receive this event) turns off answer:save for the
		// rest of the connection — see handleAnswerSave.
		if st, ok := r.state[msg.SessionID]; ok {
			st.submitted = true
		}
		if c, ok := r.students[msg.SessionID]; ok {
			c.enqueue(mustEncode(protocol.TypeExamControl, "", protocol.ControlEventData{Action: msg.Type, SessionID: msg.SessionID}))
		}
		r.offloadFlush("force flush on SESSION_SUBMITTED")
		r.broadcastMonitorUpdate(msg.SessionID, map[string]any{"status": "SUBMITTED"})
	}
}

// offloadFlush runs a force-flush in its own goroutine so a slow Postgres
// doesn't stall the room — and with it every student and monitor of this
// exam — at the moment an exam closes or a session submits. FlushExamNow
// is only for promptness; the periodic flusher re-drains anything this
// misses (and the flusher's per-exam lock makes parallel runs safe: exactly
// one flush of an exam proceeds, the others return at once).
//
// The goroutine is registered with flushWg (the hub's WaitGroup when the
// room runs under a Hub) so shutdown waits for in-flight flushes before
// closing the Postgres/Redis pools — a flush that outlives pool closure
// fails after the dirty flag was already handed off, losing acked answers.
func (r *Room) offloadFlush(op string) {
	r.flushWg.Add(1)
	go func() {
		defer r.flushWg.Done()
		defer recovery.Guard(r.log, "offload flush")
		flushCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := r.flusher.FlushExamNow(flushCtx, r.examID); err != nil {
			r.log.Error(op+" failed", "examId", r.examID, "error", err)
			metrics.OffloadFlushes.WithLabelValues("error").Inc()
			return
		}
		metrics.OffloadFlushes.WithLabelValues("ok").Inc()
	}()
}

func statusFor(action string) string {
	if action == protocol.ActionSessionLocked {
		return "LOCKED"
	}
	return "IN_PROGRESS"
}

// BroadcastMonitorUpdate is the exported form of broadcastMonitorUpdate, for
// callers outside this package — namely the WS handshake's SEB Browser Exam
// Key attestation (main.go), which needs to push a live delta from outside
// the room's own message loop.
// BroadcastMonitorUpdate publishes a monitor delta on behalf of a caller that
// is NOT the room goroutine — today the SEB BEK attestation, which runs on the
// WebSocket handshake's HTTP handler goroutine (see ws-backend/main.go).
//
// It hands the delta to the room rather than broadcasting inline. Calling
// broadcastMonitorUpdate directly from another goroutine races the room: it
// iterates r.monitors while handleRegister/handleUnregister write to it. Go
// can escalate a concurrent map read/write into an unrecoverable fatal
// error, taking down every exam on the instance.
//
// Follows the same select-or-done shape as RegisterStudent and HandleMessage,
// so a call against a torn-down room returns instead of blocking forever.
func (r *Room) BroadcastMonitorUpdate(sessionID string, patch map[string]any) {
	select {
	case r.extBroadcast <- monitorBroadcast{sessionID: sessionID, patch: patch}:
	case <-r.done:
	}
}

// broadcastMonitorUpdate delivers a delta to this instance's local monitor
// clients immediately and publishes it so other instances relay it to
// theirs too.
//
// Local delivery stays on the room goroutine: it is one json.Marshal plus a
// non-blocking channel send per monitor, and keeping it here is what
// guarantees local monitors see patches in the order they were produced.
//
// The Redis PUBLISH does not stay. It is a network round trip that ran on the
// room goroutine for EVERY answer save — including saves in exams nobody is
// watching, and in single-instance deployments where no peer exists to relay
// to. Offloading it takes that round trip off the hot path of every save.
// Dropping one publish under extreme load costs a remote monitor one delta,
// which its REST poll already reconciles; stalling every student in the room
// costs far more.
//
// This function itself always runs on the room goroutine — either directly
// from the run loop's own handlers, or via the extBroadcast hand-off for
// BroadcastMonitorUpdate's external callers (see the case in run() and the
// comment on BroadcastMonitorUpdate). offloadLossy therefore never needs to
// guard against a concurrent caller; only room.go's internal call sites and
// the single extBroadcast consumer ever reach here.
func (r *Room) broadcastMonitorUpdate(sessionID string, patch map[string]any) {
	r.sendToMonitors(protocol.TypeMonitorUpdate, protocol.MonitorUpdateData{SessionID: sessionID, Patch: patch})

	if r.publish == nil {
		return
	}
	// Marshalled here, on the room goroutine, so the job closure captures only
	// an immutable []byte — no room state crosses the goroutine boundary.
	payload, err := json.Marshal(redisMonitorMessage{OriginID: r.instanceID, SessionID: sessionID, Patch: patch})
	if err != nil {
		return
	}
	channel := "exam:" + r.examID + ":monitor"
	r.offloadLossy("monitor-publish", func(context.Context) {
		if err := r.publish(channel, payload); err != nil {
			r.log.Error("failed to publish monitor delta", "examId", r.examID, "error", err)
		}
	})
}

func (r *Room) sendSnapshot(ctx context.Context, c *Client) {
	sessions, err := r.store.ListMonitorSessions(ctx, r.examID)
	if err != nil {
		r.log.Error("failed to load monitor snapshot", "examId", r.examID, "error", err)
		return
	}
	c.enqueue(mustEncode(protocol.TypeMonitorSnapshot, "", sessions))
}

func (r *Room) sendToAllStudents(msgType string, data any) {
	payload := mustEncode(msgType, "", data)
	for _, c := range r.students {
		c.enqueue(payload)
	}
}

func (r *Room) sendToMonitors(msgType string, data any) {
	payload := mustEncode(msgType, "", data)
	for c := range r.monitors {
		c.enqueue(payload)
	}
}

func (r *Room) closeAll(code websocket.StatusCode, reason string) {
	for _, c := range r.students {
		c.requestClose(code, reason)
	}
	for c := range r.monitors {
		c.requestClose(code, reason)
	}
}

func timerSyncPayload(end *time.Time) protocol.TimerSyncData {
	var s *string
	if end != nil {
		v := end.UTC().Format(time.RFC3339)
		s = &v
	}
	return protocol.TimerSyncData{EffectiveEndTime: s, ServerNow: nowRFC3339()}
}

func nowRFC3339() string {
	return time.Now().UTC().Format(time.RFC3339)
}

func mustEncode(msgType, id string, data any) []byte {
	b, err := protocol.Encode(msgType, id, data)
	if err != nil {
		// Encoding a well-known internal struct should never fail.
		return []byte(`{"type":"` + msgType + `"}`)
	}
	return b
}
