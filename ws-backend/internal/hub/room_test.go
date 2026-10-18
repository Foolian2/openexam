package hub

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	ws "github.com/coder/websocket"
	dto "github.com/prometheus/client_model/go"
	"openexam/ws-backend/internal/metrics"

	"openexam/ws-backend/internal/protocol"
	"openexam/ws-backend/internal/store"
)

// fakeRoomStore, fakeBuffer and fakeFlusher let room tests run without a
// real Postgres/Redis connection.
type fakeRoomStore struct {
	mu              sync.Mutex
	snapshot        []store.MonitorSession
	integrityEvents []string // "sessionId:kind:detail"
	answerState     *store.AnswerSaveState
	answerStateErr  error
	answerStateHook func(context.Context, string, string, time.Time) (*store.AnswerSaveState, error)
	// saved is signalled once per SaveIntegrityEvent. Integrity writes are
	// performed on the room's async worker now, so the monitor:update a test
	// reads can arrive BEFORE the write has been recorded — waiting on this
	// channel is the only reliable way to assert on integrityEvents. Buffered
	// so a write never blocks on a test that isn't reading.
	saved chan struct{}
	err   error
}

func newFakeRoomStore() *fakeRoomStore {
	return &fakeRoomStore{saved: make(chan struct{}, 64)}
}

func (f *fakeRoomStore) ListMonitorSessions(ctx context.Context, examID string) ([]store.MonitorSession, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.snapshot, nil
}

func (f *fakeRoomStore) GetAnswerSaveState(ctx context.Context, examID, sessionID string, receivedAt time.Time) (*store.AnswerSaveState, error) {
	f.mu.Lock()
	hook := f.answerStateHook
	state := f.answerState
	err := f.answerStateErr
	f.mu.Unlock()
	if hook != nil {
		return hook(ctx, examID, sessionID, receivedAt)
	}
	if err != nil {
		return nil, err
	}
	if state != nil {
		copy := *state
		return &copy, nil
	}
	return startedSaveState(), nil
}

func (f *fakeRoomStore) SaveIntegrityEvent(ctx context.Context, sessionID, kind, detail string, clientTime time.Time) error {
	f.mu.Lock()
	if f.err != nil {
		err := f.err
		f.mu.Unlock()
		return err
	}
	f.integrityEvents = append(f.integrityEvents, sessionID+":"+kind+":"+detail)
	f.mu.Unlock()
	select {
	case f.saved <- struct{}{}:
	default:
	}
	return nil
}

// events returns a copy, since the async worker may still be writing.
func (f *fakeRoomStore) events() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.integrityEvents...)
}

// waitForSaves blocks until n integrity writes have been recorded, replacing
// the sleeps these tests used when the write was synchronous.
func (f *fakeRoomStore) waitForSaves(t *testing.T, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		select {
		case <-f.saved:
		case <-time.After(2 * time.Second):
			t.Fatalf("timed out waiting for integrity write %d of %d (recorded: %v)", i+1, n, f.events())
		}
	}
}

// expectNoSave asserts no further write lands within a short window — for the
// rate-limit and allow-list tests, which assert on absence.
func (f *fakeRoomStore) expectNoSave(t *testing.T, within time.Duration) {
	t.Helper()
	select {
	case <-f.saved:
		t.Fatalf("unexpected integrity write (recorded: %v)", f.events())
	case <-time.After(within):
	}
}

type fakeBuffer struct {
	mu    sync.Mutex
	saved []string // "sessionId:questionId"
	metas []store.AnswerMeta
	err   error
	// onSave, when set, runs before the save is recorded (outside mu).
	onSave func(questionID string)
}

func (f *fakeBuffer) SaveAnswer(ctx context.Context, examID, sessionID, questionID string, content json.RawMessage, meta store.AnswerMeta) error {
	if f.onSave != nil {
		f.onSave(questionID)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return f.err
	}
	f.saved = append(f.saved, sessionID+":"+questionID)
	f.metas = append(f.metas, meta)
	return nil
}

type fakeFlusher struct {
	mu     sync.Mutex
	forced []string
}

func (f *fakeFlusher) FlushExamNow(ctx context.Context, examID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.forced = append(f.forced, examID)
	return nil
}

// testServer wires a Room to a real WebSocket endpoint over httptest so
// tests exercise the actual coder/websocket read/write path instead of
// calling Room internals directly.
type testServer struct {
	srv  *httptest.Server
	room *Room
	// integritySeed stands in for the already-persisted integrity-event
	// count that GetExamSessionAuth reads; set it before dialing a student.
	integritySeed atomic.Int64
	focusLossSeed atomic.Int64
	// status overrides the ExamSession status the register handler presents;
	// defaults to IN_PROGRESS.
	status string
	// studentGone receives once per student connection after its handler
	// returns. Register/unregister are unbuffered sends to the room, so by
	// then the room has processed the unregister and a redial takes the
	// fresh-register path, not the replace path.
	studentGone chan struct{}
}

func newTestServer(t *testing.T, room *Room) *testServer {
	t.Helper()
	ts := &testServer{room: room, studentGone: make(chan struct{}, 16)}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws/exam/", func(w http.ResponseWriter, r *http.Request) {
		sessionID := r.URL.Query().Get("session")
		conn, err := ws.Accept(w, r, &ws.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		c := NewStudentClient(conn, "user-"+sessionID, sessionID, nil)
		status := ts.status
		if status == "" {
			status = "IN_PROGRESS"
		}
		room.RegisterStudent(c, &store.ExamSessionAuth{
			ID: sessionID, Status: status,
			IntegrityEventCount: int(ts.integritySeed.Load()),
			FocusLossEventCount: int(ts.focusLossSeed.Load()),
			Questions:           []store.QuestionAuth{{ID: "q-1", Type: "FREE_TEXT"}},
		})
		runConn(room, c)
		select {
		case ts.studentGone <- struct{}{}:
		default:
		}
	})
	mux.HandleFunc("/ws/monitor/", func(w http.ResponseWriter, r *http.Request) {
		conn, err := ws.Accept(w, r, &ws.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		c := NewMonitorClient(conn, "teacher-1", nil)
		room.RegisterMonitor(c)
		runConn(room, c)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	ts.srv = srv
	return ts
}

// runConn drives one connection's write pump and read loop, blocking the
// caller (the HTTP handler) until the connection closes — a websocket
// handler must not return before the connection is done, since returning
// cancels the hijacked request's context and severs the socket. Mirrors the
// production runConn in ws-backend/main.go, including the defer order:
// executed LIFO as cancel → unregister → wait, so a pump idle after a
// remote-initiated close is canceled before anything waits on it.
func runConn(room *Room, c *Client) {
	ctx, cancel := context.WithCancel(context.Background())
	defer c.Wait()
	defer room.Unregister(c)
	defer cancel()
	c.StartPump(ctx)
	for {
		_, data, err := c.Conn().Read(ctx)
		if err != nil {
			return
		}
		room.HandleMessage(c, data)
	}
}

func dial(t *testing.T, url string) *ws.Conn {
	t.Helper()
	conn, _, err := ws.Dial(context.Background(), url, nil)
	if err != nil {
		t.Fatalf("dial %s: %v", url, err)
	}
	t.Cleanup(func() { _ = conn.Close(ws.StatusNormalClosure, "") })
	return conn
}

func readEnvelope(t *testing.T, conn *ws.Conn) protocol.Envelope {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var env protocol.Envelope
	if err := json.Unmarshal(data, &env); err != nil {
		t.Fatalf("unmarshal envelope: %v", err)
	}
	return env
}

func wsURL(httpURL, path string) string {
	return "ws" + httpURL[len("http"):] + path
}

// recordingPublisher captures cross-instance monitor publishes. Until these
// tests grew one, `publish` was nil in every test and the publish path — now
// the busiest thing on the async worker — had no coverage at all.
type recordingPublisher struct {
	mu       sync.Mutex
	channels []string
	payloads [][]byte
	got      chan struct{}
	block    chan struct{} // when non-nil, publish waits on it (to fill the queue)
}

func newRecordingPublisher() *recordingPublisher {
	return &recordingPublisher{got: make(chan struct{}, 4096)}
}

func (p *recordingPublisher) publish(channel string, payload []byte) error {
	if p.block != nil {
		<-p.block
	}
	p.mu.Lock()
	p.channels = append(p.channels, channel)
	p.payloads = append(p.payloads, append([]byte(nil), payload...))
	p.mu.Unlock()
	select {
	case p.got <- struct{}{}:
	default:
	}
	return nil
}

func (p *recordingPublisher) count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.payloads)
}

func (p *recordingPublisher) waitFor(t *testing.T, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		select {
		case <-p.got:
		case <-time.After(2 * time.Second):
			t.Fatalf("timed out waiting for publish %d of %d (got %d)", i+1, n, p.count())
		}
	}
}

func newTestRoom(t *testing.T, st RoomStore, buf AnswerBuffer, fl ExamFlusher, idleTimeout time.Duration) (*Room, context.CancelFunc) {
	t.Helper()
	room, _, cancel := newTestRoomWithPublisher(t, st, buf, fl, idleTimeout)
	return room, cancel
}

func newTestRoomWithPublisher(t *testing.T, st RoomStore, buf AnswerBuffer, fl ExamFlusher, idleTimeout time.Duration) (*Room, *recordingPublisher, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	pub := newRecordingPublisher()
	r := newRoom("exam-1", st, buf, fl, pub.publish, "instance-a", idleTimeout, 30*time.Second, nil)
	go r.run(ctx)
	t.Cleanup(cancel)
	return r, pub, cancel
}

func TestRoom_StudentConnect_ReceivesTimerSync(t *testing.T) {
	room, _ := newTestRoom(t, newFakeRoomStore(), &fakeBuffer{}, &fakeFlusher{}, time.Minute)
	ts := newTestServer(t, room)

	conn := dial(t, wsURL(ts.srv.URL, "/ws/exam/x?session=sess-1"))
	env := readEnvelope(t, conn)
	if env.Type != protocol.TypeTimerSync {
		t.Fatalf("got type %q, want timer:sync", env.Type)
	}
}

func TestRoom_AnswerSave_Acks(t *testing.T) {
	buf := &fakeBuffer{}
	room, _ := newTestRoom(t, newFakeRoomStore(), buf, &fakeFlusher{}, time.Minute)
	ts := newTestServer(t, room)

	conn := dial(t, wsURL(ts.srv.URL, "/ws/exam/x?session=sess-1"))
	readEnvelope(t, conn) // timer:sync

	msg, _ := protocol.Encode(protocol.TypeAnswerSave, "req-1", protocol.AnswerSaveData{
		QuestionID: "q-1", Content: json.RawMessage(`{"type":"FREE_TEXT","text":"hi"}`),
	})
	if err := conn.Write(context.Background(), ws.MessageText, msg); err != nil {
		t.Fatalf("write: %v", err)
	}

	env := readEnvelope(t, conn)
	if env.Type != protocol.TypeAnswerAck {
		t.Fatalf("got type %q, want answer:ack", env.Type)
	}
	var ack protocol.AnswerAckData
	_ = json.Unmarshal(env.Data, &ack)
	if ack.QuestionID != "q-1" {
		t.Fatalf("got questionId %q, want q-1", ack.QuestionID)
	}

	buf.mu.Lock()
	defer buf.mu.Unlock()
	if len(buf.saved) != 1 || buf.saved[0] != "sess-1:q-1" {
		t.Fatalf("got saved %v, want [sess-1:q-1]", buf.saved)
	}
}

// The client's sequence number and the frame's receive time are what the
// flusher orders and gates on, so the room must hand both to the buffer.
func TestRoom_AnswerSave_PassesClientSeqAndReceiveTime(t *testing.T) {
	buf := &fakeBuffer{}
	room, _ := newTestRoom(t, newFakeRoomStore(), buf, &fakeFlusher{}, time.Minute)
	ts := newTestServer(t, room)

	conn := dial(t, wsURL(ts.srv.URL, "/ws/exam/x?session=sess-1"))
	readEnvelope(t, conn) // timer:sync

	before := time.Now()
	seq := int64(1_790_000_000_123)
	msg, _ := protocol.Encode(protocol.TypeAnswerSave, "req-1", protocol.AnswerSaveData{
		QuestionID: "q-1", Content: json.RawMessage(`{"type":"FREE_TEXT","text":"hi"}`), ClientSeq: &seq,
	})
	if err := conn.Write(context.Background(), ws.MessageText, msg); err != nil {
		t.Fatalf("write: %v", err)
	}
	if env := readEnvelope(t, conn); env.Type != protocol.TypeAnswerAck {
		t.Fatalf("got type %q, want answer:ack", env.Type)
	}

	buf.mu.Lock()
	defer buf.mu.Unlock()
	if len(buf.metas) != 1 {
		t.Fatalf("got %d saves, want 1", len(buf.metas))
	}
	meta := buf.metas[0]
	if meta.ClientSeq == nil || *meta.ClientSeq != seq {
		t.Fatalf("ClientSeq = %v, want %d", meta.ClientSeq, seq)
	}
	if meta.ReceivedAt.Before(before) || meta.ReceivedAt.After(time.Now()) {
		t.Fatalf("ReceivedAt = %v, want between %v and now", meta.ReceivedAt, before)
	}
}

func TestRoom_AnswerSave_RejectsOutOfRangeClientSeq(t *testing.T) {
	for _, seq := range []int64{0, -1, protocol.MaxClientSeq + 1} {
		buf := &fakeBuffer{}
		room, _ := newTestRoom(t, newFakeRoomStore(), buf, &fakeFlusher{}, time.Minute)
		ts := newTestServer(t, room)

		conn := dial(t, wsURL(ts.srv.URL, "/ws/exam/x?session=sess-1"))
		readEnvelope(t, conn) // timer:sync

		msg, _ := protocol.Encode(protocol.TypeAnswerSave, "req-1", protocol.AnswerSaveData{
			QuestionID: "q-1", Content: json.RawMessage(`{"type":"FREE_TEXT","text":"hi"}`), ClientSeq: &seq,
		})
		if err := conn.Write(context.Background(), ws.MessageText, msg); err != nil {
			t.Fatalf("write: %v", err)
		}
		env := readEnvelope(t, conn)
		var data protocol.AnswerErrorData
		_ = json.Unmarshal(env.Data, &data)
		if env.Type != protocol.TypeAnswerError || data.Code != "INVALID_ANSWER" {
			t.Fatalf("seq %d: got %s %+v, want answer:error INVALID_ANSWER", seq, env.Type, data)
		}
		buf.mu.Lock()
		if len(buf.saved) != 0 {
			t.Fatalf("seq %d: buffered %v, want nothing", seq, buf.saved)
		}
		buf.mu.Unlock()
	}
}

func TestRoom_SecondConnectionEvictsFirst(t *testing.T) {
	room, _ := newTestRoom(t, newFakeRoomStore(), &fakeBuffer{}, &fakeFlusher{}, time.Minute)
	ts := newTestServer(t, room)

	first := dial(t, wsURL(ts.srv.URL, "/ws/exam/x?session=sess-1"))
	readEnvelope(t, first) // timer:sync

	second := dial(t, wsURL(ts.srv.URL, "/ws/exam/x?session=sess-1"))
	readEnvelope(t, second) // timer:sync for the new connection

	// The first connection should receive a SESSION_REPLACED control message
	// and then be closed by the server.
	env := readEnvelope(t, first)
	if env.Type != protocol.TypeExamControl {
		t.Fatalf("got type %q, want exam:control (SESSION_REPLACED)", env.Type)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, _, err := first.Read(ctx); err == nil {
		t.Fatal("expected the evicted connection to be closed")
	}
}

func TestRoom_MonitorReceivesSnapshotThenUpdate(t *testing.T) {
	rs := &fakeRoomStore{snapshot: []store.MonitorSession{{ID: "sess-1", Student: store.MonitorStudent{Name: "Alice"}}}}
	buf := &fakeBuffer{}
	room, _ := newTestRoom(t, rs, buf, &fakeFlusher{}, time.Minute)
	ts := newTestServer(t, room)

	monitor := dial(t, wsURL(ts.srv.URL, "/ws/monitor/exam-1"))
	snap := readEnvelope(t, monitor)
	if snap.Type != protocol.TypeMonitorSnapshot {
		t.Fatalf("got type %q, want monitor:snapshot", snap.Type)
	}

	student := dial(t, wsURL(ts.srv.URL, "/ws/exam/x?session=sess-1"))
	readEnvelope(t, student) // timer:sync

	msg, _ := protocol.Encode(protocol.TypeAnswerSave, "", protocol.AnswerSaveData{
		QuestionID: "q-1", Content: json.RawMessage(`{"type":"FREE_TEXT","text":"hi"}`),
	})
	_ = student.Write(context.Background(), ws.MessageText, msg)
	readEnvelope(t, student) // answer:ack

	update := readEnvelope(t, monitor)
	if update.Type != protocol.TypeMonitorUpdate {
		t.Fatalf("got type %q, want monitor:update", update.Type)
	}
	var data protocol.MonitorUpdateData
	_ = json.Unmarshal(update.Data, &data)
	if data.SessionID != "sess-1" {
		t.Fatalf("got sessionId %q, want sess-1", data.SessionID)
	}
	if _, ok := data.Patch["lastSeenAt"]; !ok {
		t.Fatalf("expected patch to contain lastSeenAt, got %v", data.Patch)
	}
}

func TestRoom_SessionExtendedBroadcastsAccommodationState(t *testing.T) {
	room, _ := newTestRoom(t, newFakeRoomStore(), &fakeBuffer{}, &fakeFlusher{}, time.Minute)
	ts := newTestServer(t, room)

	monitor := dial(t, wsURL(ts.srv.URL, "/ws/monitor/exam-1"))
	readEnvelope(t, monitor) // monitor:snapshot

	timeExtensionMin := 15
	namApplied := true
	room.control <- redisControlMessage{
		Type:             protocol.ActionSessionExtended,
		SessionID:        "sess-1",
		TimeExtensionMin: &timeExtensionMin,
		NamApplied:       &namApplied,
	}

	env := readEnvelope(t, monitor)
	if env.Type != protocol.TypeMonitorUpdate {
		t.Fatalf("got type %q, want monitor:update", env.Type)
	}
	var data protocol.MonitorUpdateData
	if err := json.Unmarshal(env.Data, &data); err != nil {
		t.Fatalf("unmarshal monitor update: %v", err)
	}
	if got := data.Patch["timeExtensionMin"]; got != float64(15) {
		t.Fatalf("got timeExtensionMin %v, want 15", got)
	}
	if got := data.Patch["namApplied"]; got != true {
		t.Fatalf("got namApplied %v, want true", got)
	}
}

func TestRoom_AnswerSave_RejectsQuestionOutsideExam(t *testing.T) {
	buf := &fakeBuffer{}
	room, _ := newTestRoom(t, newFakeRoomStore(), buf, &fakeFlusher{}, time.Minute)
	ts := newTestServer(t, room)

	student := dial(t, wsURL(ts.srv.URL, "/ws/exam/x?session=sess-1"))
	readEnvelope(t, student) // timer:sync

	msg, _ := protocol.Encode(protocol.TypeAnswerSave, "req-1", protocol.AnswerSaveData{
		QuestionID: "another-exam-question", Content: json.RawMessage(`{"type":"FREE_TEXT","text":"hi"}`),
	})
	if err := student.Write(context.Background(), ws.MessageText, msg); err != nil {
		t.Fatalf("write: %v", err)
	}

	env := readEnvelope(t, student)
	if env.Type != protocol.TypeAnswerError {
		t.Fatalf("got type %q, want answer:error", env.Type)
	}
	buf.mu.Lock()
	defer buf.mu.Unlock()
	if len(buf.saved) != 0 {
		t.Fatalf("got saved %v, want no answer writes", buf.saved)
	}
}

// startedSaveState is an open session whose clock has started.
func startedSaveState() *store.AnswerSaveState {
	startedAt := time.Now().Add(-time.Minute)
	return &store.AnswerSaveState{SessionStatus: "IN_PROGRESS", ExamStatus: "ACTIVE", StartedAt: &startedAt}
}

func TestRoom_ControlEvent_LocksStudentAndRejectsSave(t *testing.T) {
	lockedAt := time.Now().Add(-time.Second)
	startedAt := lockedAt.Add(-time.Hour)
	rs := &fakeRoomStore{answerState: &store.AnswerSaveState{
		SessionStatus: "LOCKED", ExamStatus: "ACTIVE", LockedAt: &lockedAt, StartedAt: &startedAt,
	}}
	room, _ := newTestRoom(t, rs, &fakeBuffer{}, &fakeFlusher{}, time.Minute)
	ts := newTestServer(t, room)

	student := dial(t, wsURL(ts.srv.URL, "/ws/exam/x?session=sess-1"))
	readEnvelope(t, student) // timer:sync

	room.control <- redisControlMessage{Type: protocol.ActionSessionLocked, SessionID: "sess-1"}

	env := readEnvelope(t, student)
	if env.Type != protocol.TypeExamControl {
		t.Fatalf("got type %q, want exam:control", env.Type)
	}

	msg, _ := protocol.Encode(protocol.TypeAnswerSave, "", protocol.AnswerSaveData{QuestionID: "q-1", Content: json.RawMessage(`{"type":"FREE_TEXT","text":"hi"}`)})
	_ = student.Write(context.Background(), ws.MessageText, msg)

	errEnv := readEnvelope(t, student)
	if errEnv.Type != protocol.TypeAnswerError {
		t.Fatalf("got type %q, want answer:error", errEnv.Type)
	}
	var data protocol.AnswerErrorData
	_ = json.Unmarshal(errEnv.Data, &data)
	if data.Code != "LOCKED" {
		t.Fatalf("got code %q, want LOCKED", data.Code)
	}
}

func TestRoom_AnswerSave_RejectsAuthoritativeLockWithoutControlEvent(t *testing.T) {
	lockedAt := time.Now().Add(-time.Second)
	startedAt := lockedAt.Add(-time.Hour)
	rs := &fakeRoomStore{answerState: &store.AnswerSaveState{
		SessionStatus: "LOCKED", ExamStatus: "ACTIVE", LockedAt: &lockedAt, StartedAt: &startedAt,
	}}
	buf := &fakeBuffer{}
	room, _ := newTestRoom(t, rs, buf, &fakeFlusher{}, time.Minute)
	ts := newTestServer(t, room) // room memory still says IN_PROGRESS
	student := dial(t, wsURL(ts.srv.URL, "/ws/exam/x?session=sess-1"))
	readEnvelope(t, student)

	msg, _ := protocol.Encode(protocol.TypeAnswerSave, "missed-lock", protocol.AnswerSaveData{
		QuestionID: "q-1", Content: json.RawMessage(`{"type":"FREE_TEXT","text":"blocked"}`),
	})
	_ = student.Write(context.Background(), ws.MessageText, msg)
	errEnv := readEnvelope(t, student)
	if errEnv.Type != protocol.TypeAnswerError {
		t.Fatalf("got %q, want answer:error despite stale room state", errEnv.Type)
	}
	var data protocol.AnswerErrorData
	_ = json.Unmarshal(errEnv.Data, &data)
	if data.Code != "LOCKED" {
		t.Fatalf("got code %q, want LOCKED", data.Code)
	}
	buf.mu.Lock()
	defer buf.mu.Unlock()
	if len(buf.saved) != 0 {
		t.Fatalf("buffered %d answer(s) while PostgreSQL state was LOCKED", len(buf.saved))
	}
}

func TestRoom_AnswerSave_FailsClosedWhenLifecycleCheckErrors(t *testing.T) {
	rs := &fakeRoomStore{answerStateErr: errors.New("database unavailable")}
	buf := &fakeBuffer{}
	room, _ := newTestRoom(t, rs, buf, &fakeFlusher{}, time.Minute)
	ts := newTestServer(t, room)
	student := dial(t, wsURL(ts.srv.URL, "/ws/exam/x?session=sess-1"))
	readEnvelope(t, student)

	msg, _ := protocol.Encode(protocol.TypeAnswerSave, "db-error", protocol.AnswerSaveData{
		QuestionID: "q-1", Content: json.RawMessage(`{"type":"FREE_TEXT","text":"blocked"}`),
	})
	_ = student.Write(context.Background(), ws.MessageText, msg)
	errEnv := readEnvelope(t, student)
	if errEnv.Type != protocol.TypeAnswerError {
		t.Fatalf("got %q, want answer:error on DB failure", errEnv.Type)
	}
	var data protocol.AnswerErrorData
	_ = json.Unmarshal(errEnv.Data, &data)
	if data.Code != "SAVE_UNAVAILABLE" {
		t.Fatalf("got code %q, want SAVE_UNAVAILABLE", data.Code)
	}
	buf.mu.Lock()
	defer buf.mu.Unlock()
	if len(buf.saved) != 0 {
		t.Fatalf("buffered %d answer(s) after lifecycle check failed", len(buf.saved))
	}
}

func TestRoom_AnswerSave_PreservesFrameReceivedBeforeLock(t *testing.T) {
	// Model the DB check running after a lock commits while the socket frame
	// itself was read before lockedAt. This is the boundary the flusher uses.
	lockedAt := time.Now().Add(time.Minute)
	startedAt := lockedAt.Add(-time.Hour)
	rs := &fakeRoomStore{answerState: &store.AnswerSaveState{
		SessionStatus: "LOCKED", ExamStatus: "ACTIVE", LockedAt: &lockedAt, StartedAt: &startedAt,
	}}
	buf := &fakeBuffer{}
	room, _ := newTestRoom(t, rs, buf, &fakeFlusher{}, time.Minute)
	ts := newTestServer(t, room)
	student := dial(t, wsURL(ts.srv.URL, "/ws/exam/x?session=sess-1"))
	readEnvelope(t, student)

	msg, _ := protocol.Encode(protocol.TypeAnswerSave, "pre-lock", protocol.AnswerSaveData{
		QuestionID: "q-1", Content: json.RawMessage(`{"type":"FREE_TEXT","text":"preserve"}`),
	})
	_ = student.Write(context.Background(), ws.MessageText, msg)
	if env := readEnvelope(t, student); env.Type != protocol.TypeAnswerAck {
		t.Fatalf("got %q, want ack for pre-lock frame", env.Type)
	}
	buf.mu.Lock()
	defer buf.mu.Unlock()
	if len(buf.metas) != 1 || buf.metas[0].ReceivedAt.After(lockedAt) {
		t.Fatalf("receivedAt was not preserved as pre-lock: %+v", buf.metas)
	}
}

func TestRoom_AnswerSave_RejectsDelayedCheckForCompletedLockInterval(t *testing.T) {
	entered := make(chan time.Time, 1)
	release := make(chan struct{})
	rs := &fakeRoomStore{answerStateHook: func(_ context.Context, _, _ string, receivedAt time.Time) (*store.AnswerSaveState, error) {
		entered <- receivedAt
		<-release
		return &store.AnswerSaveState{
			SessionStatus: "IN_PROGRESS", ExamStatus: "ACTIVE", ReceivedWhileLocked: true,
		}, nil
	}}
	buf := &fakeBuffer{}
	room, _ := newTestRoom(t, rs, buf, &fakeFlusher{}, time.Minute)
	ts := newTestServer(t, room)
	student := dial(t, wsURL(ts.srv.URL, "/ws/exam/x?session=sess-1"))
	readEnvelope(t, student)
	msg, _ := protocol.Encode(protocol.TypeAnswerSave, "delayed-lock-check", protocol.AnswerSaveData{
		QuestionID: "q-1", Content: json.RawMessage(`{"type":"FREE_TEXT","text":"received while locked"}`),
	})
	if err := student.Write(context.Background(), ws.MessageText, msg); err != nil {
		t.Fatal(err)
	}
	var receivedAt time.Time
	select {
	case receivedAt = <-entered:
	case <-time.After(time.Second):
		t.Fatal("lifecycle check did not start")
	}
	// The store result models a lock interval that ended after receiveAt but
	// before the query completed; current session status is already unlocked.
	close(release)
	env := readEnvelope(t, student)
	if env.Type != protocol.TypeAnswerError {
		t.Fatalf("got %q, want answer:error for delayed lock interval", env.Type)
	}
	var data protocol.AnswerErrorData
	_ = json.Unmarshal(env.Data, &data)
	if data.Code != "LOCKED" {
		t.Fatalf("got code %q, want LOCKED (receivedAt %v)", data.Code, receivedAt)
	}
	buf.mu.Lock()
	defer buf.mu.Unlock()
	if len(buf.saved) != 0 {
		t.Fatalf("buffered %d answer(s) received during completed lock interval", len(buf.saved))
	}
}

func TestAnswerSaveRejectionUsesCommittedLifecycleBoundaries(t *testing.T) {
	base := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
	lockedAt := base.Add(time.Second)
	submittedAt := base.Add(2 * time.Second)
	closedAt := base.Add(3 * time.Second)
	deadline := base.Add(4 * time.Second)
	tests := []struct {
		name     string
		state    store.AnswerSaveState
		received time.Time
		want     string
	}{
		{
			name:     "post-lock frame is denied",
			state:    store.AnswerSaveState{SessionStatus: "LOCKED", ExamStatus: "ACTIVE", LockedAt: &lockedAt, StartedAt: &base},
			received: lockedAt.Add(time.Millisecond), want: "LOCKED",
		},
		{
			name:     "pre-lock frame remains eligible",
			state:    store.AnswerSaveState{SessionStatus: "LOCKED", ExamStatus: "ACTIVE", LockedAt: &lockedAt, StartedAt: &base},
			received: lockedAt, want: "",
		},
		{
			name:     "post-submit frame is denied",
			state:    store.AnswerSaveState{SessionStatus: "SUBMITTED", ExamStatus: "ACTIVE", SubmittedAt: &submittedAt, StartedAt: &base},
			received: submittedAt.Add(time.Millisecond), want: "ALREADY_SUBMITTED",
		},
		{
			name:     "pre-submit frame remains eligible",
			state:    store.AnswerSaveState{SessionStatus: "AUTO_SUBMITTED", ExamStatus: "CLOSED", SubmittedAt: &submittedAt, ExamClosedAt: &closedAt, StartedAt: &base},
			received: submittedAt, want: "",
		},
		{
			name:     "closed exam rejects post-close frame",
			state:    store.AnswerSaveState{SessionStatus: "AUTO_SUBMITTED", ExamStatus: "CLOSED", SubmittedAt: &submittedAt, ExamClosedAt: &closedAt, StartedAt: &base},
			received: closedAt.Add(time.Millisecond), want: "EXAM_CLOSED",
		},
		{
			name:     "deadline grace uses received time",
			state:    store.AnswerSaveState{SessionStatus: "IN_PROGRESS", ExamStatus: "ACTIVE", StartedAt: &base, EffectiveEndTime: &deadline},
			received: deadline.Add(31 * time.Second), want: "EXPIRED",
		},
		{
			name:     "within deadline grace remains eligible",
			state:    store.AnswerSaveState{SessionStatus: "IN_PROGRESS", ExamStatus: "ACTIVE", StartedAt: &base, EffectiveEndTime: &deadline},
			received: deadline.Add(30 * time.Second), want: "",
		},
		{
			name:     "session without a started clock is denied",
			state:    store.AnswerSaveState{SessionStatus: "IN_PROGRESS", ExamStatus: "ACTIVE"},
			received: base, want: "NOT_STARTED",
		},
		{
			name:     "pre-lock frame on a never-started reservation is denied",
			state:    store.AnswerSaveState{SessionStatus: "LOCKED", ExamStatus: "ACTIVE", LockedAt: &lockedAt},
			received: base, want: "NOT_STARTED",
		},
		{
			name:     "pre-submit frame on a never-started reservation is denied",
			state:    store.AnswerSaveState{SessionStatus: "SUBMITTED", ExamStatus: "ACTIVE", SubmittedAt: &submittedAt},
			received: base, want: "NOT_STARTED",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := answerSaveRejection(&tt.state, tt.received, 30*time.Second); got != tt.want {
				t.Fatalf("rejection = %q, want %q", got, tt.want)
			}
		})
	}
}

// Post-submit answer:save rejection is covered by
// TestRoom_AnswerSave_RejectedAfterSubmit (asserts ALREADY_SUBMITTED, the
// code the sessionState.submitted path actually returns).

// TestRoom_AnswerSave_RejectedAfterAutoSubmit covers the register-time
// terminal-status flag for AUTO_SUBMITTED sessions: a teacher-forced close
// marks sessions AUTO_SUBMITTED (not SUBMITTED), and a room that rebuilds
// its state from the DB must treat both as terminal.
func TestRoom_AnswerSave_RejectedAfterAutoSubmit(t *testing.T) {
	buf := &fakeBuffer{}
	room, _ := newTestRoom(t, newFakeRoomStore(), buf, &fakeFlusher{}, time.Minute)
	ts := newTestServer(t, room)
	ts.status = "AUTO_SUBMITTED"

	student := dial(t, wsURL(ts.srv.URL, "/ws/exam/x?session=sess-1"))
	readEnvelope(t, student) // timer:sync

	msg, _ := protocol.Encode(protocol.TypeAnswerSave, "", protocol.AnswerSaveData{QuestionID: "q-1", Content: json.RawMessage(`{"type":"FREE_TEXT","text":"hi"}`)})
	_ = student.Write(context.Background(), ws.MessageText, msg)

	errEnv := readEnvelope(t, student)
	if errEnv.Type != protocol.TypeAnswerError {
		t.Fatalf("got type %q, want answer:error", errEnv.Type)
	}
	var data protocol.AnswerErrorData
	_ = json.Unmarshal(errEnv.Data, &data)
	if data.Code != "ALREADY_SUBMITTED" {
		t.Fatalf("got code %q, want ALREADY_SUBMITTED", data.Code)
	}

	buf.mu.Lock()
	defer buf.mu.Unlock()
	if len(buf.saved) != 0 {
		t.Fatalf("buffer recorded %d saves, want 0", len(buf.saved))
	}
}

func TestRoom_ExamClosed_ForcesFlushAndClosesConnections(t *testing.T) {
	fl := &fakeFlusher{}
	room, _ := newTestRoom(t, newFakeRoomStore(), &fakeBuffer{}, fl, time.Minute)
	ts := newTestServer(t, room)

	student := dial(t, wsURL(ts.srv.URL, "/ws/exam/x?session=sess-1"))
	readEnvelope(t, student) // timer:sync

	room.control <- redisControlMessage{Type: protocol.ActionExamClosed}

	env := readEnvelope(t, student)
	if env.Type != protocol.TypeExamControl {
		t.Fatalf("got type %q, want exam:control", env.Type)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, _, err := student.Read(ctx); err == nil {
		t.Fatal("expected connection to be closed after EXAM_CLOSED")
	}

	// The force-flush now runs off the room goroutine, so wait for it rather
	// than asserting synchronously.
	eventually(t, 2*time.Second, func() bool {
		fl.mu.Lock()
		defer fl.mu.Unlock()
		return len(fl.forced) == 1 && fl.forced[0] == "exam-1"
	}, "force flush after EXAM_CLOSED")
}

// eventually polls cond until it returns true or the timeout elapses.
func eventually(t *testing.T, timeout time.Duration, cond func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		if cond() {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal(msg)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestRoom_IntegrityEvent_PersistsAndBroadcasts(t *testing.T) {
	rs := newFakeRoomStore()
	rs.snapshot = []store.MonitorSession{{ID: "sess-1"}}
	room, _ := newTestRoom(t, rs, &fakeBuffer{}, &fakeFlusher{}, time.Minute)
	ts := newTestServer(t, room)

	monitor := dial(t, wsURL(ts.srv.URL, "/ws/monitor/exam-1"))
	readEnvelope(t, monitor) // monitor:snapshot

	student := dial(t, wsURL(ts.srv.URL, "/ws/exam/x?session=sess-1"))
	readEnvelope(t, student) // timer:sync

	msg, _ := protocol.Encode(protocol.TypeIntegrityEvent, "", protocol.IntegrityEventData{
		Kind: "TAB_HIDDEN", ClientTime: time.Now().UTC().Format(time.RFC3339Nano),
	})
	if err := student.Write(context.Background(), ws.MessageText, msg); err != nil {
		t.Fatalf("write: %v", err)
	}

	// The badge is now optimistic — it is enqueued on the room goroutine
	// before the async write lands — so this may well observe the update
	// before waitForSaves does. That is the documented contract (room.go),
	// not a bug: this test asserts both eventually happened, not their order.
	update := readEnvelope(t, monitor)
	if update.Type != protocol.TypeMonitorUpdate {
		t.Fatalf("got type %q, want monitor:update", update.Type)
	}
	var data protocol.MonitorUpdateData
	_ = json.Unmarshal(update.Data, &data)
	count, _ := data.Patch["integrityEventCount"].(float64)
	if count != 1 {
		t.Fatalf("got integrityEventCount %v, want 1", data.Patch["integrityEventCount"])
	}

	rs.waitForSaves(t, 1)
	if events := rs.events(); len(events) != 1 || events[0] != "sess-1:TAB_HIDDEN:" {
		t.Fatalf("got saved integrity events %v, want [sess-1:TAB_HIDDEN:]", events)
	}
}

func TestRoom_IntegrityEvent_RateLimitedPerKind(t *testing.T) {
	rs := newFakeRoomStore()
	rs.snapshot = []store.MonitorSession{{ID: "sess-1"}}
	room, _ := newTestRoom(t, rs, &fakeBuffer{}, &fakeFlusher{}, time.Minute)
	ts := newTestServer(t, room)

	student := dial(t, wsURL(ts.srv.URL, "/ws/exam/x?session=sess-1"))
	readEnvelope(t, student) // timer:sync

	send := func() {
		msg, _ := protocol.Encode(protocol.TypeIntegrityEvent, "", protocol.IntegrityEventData{
			Kind: "WINDOW_BLUR", ClientTime: time.Now().UTC().Format(time.RFC3339Nano),
		})
		if err := student.Write(context.Background(), ws.MessageText, msg); err != nil {
			t.Fatalf("write: %v", err)
		}
	}

	// Two rapid sends of the same kind should only persist once. The rate
	// limiter itself still runs synchronously on the room goroutine (only the
	// DB write moved), so the second send is rejected before either reaches
	// the async worker — no race to wait out there. What's being waited on
	// below is only "has the one allowed write landed yet".
	send()
	send()

	rs.waitForSaves(t, 1)
	rs.expectNoSave(t, 150*time.Millisecond)
	if events := rs.events(); len(events) != 1 {
		t.Fatalf("got %d saved integrity events, want 1 (second send should be rate-limited)", len(events))
	}
}

func TestRoom_IntegrityEvent_CountSeededFromStoredEvents(t *testing.T) {
	rs := newFakeRoomStore()
	rs.snapshot = []store.MonitorSession{{ID: "sess-1"}}
	room, _ := newTestRoom(t, rs, &fakeBuffer{}, &fakeFlusher{}, time.Minute)
	ts := newTestServer(t, room)
	// 10 events already persisted for this session (e.g. before a reconnect
	// or a room restart) — the badge must continue at 11, not restart at 1.
	ts.integritySeed.Store(10)

	monitor := dial(t, wsURL(ts.srv.URL, "/ws/monitor/exam-1"))
	readEnvelope(t, monitor) // monitor:snapshot

	student := dial(t, wsURL(ts.srv.URL, "/ws/exam/x?session=sess-1"))
	readEnvelope(t, student) // timer:sync

	msg, _ := protocol.Encode(protocol.TypeIntegrityEvent, "", protocol.IntegrityEventData{
		Kind: "TAB_HIDDEN", ClientTime: time.Now().UTC().Format(time.RFC3339Nano),
	})
	if err := student.Write(context.Background(), ws.MessageText, msg); err != nil {
		t.Fatalf("write: %v", err)
	}

	update := readEnvelope(t, monitor)
	var data protocol.MonitorUpdateData
	_ = json.Unmarshal(update.Data, &data)
	if count, _ := data.Patch["integrityEventCount"].(float64); count != 11 {
		t.Fatalf("got integrityEventCount %v, want 11", data.Patch["integrityEventCount"])
	}
	rs.waitForSaves(t, 1)
}

func TestRoom_IntegrityEvent_DetailTruncated(t *testing.T) {
	rs := newFakeRoomStore()
	rs.snapshot = []store.MonitorSession{{ID: "sess-1"}}
	room, _ := newTestRoom(t, rs, &fakeBuffer{}, &fakeFlusher{}, time.Minute)
	ts := newTestServer(t, room)

	student := dial(t, wsURL(ts.srv.URL, "/ws/exam/x?session=sess-1"))
	readEnvelope(t, student) // timer:sync

	msg, _ := protocol.Encode(protocol.TypeIntegrityEvent, "", protocol.IntegrityEventData{
		Kind:       "TAB_HIDDEN",
		Detail:     strings.Repeat("a", 5000),
		ClientTime: time.Now().UTC().Format(time.RFC3339Nano),
	})
	if err := student.Write(context.Background(), ws.MessageText, msg); err != nil {
		t.Fatalf("write: %v", err)
	}

	rs.waitForSaves(t, 1)
	events := rs.events()
	want := "sess-1:TAB_HIDDEN:" + strings.Repeat("a", maxIntegrityDetailLen)
	if len(events) != 1 || events[0] != want {
		t.Fatalf("got saved detail of length %d, want it truncated to %d",
			len(events[0]), maxIntegrityDetailLen)
	}
}

func TestRoom_IntegrityEvent_UnknownKindDropped(t *testing.T) {
	rs := newFakeRoomStore()
	rs.snapshot = []store.MonitorSession{{ID: "sess-1"}}
	room, _ := newTestRoom(t, rs, &fakeBuffer{}, &fakeFlusher{}, time.Minute)
	ts := newTestServer(t, room)

	student := dial(t, wsURL(ts.srv.URL, "/ws/exam/x?session=sess-1"))
	readEnvelope(t, student) // timer:sync

	msg, _ := protocol.Encode(protocol.TypeIntegrityEvent, "", protocol.IntegrityEventData{
		Kind: "NOT_A_REAL_KIND", ClientTime: time.Now().UTC().Format(time.RFC3339Nano),
	})
	if err := student.Write(context.Background(), ws.MessageText, msg); err != nil {
		t.Fatalf("write: %v", err)
	}

	// An unknown kind is dropped in handleInbound before it ever reaches
	// handleIntegrityEvent, so there is no write, sync or async, to wait for.
	// The only honest check for "this event never dispatched anything" is a
	// bounded wait for absence.
	rs.expectNoSave(t, 150*time.Millisecond)
	if events := rs.events(); len(events) != 0 {
		t.Fatalf("got saved integrity events %v, want none for an unknown kind", events)
	}
}

// Regression: a client-initiated close (tab closed, network drop, frontend
// closing after SESSION_SUBMITTED) must tear the connection down without
// deadlocking. With the defers in the wrong order, Wait ran before cancel
// and blocked forever on the idle pump — the handler goroutine leaked,
// Unregister never ran, and the stale client kept the room alive past its
// idle timeout. A drained room goes idle and self-terminates, so done
// closing proves the whole teardown chain ran; a deadlock would leave it
// open until the test times out.
func TestRoom_ClientInitiatedClose_TearsDownWithoutDeadlock(t *testing.T) {
	room, cancel := newTestRoom(t, &fakeRoomStore{}, &fakeBuffer{}, &fakeFlusher{}, 50*time.Millisecond)
	defer cancel()
	ts := newTestServer(t, room)

	conn := dial(t, wsURL(ts.srv.URL, "/ws/exam/x?session=sess-1"))
	readEnvelope(t, conn) // timer:sync

	if err := conn.Close(ws.StatusNormalClosure, ""); err != nil {
		t.Fatalf("client close: %v", err)
	}

	select {
	case <-room.done:
	case <-time.After(2 * time.Second):
		t.Fatal("room never went idle after client-initiated close (handler likely deadlocked before Unregister)")
	}
}

func TestRoom_TeardownWhenIdle(t *testing.T) {
	room, cancel := newTestRoom(t, newFakeRoomStore(), &fakeBuffer{}, &fakeFlusher{}, 50*time.Millisecond)
	defer cancel()

	select {
	case <-room.done:
	case <-time.After(2 * time.Second):
		t.Fatal("expected an empty room to self-terminate after its idle timeout")
	}
	if !room.IsStopped() {
		t.Fatal("expected room to report itself stopped after teardown")
	}
}

// TestRoom_AsyncWorker_PublishesInOrder is the correctness requirement for
// using a single consumer rather than a worker pool: MonitorUpdateData
// carries no sequence number and the frontend blind-merges each patch
// (components/monitor/live-monitor.tsx), so two publishes for the same
// session arriving out of order leave a stale value permanently winning. A
// pool would let a later job's Redis round trip finish before an earlier
// job's — this asserts that doesn't happen for a real burst of saves.
func TestRoom_AsyncWorker_PublishesInOrder(t *testing.T) {
	rs := newFakeRoomStore()
	rs.snapshot = []store.MonitorSession{{ID: "sess-1"}}
	buf := &fakeBuffer{}
	room, pub, _ := newTestRoomWithPublisher(t, rs, buf, &fakeFlusher{}, time.Minute)
	ts := newTestServer(t, room)

	student := dial(t, wsURL(ts.srv.URL, "/ws/exam/x?session=sess-1"))
	readEnvelope(t, student) // timer:sync

	const n = 50
	for i := 0; i < n; i++ {
		msg, _ := protocol.Encode(protocol.TypeAnswerSave, "", protocol.AnswerSaveData{
			QuestionID: "q-1", Content: json.RawMessage(`{"type":"FREE_TEXT","text":"` + string(rune('a'+i%26)) + `"}`),
		})
		if err := student.Write(context.Background(), ws.MessageText, msg); err != nil {
			t.Fatalf("write %d: %v", i, err)
		}
		readEnvelope(t, student) // answer:ack — forces one save per round trip
	}

	pub.waitFor(t, n)

	// Every save's lastSeenAt patch is independently timestamped; monotonic
	// arrival at the fake publisher is exactly what per-room FIFO guarantees
	// and what a pool would risk breaking.
	pub.mu.Lock()
	defer pub.mu.Unlock()
	if len(pub.payloads) != n {
		t.Fatalf("got %d publishes, want %d", len(pub.payloads), n)
	}
	var prev string
	for i, raw := range pub.payloads {
		var msg redisMonitorMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			t.Fatalf("unmarshal publish %d: %v", i, err)
		}
		lastSeenAt, _ := msg.Patch["lastSeenAt"].(string)
		if lastSeenAt == "" {
			t.Fatalf("publish %d missing lastSeenAt", i)
		}
		if lastSeenAt < prev {
			t.Fatalf("publish %d out of order: lastSeenAt %q < previous %q", i, lastSeenAt, prev)
		}
		prev = lastSeenAt
	}
}

// TestRoom_AsyncWorker_DrainsOnContextCancel asserts the room does not report
// itself done — and does not release callers blocked on <-room.done — until
// every queued async job has actually run. Without this, shutdown could
// abandon a queued integrity write or monitor publish.
func TestRoom_AsyncWorker_DrainsOnContextCancel(t *testing.T) {
	rs := newFakeRoomStore()
	rs.snapshot = []store.MonitorSession{{ID: "sess-1"}}
	ctx, cancel := context.WithCancel(context.Background())
	pub := newRecordingPublisher()
	// Block every publish until released below, so at least one job is
	// still in flight (or queued) when shutdown is triggered.
	pub.block = make(chan struct{})
	room := newRoom("exam-1", rs, &fakeBuffer{}, &fakeFlusher{}, pub.publish, "instance-a", time.Minute, 30*time.Second, nil)
	done := make(chan struct{})
	go func() { room.run(ctx); close(done) }()
	t.Cleanup(cancel)

	ts := newTestServer(t, room)
	student := dial(t, wsURL(ts.srv.URL, "/ws/exam/x?session=sess-1"))
	readEnvelope(t, student) // timer:sync

	msg, _ := protocol.Encode(protocol.TypeAnswerSave, "", protocol.AnswerSaveData{
		QuestionID: "q-1", Content: json.RawMessage(`{"type":"FREE_TEXT","text":"x"}`),
	})
	if err := student.Write(context.Background(), ws.MessageText, msg); err != nil {
		t.Fatalf("write: %v", err)
	}
	readEnvelope(t, student) // answer:ack — the save landed; the publish job is now queued/blocked

	cancel() // start shutdown while the publish job is still blocked

	select {
	case <-done:
		t.Fatal("room.run returned before its blocked async job was released — drain did not wait")
	case <-time.After(100 * time.Millisecond):
	}

	close(pub.block) // let the blocked job proceed

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("room.run did not return after its async job was unblocked")
	}
	if pub.count() != 1 {
		t.Fatalf("got %d publishes, want the queued one to have completed before shutdown finished", pub.count())
	}
}

// TestRoom_AsyncWorker_DurableFallsBackInline proves offloadDurable's
// backpressure policy: when the queue is saturated, an integrity write still
// happens — synchronously, on the caller — rather than being dropped. Losing
// a monitor publish under pressure is acceptable (offloadLossy); losing a
// database row is not.
func TestRoom_AsyncWorker_DurableFallsBackInline(t *testing.T) {
	rs := newFakeRoomStore()
	rs.snapshot = []store.MonitorSession{{ID: "sess-1"}}
	room, _ := newTestRoom(t, rs, &fakeBuffer{}, &fakeFlusher{}, time.Minute)

	// Fill the async queue directly, bypassing the room goroutine, so the
	// next offloadDurable call is forced onto its inline fallback path.
	//
	// The consumer immediately dequeues and starts running whatever's sent
	// first, which would leave the buffer one short if the fill loop below
	// raced it — so the first job signals it has actually started executing
	// (and therefore left the buffer) before the deterministic part begins.
	block := make(chan struct{})
	started := make(chan struct{})
	room.async <- func(context.Context) { close(started); <-block }
	<-started
	for i := 0; i < asyncQueueDepth; i++ {
		room.async <- func(context.Context) { <-block }
	}
	defer close(block)

	done := make(chan struct{})
	go func() {
		room.offloadDurable("test-inline-fallback", func(ctx context.Context) {
			_ = rs.SaveIntegrityEvent(ctx, "sess-1", "TAB_HIDDEN", "", time.Now())
		})
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("offloadDurable did not fall back inline when the queue was full")
	}
	if events := rs.events(); len(events) != 1 {
		t.Fatalf("got %d saved integrity events, want 1 from the inline fallback", len(events))
	}
}

func TestRoom_AnswerSave_RejectedAfterSubmit(t *testing.T) {
	buf := &fakeBuffer{}
	room, _ := newTestRoom(t, newFakeRoomStore(), buf, &fakeFlusher{}, time.Minute)
	ts := newTestServer(t, room)

	student := dial(t, wsURL(ts.srv.URL, "/ws/exam/x?session=sess-1"))
	readEnvelope(t, student) // timer:sync

	// Submit while the connection is open (the REST submit route publishes
	// SESSION_SUBMITTED; the client stays on the socket to receive it).
	room.control <- redisControlMessage{Type: protocol.ActionSessionSubmitted, SessionID: "sess-1"}
	env := readEnvelope(t, student)
	if env.Type != protocol.TypeExamControl {
		t.Fatalf("got type %q, want exam:control", env.Type)
	}

	msg, _ := protocol.Encode(protocol.TypeAnswerSave, "", protocol.AnswerSaveData{QuestionID: "q-1", Content: json.RawMessage(`{"type":"FREE_TEXT","text":"hi"}`)})
	_ = student.Write(context.Background(), ws.MessageText, msg)

	errEnv := readEnvelope(t, student)
	if errEnv.Type != protocol.TypeAnswerError {
		t.Fatalf("got type %q, want answer:error", errEnv.Type)
	}
	var data protocol.AnswerErrorData
	_ = json.Unmarshal(errEnv.Data, &data)
	if data.Code != "ALREADY_SUBMITTED" {
		t.Fatalf("got code %q, want ALREADY_SUBMITTED", data.Code)
	}

	buf.mu.Lock()
	defer buf.mu.Unlock()
	if len(buf.saved) != 0 {
		t.Fatalf("got %d buffered saves after submit, want 0", len(buf.saved))
	}
}

func TestRoom_AnswerSave_RateLimited(t *testing.T) {
	buf := &fakeBuffer{}
	room, _ := newTestRoom(t, newFakeRoomStore(), buf, &fakeFlusher{}, time.Minute)
	ts := newTestServer(t, room)

	student := dial(t, wsURL(ts.srv.URL, "/ws/exam/x?session=sess-1"))
	readEnvelope(t, student) // timer:sync

	// Drive well past the token bucket's capacity. Each save round-trips its
	// ack before the next write so the small send buffer never fills; the
	// refill rate (10/s) is negligible over a ~70 round-trip burst.
	const sends = 70
	acks, rateLimited := 0, 0
	for i := 0; i < sends; i++ {
		msg, _ := protocol.Encode(protocol.TypeAnswerSave, "", protocol.AnswerSaveData{QuestionID: "q-1", Content: json.RawMessage(`{"type":"FREE_TEXT","text":"hi"}`)})
		if err := student.Write(context.Background(), ws.MessageText, msg); err != nil {
			t.Fatalf("write %d: %v", i, err)
		}
		env := readEnvelope(t, student)
		switch env.Type {
		case protocol.TypeAnswerAck:
			acks++
		case protocol.TypeAnswerError:
			var data protocol.AnswerErrorData
			_ = json.Unmarshal(env.Data, &data)
			if data.Code == "RATE_LIMITED" {
				rateLimited++
			}
		}
	}

	if acks == 0 {
		t.Fatal("no save was ever accepted")
	}
	if rateLimited == 0 {
		t.Fatal("expected at least one RATE_LIMITED rejection past the bucket capacity")
	}
	if acks+rateLimited != sends {
		t.Fatalf("got %d acks + %d errors, want %d responses", acks, rateLimited, sends)
	}
	buf.mu.Lock()
	defer buf.mu.Unlock()
	if len(buf.saved) != acks {
		t.Fatalf("got %d buffered saves, want %d", len(buf.saved), acks)
	}
}

// reconnectStudent closes conn, waits until the room has unregistered it,
// and dials the same session again.
func reconnectStudent(t *testing.T, ts *testServer, conn *ws.Conn, sessionID string) *ws.Conn {
	t.Helper()
	if err := conn.Close(ws.StatusNormalClosure, ""); err != nil {
		t.Fatalf("close: %v", err)
	}
	select {
	case <-ts.studentGone:
	case <-time.After(5 * time.Second):
		t.Fatal("student connection was never unregistered")
	}
	next := dial(t, wsURL(ts.srv.URL, "/ws/exam/x?session="+sessionID))
	readEnvelope(t, next) // timer:sync
	return next
}

// saveRoundTrips sends n answer saves one at a time and counts the replies.
func saveRoundTrips(t *testing.T, conn *ws.Conn, n int) (acks, rateLimited int) {
	t.Helper()
	for i := 0; i < n; i++ {
		msg, _ := protocol.Encode(protocol.TypeAnswerSave, "", protocol.AnswerSaveData{QuestionID: "q-1", Content: json.RawMessage(`{"type":"FREE_TEXT","text":"hi"}`)})
		if err := conn.Write(context.Background(), ws.MessageText, msg); err != nil {
			t.Fatalf("write %d: %v", i, err)
		}
		env := readEnvelope(t, conn)
		switch env.Type {
		case protocol.TypeAnswerAck:
			acks++
		case protocol.TypeAnswerError:
			var data protocol.AnswerErrorData
			_ = json.Unmarshal(env.Data, &data)
			if data.Code == "RATE_LIMITED" {
				rateLimited++
			}
		}
	}
	return acks, rateLimited
}

func TestRoom_AnswerSave_RateLimitSurvivesReconnect(t *testing.T) {
	room, _ := newTestRoom(t, newFakeRoomStore(), &fakeBuffer{}, &fakeFlusher{}, time.Minute)
	ts := newTestServer(t, room)

	student := dial(t, wsURL(ts.srv.URL, "/ws/exam/x?session=sess-1"))
	readEnvelope(t, student) // timer:sync
	if _, rateLimited := saveRoundTrips(t, student, 70); rateLimited == 0 {
		t.Fatal("bucket was never drained")
	}

	// A fresh bucket would accept all 20 (burst 60); a preserved one only
	// what the 10/s refill adds during the round trips.
	student = reconnectStudent(t, ts, student, "sess-1")
	acks, rateLimited := saveRoundTrips(t, student, 20)
	if rateLimited == 0 {
		t.Fatalf("reconnect refilled the save budget: %d/20 acked, none rate-limited", acks)
	}
}

func TestRoom_IntegrityEvent_RateLimitSurvivesReconnect(t *testing.T) {
	rs := newFakeRoomStore()
	rs.snapshot = []store.MonitorSession{{ID: "sess-1"}}
	room, _ := newTestRoom(t, rs, &fakeBuffer{}, &fakeFlusher{}, time.Minute)
	ts := newTestServer(t, room)

	send := func(conn *ws.Conn) {
		msg, _ := protocol.Encode(protocol.TypeIntegrityEvent, "", protocol.IntegrityEventData{
			Kind: "WINDOW_BLUR", ClientTime: time.Now().UTC().Format(time.RFC3339Nano),
		})
		if err := conn.Write(context.Background(), ws.MessageText, msg); err != nil {
			t.Fatalf("write: %v", err)
		}
	}

	student := dial(t, wsURL(ts.srv.URL, "/ws/exam/x?session=sess-1"))
	readEnvelope(t, student) // timer:sync
	send(student)
	rs.waitForSaves(t, 1)

	// Same kind again, well inside integrityEventRateLimit, on a new
	// connection after a clean disconnect: still rate-limited.
	student = reconnectStudent(t, ts, student, "sess-1")
	send(student)
	rs.expectNoSave(t, 150*time.Millisecond)
	if events := rs.events(); len(events) != 1 {
		t.Fatalf("got %d saved integrity events, want 1 (reconnect must not reset the per-kind limit)", len(events))
	}
}

func TestRoom_IntegrityEvent_CountSurvivesReconnect(t *testing.T) {
	rs := newFakeRoomStore()
	rs.snapshot = []store.MonitorSession{{ID: "sess-1"}}
	room, _ := newTestRoom(t, rs, &fakeBuffer{}, &fakeFlusher{}, time.Minute)
	ts := newTestServer(t, room)
	// The DB count stops at maxStoredIntegrityEvents; the live count past it
	// must not step back to the DB's after a reconnect.
	ts.integritySeed.Store(maxStoredIntegrityEvents)

	monitor := dial(t, wsURL(ts.srv.URL, "/ws/monitor/exam-1"))
	readEnvelope(t, monitor) // monitor:snapshot

	count := func(conn *ws.Conn, kind string) float64 {
		t.Helper()
		msg, _ := protocol.Encode(protocol.TypeIntegrityEvent, "", protocol.IntegrityEventData{
			Kind: kind, ClientTime: time.Now().UTC().Format(time.RFC3339Nano),
		})
		if err := conn.Write(context.Background(), ws.MessageText, msg); err != nil {
			t.Fatalf("write: %v", err)
		}
		update := readEnvelope(t, monitor)
		var data protocol.MonitorUpdateData
		_ = json.Unmarshal(update.Data, &data)
		n, _ := data.Patch["integrityEventCount"].(float64)
		return n
	}

	student := dial(t, wsURL(ts.srv.URL, "/ws/exam/x?session=sess-1"))
	readEnvelope(t, student) // timer:sync
	if got := count(student, "WINDOW_BLUR"); got != maxStoredIntegrityEvents+1 {
		t.Fatalf("got integrityEventCount %v, want %d", got, maxStoredIntegrityEvents+1)
	}

	student = reconnectStudent(t, ts, student, "sess-1")
	if got := count(student, "TAB_HIDDEN"); got != maxStoredIntegrityEvents+2 {
		t.Fatalf("got integrityEventCount %v after reconnect, want %d", got, maxStoredIntegrityEvents+2)
	}
}

func TestClient_CloseNow_ConcurrentSafe(t *testing.T) {
	clientCh := make(chan *Client, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := ws.Accept(w, r, &ws.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		c := NewStudentClient(conn, "user-1", "sess-1", nil)
		clientCh <- c
		<-c.Closed() // hold the handler open until closeNow fires
	}))
	defer srv.Close()

	conn := dial(t, wsURL(srv.URL, "/"))
	defer func() { _ = conn.Close(ws.StatusNormalClosure, "") }()
	c := <-clientCh

	// closeNow is reachable from multiple goroutines concurrently (the room
	// goroutine's slow-consumer path via closeAsync and the write pump's
	// write-error path); every one of them must be able to win the race
	// without a double close of the closed channel panicking the process.
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c.closeNow(ws.StatusPolicyViolation, "test")
		}()
	}
	wg.Wait()

	select {
	case <-c.closed:
	default:
		t.Fatal("closed channel not signalled after closeNow")
	}
}

// The lifecycle check is a Postgres round trip. It must not run on the room
// goroutine: one student's slow check would otherwise stall every other
// student's saves (and timer/control traffic) in the exam.
func TestRoom_AnswerSave_SlowCheckDoesNotBlockOtherSessions(t *testing.T) {
	release := make(chan struct{})
	rs := &fakeRoomStore{answerStateHook: func(_ context.Context, _, sessionID string, _ time.Time) (*store.AnswerSaveState, error) {
		if sessionID == "sess-slow" {
			<-release
		}
		return startedSaveState(), nil
	}}
	room, _ := newTestRoom(t, rs, &fakeBuffer{}, &fakeFlusher{}, time.Minute)
	ts := newTestServer(t, room)
	slow := dial(t, wsURL(ts.srv.URL, "/ws/exam/x?session=sess-slow"))
	readEnvelope(t, slow)
	fast := dial(t, wsURL(ts.srv.URL, "/ws/exam/x?session=sess-fast"))
	readEnvelope(t, fast)

	save := func(conn *ws.Conn, id string) {
		msg, _ := protocol.Encode(protocol.TypeAnswerSave, id, protocol.AnswerSaveData{
			QuestionID: "q-1", Content: json.RawMessage(`{"type":"FREE_TEXT","text":"x"}`),
		})
		if err := conn.Write(context.Background(), ws.MessageText, msg); err != nil {
			t.Fatal(err)
		}
	}
	save(slow, "slow-1")
	save(fast, "fast-1")

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, raw, err := fast.Read(ctx)
	if err != nil {
		t.Fatalf("fast session got no reply while another session's check was pending: %v", err)
	}
	var env protocol.Envelope
	_ = json.Unmarshal(raw, &env)
	if env.Type != protocol.TypeAnswerAck || env.ID != "fast-1" {
		t.Fatalf("got %q/%q, want answer:ack for fast-1", env.Type, env.ID)
	}

	close(release)
	if env := readEnvelope(t, slow); env.Type != protocol.TypeAnswerAck || env.ID != "slow-1" {
		t.Fatalf("got %q/%q, want answer:ack for slow-1 once its check finished", env.Type, env.ID)
	}
}

// One session's saves still run in arrival order on its lane.
func TestRoom_AnswerSave_KeepsPerSessionOrder(t *testing.T) {
	var mu sync.Mutex
	calls := 0
	first := make(chan struct{})
	rs := &fakeRoomStore{answerStateHook: func(_ context.Context, _, _ string, _ time.Time) (*store.AnswerSaveState, error) {
		return startedSaveState(), nil
	}}
	buf := &fakeBuffer{onSave: func(string) {
		mu.Lock()
		calls++
		n := calls
		mu.Unlock()
		if n == 1 {
			<-first // hold the first save while the second is queued behind it
		}
	}}
	room, _ := newTestRoom(t, rs, buf, &fakeFlusher{}, time.Minute)
	ts := newTestServer(t, room)
	student := dial(t, wsURL(ts.srv.URL, "/ws/exam/x?session=sess-1"))
	readEnvelope(t, student)
	for _, id := range []string{"save-1", "save-2"} {
		msg, _ := protocol.Encode(protocol.TypeAnswerSave, id, protocol.AnswerSaveData{
			QuestionID: "q-1", Content: json.RawMessage(`{"type":"FREE_TEXT","text":"` + id + `"}`),
		})
		_ = student.Write(context.Background(), ws.MessageText, msg)
	}
	time.Sleep(50 * time.Millisecond)
	mu.Lock()
	started := calls
	mu.Unlock()
	if started != 1 {
		t.Fatalf("%d buffer writes started while the first was held, want 1 (saves overtook each other)", started)
	}
	close(first)
	for _, want := range []string{"save-1", "save-2"} {
		if env := readEnvelope(t, student); env.ID != want {
			t.Fatalf("got ack %q, want %q", env.ID, want)
		}
	}
}

func TestRoom_FocusLossIsInformationalAcrossReconnect(t *testing.T) {
	rs := newFakeRoomStore()
	rs.snapshot = []store.MonitorSession{{ID: "sess-1"}}
	room, _ := newTestRoom(t, rs, &fakeBuffer{}, &fakeFlusher{}, time.Minute)
	ts := newTestServer(t, room)
	ts.integritySeed.Store(3)
	ts.focusLossSeed.Store(4)
	monitor := dial(t, wsURL(ts.srv.URL, "/ws/monitor/exam-1"))
	readEnvelope(t, monitor)
	student := dial(t, wsURL(ts.srv.URL, "/ws/exam/x?session=sess-1"))
	readEnvelope(t, student)
	send := func(c *ws.Conn, kind string, warnings, info float64) {
		t.Helper()
		msg, _ := protocol.Encode(protocol.TypeIntegrityEvent, "", protocol.IntegrityEventData{Kind: kind})
		if err := c.Write(context.Background(), ws.MessageText, msg); err != nil {
			t.Fatal(err)
		}
		update := readEnvelope(t, monitor)
		var data protocol.MonitorUpdateData
		if err := json.Unmarshal(update.Data, &data); err != nil {
			t.Fatal(err)
		}
		if data.Patch["integrityEventCount"] != warnings || data.Patch["focusLossEventCount"] != info {
			t.Fatalf("unexpected counts: %v, want warnings=%v info=%v", data.Patch, warnings, info)
		}
	}
	send(student, "PAGE_FOCUS_LOST", 3, 5)
	rs.waitForSaves(t, 1)
	if err := student.Close(ws.StatusNormalClosure, "reconnect"); err != nil {
		t.Fatal(err)
	}
	<-ts.studentGone
	// Stale persisted counts must not undo either live counter.
	student = dial(t, wsURL(ts.srv.URL, "/ws/exam/x?session=sess-1"))
	readEnvelope(t, student)
	send(student, "TAB_HIDDEN", 4, 5)
	rs.waitForSaves(t, 1)
	if got := rs.events(); got[0] != "sess-1:PAGE_FOCUS_LOST:" || got[1] != "sess-1:TAB_HIDDEN:" {
		t.Fatalf("unexpected saved events: %v", got)
	}
}

func TestRoom_FocusLossHasSeparateStoredEventCap(t *testing.T) {
	rs := newFakeRoomStore()
	room, _ := newTestRoom(t, rs, &fakeBuffer{}, &fakeFlusher{}, time.Minute)
	ts := newTestServer(t, room)
	ts.integritySeed.Store(100)
	ts.focusLossSeed.Store(maxStoredFocusLossEvents)
	monitor := dial(t, wsURL(ts.srv.URL, "/ws/monitor/exam-1"))
	readEnvelope(t, monitor)
	student := dial(t, wsURL(ts.srv.URL, "/ws/exam/x?session=sess-1"))
	readEnvelope(t, student)
	send := func(kind string, warnings, info float64) {
		t.Helper()
		msg, _ := protocol.Encode(protocol.TypeIntegrityEvent, "", protocol.IntegrityEventData{Kind: kind})
		if err := student.Write(context.Background(), ws.MessageText, msg); err != nil {
			t.Fatal(err)
		}
		var data protocol.MonitorUpdateData
		update := readEnvelope(t, monitor)
		if err := json.Unmarshal(update.Data, &data); err != nil {
			t.Fatal(err)
		}
		if data.Patch["integrityEventCount"] != warnings || data.Patch["focusLossEventCount"] != info {
			t.Fatalf("unexpected counts: %v, want warnings=%v info=%v", data.Patch, warnings, info)
		}
	}
	// Focus loss at its own cap is counted but not persisted...
	send("PAGE_FOCUS_LOST", 100, maxStoredFocusLossEvents+1)
	rs.expectNoSave(t, 150*time.Millisecond)
	// ...and does not use up the rows reserved for events needing review.
	send("TAB_HIDDEN", 101, maxStoredFocusLossEvents+1)
	rs.waitForSaves(t, 1)
	if got := rs.events(); len(got) != 1 || got[0] != "sess-1:TAB_HIDDEN:" {
		t.Fatalf("unexpected saved events: %v", got)
	}
}

// A second registration for the same session replaces the first: one session
// keeps exactly one live socket, so the connection gauge must count it once.
// The replacement must not increment on registration, and unregistering the
// replaced socket must be a no-op rather than decrement the replacement's
// count — otherwise the gauge drifts upward for every reconnect.
func TestRoom_ReplacedSocketKeepsAccurateGauge(t *testing.T) {
	r := newRoom("audit-exam", &fakeRoomStore{}, &fakeBuffer{}, &fakeFlusher{}, nil, "audit-instance", time.Hour, 0, nil)
	gauge := metrics.ActiveConnections.WithLabelValues("student")
	value := func() float64 { m := &dto.Metric{}; _ = gauge.Write(m); return m.GetGauge().GetValue() }
	before := value()
	defer func() { gauge.Set(before) }()
	a := NewStudentClient(nil, "u", "s", nil)
	b := NewStudentClient(nil, "u", "s", nil)
	auth := &store.ExamSessionAuth{ID: "s", Status: "IN_PROGRESS"}
	r.handleRegister(context.Background(), registration{client: a, sessionAuth: auth})
	r.handleRegister(context.Background(), registration{client: b, sessionAuth: auth})
	if got := r.students["s"]; got != b {
		t.Fatalf("students[\"s\"] = %p, want the replacement %p", got, b)
	}
	r.handleUnregister(a)
	r.handleUnregister(b)
	delta := value() - before
	t.Logf("sockets remaining=%d gauge drift=%v", len(r.students), delta)
	if len(r.students) != 0 || delta != 0 {
		t.Fatal("connection gauge drifted after replacement")
	}
}
