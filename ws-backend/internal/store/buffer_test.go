package store

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

var errFlush = errors.New("simulated flush failure")

func newTestRedis(t *testing.T) *redis.Client {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	t.Cleanup(mr.Close)
	return redis.NewClient(&redis.Options{Addr: mr.Addr()})
}

type fakeWriter struct {
	mu              sync.Mutex
	upserts         []AnswerUpsert
	touchedSets     [][]string
	flushAnswersErr error
	// onFlush, if set, runs at the start of FlushAnswers — i.e. after the
	// buffer has been snapshotted but before the flushed entries are
	// cleared. It lets a test inject a concurrent SaveAnswer into that exact
	// window, or inspect what Redis shows while the flush is in flight.
	onFlush func()
}

func (f *fakeWriter) FlushAnswers(ctx context.Context, answers []AnswerUpsert) error {
	if f.onFlush != nil {
		f.onFlush()
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.flushAnswersErr != nil {
		return f.flushAnswersErr
	}
	f.upserts = append(f.upserts, answers...)
	return nil
}

func (f *fakeWriter) TouchLastSeenBatch(ctx context.Context, sessionIDs []string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.touchedSets = append(f.touchedSets, sessionIDs)
	return nil
}

func TestBuffer_SaveAnswer_MarksDirty(t *testing.T) {
	ctx := context.Background()
	rdb := newTestRedis(t)
	buf := NewBuffer(rdb)

	if err := buf.SaveAnswer(ctx, "exam-1", "sess-1", "q-1", json.RawMessage(`{"type":"FREE_TEXT","text":"hi"}`), AnswerMeta{}); err != nil {
		t.Fatalf("SaveAnswer: %v", err)
	}

	members, err := rdb.SMembers(ctx, dirtyExamsSet).Result()
	if err != nil {
		t.Fatalf("SMembers: %v", err)
	}
	if len(members) != 1 || members[0] != "exam-1" {
		t.Fatalf("got dirty exams %v, want [exam-1]", members)
	}

	fields, err := rdb.HGetAll(ctx, answersHashKey("exam-1")).Result()
	if err != nil {
		t.Fatalf("HGetAll: %v", err)
	}
	if len(fields) != 1 {
		t.Fatalf("got %d fields, want 1", len(fields))
	}
}

func TestBuffer_SaveAnswer_OverwritesSameField(t *testing.T) {
	ctx := context.Background()
	rdb := newTestRedis(t)
	buf := NewBuffer(rdb)

	_ = buf.SaveAnswer(ctx, "exam-1", "sess-1", "q-1", json.RawMessage(`{"v":1}`), AnswerMeta{})
	_ = buf.SaveAnswer(ctx, "exam-1", "sess-1", "q-1", json.RawMessage(`{"v":2}`), AnswerMeta{})

	fields, err := rdb.HGetAll(ctx, answersHashKey("exam-1")).Result()
	if err != nil {
		t.Fatalf("HGetAll: %v", err)
	}
	if len(fields) != 1 {
		t.Fatalf("got %d fields, want 1 (last-write-wins on same field)", len(fields))
	}
	for _, v := range fields {
		var entry bufferEntry
		_ = json.Unmarshal([]byte(v), &entry)
		if string(entry.Content) != `{"v":2}` {
			t.Fatalf("got content %s, want latest write", entry.Content)
		}
	}
}

func TestFlusher_FlushExamNow_DrainsToStore(t *testing.T) {
	ctx := context.Background()
	rdb := newTestRedis(t)
	buf := NewBuffer(rdb)
	writer := &fakeWriter{}
	fl := NewFlusher(rdb, writer, time.Hour, nil)

	_ = buf.SaveAnswer(ctx, "exam-1", "sess-1", "q-1", json.RawMessage(`{"v":1}`), AnswerMeta{})
	_ = buf.SaveAnswer(ctx, "exam-1", "sess-2", "q-1", json.RawMessage(`{"v":2}`), AnswerMeta{})

	if err := fl.FlushExamNow(ctx, "exam-1"); err != nil {
		t.Fatalf("FlushExamNow: %v", err)
	}

	writer.mu.Lock()
	defer writer.mu.Unlock()
	if len(writer.upserts) != 2 {
		t.Fatalf("got %d upserts, want 2", len(writer.upserts))
	}

	// Buffer should be drained: no dirty marker, no leftover hash key.
	members, _ := rdb.SMembers(ctx, dirtyExamsSet).Result()
	if len(members) != 0 {
		t.Fatalf("got dirty exams %v, want none after flush", members)
	}
	exists, _ := rdb.Exists(ctx, answersHashKey("exam-1")).Result()
	if exists != 0 {
		t.Fatalf("expected answers hash to be gone after flush")
	}
}

func TestFlusher_FlushExamNow_NoBufferedAnswers_NoOp(t *testing.T) {
	ctx := context.Background()
	rdb := newTestRedis(t)
	writer := &fakeWriter{}
	fl := NewFlusher(rdb, writer, time.Hour, nil)

	if err := fl.FlushExamNow(ctx, "exam-empty"); err != nil {
		t.Fatalf("FlushExamNow on empty exam: %v", err)
	}
	writer.mu.Lock()
	defer writer.mu.Unlock()
	if len(writer.upserts) != 0 {
		t.Fatalf("expected no upserts for an exam with no buffered answers")
	}
}

func TestFlusher_Run_PeriodicFlush(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	rdb := newTestRedis(t)
	buf := NewBuffer(rdb)
	writer := &fakeWriter{}
	fl := NewFlusher(rdb, writer, 20*time.Millisecond, nil)

	_ = buf.SaveAnswer(context.Background(), "exam-1", "sess-1", "q-1", json.RawMessage(`{"v":1}`), AnswerMeta{})

	done := make(chan struct{})
	go func() {
		fl.Run(ctx)
		close(done)
	}()

	deadline := time.After(2 * time.Second)
	for {
		writer.mu.Lock()
		n := len(writer.upserts)
		writer.mu.Unlock()
		if n > 0 {
			break
		}
		select {
		case <-deadline:
			t.Fatal("timed out waiting for periodic flush")
		case <-time.After(10 * time.Millisecond):
		}
	}

	cancel()
	<-done
}

// On a flush failure the answers must still be in the live hash and the exam
// re-marked dirty, so no acked answer is lost and the next tick retries.
func TestFlusher_FlushFailure_RestoresBufferAndReDirties(t *testing.T) {
	ctx := context.Background()
	rdb := newTestRedis(t)
	buf := NewBuffer(rdb)
	writer := &fakeWriter{flushAnswersErr: errFlush}
	fl := NewFlusher(rdb, writer, time.Hour, nil)

	_ = buf.SaveAnswer(ctx, "exam-1", "sess-1", "q-1", json.RawMessage(`{"v":1}`), AnswerMeta{})

	if err := fl.FlushExamNow(ctx, "exam-1"); err == nil {
		t.Fatal("expected FlushExamNow to return the flush error")
	}

	// The answer must still be buffered and the exam back in the dirty set.
	fields, _ := rdb.HGetAll(ctx, answersHashKey("exam-1")).Result()
	if len(fields) != 1 {
		t.Fatalf("got %d buffered fields after failed flush, want 1 (restored)", len(fields))
	}
	members, _ := rdb.SMembers(ctx, dirtyExamsSet).Result()
	if len(members) != 1 || members[0] != "exam-1" {
		t.Fatalf("got dirty exams %v, want [exam-1] after failed flush", members)
	}

	// A subsequent successful flush must then persist the recovered answer.
	writer.mu.Lock()
	writer.flushAnswersErr = nil
	writer.mu.Unlock()
	if err := fl.FlushExamNow(ctx, "exam-1"); err != nil {
		t.Fatalf("retry FlushExamNow: %v", err)
	}
	writer.mu.Lock()
	defer writer.mu.Unlock()
	if len(writer.upserts) != 1 {
		t.Fatalf("got %d upserts after retry, want 1", len(writer.upserts))
	}
}

// If a client saves a newer answer for the same field during a failing flush,
// that newer acked value must win over the snapshot the flush was holding.
func TestFlusher_FlushFailure_PreservesConcurrentNewerWrite(t *testing.T) {
	ctx := context.Background()
	rdb := newTestRedis(t)
	buf := NewBuffer(rdb)
	writer := &fakeWriter{flushAnswersErr: errFlush}
	fl := NewFlusher(rdb, writer, time.Hour, nil)

	_ = buf.SaveAnswer(ctx, "exam-1", "sess-1", "q-1", json.RawMessage(`{"v":1}`), AnswerMeta{})

	// During the flush — after v1 has been snapshotted — a newer save for
	// the same field lands on the live hash.
	writer.onFlush = func() {
		_ = buf.SaveAnswer(ctx, "exam-1", "sess-1", "q-1", json.RawMessage(`{"v":2}`), AnswerMeta{})
	}

	if err := fl.FlushExamNow(ctx, "exam-1"); err == nil {
		t.Fatal("expected FlushExamNow to return the flush error")
	}

	fields, _ := rdb.HGetAll(ctx, answersHashKey("exam-1")).Result()
	if len(fields) != 1 {
		t.Fatalf("got %d fields, want 1", len(fields))
	}
	for _, v := range fields {
		var entry bufferEntry
		_ = json.Unmarshal([]byte(v), &entry)
		if string(entry.Content) != `{"v":2}` {
			t.Fatalf("got content %s after restore, want {\"v\":2} (concurrent newer write must win)", entry.Content)
		}
	}
}

// The submit path (lib/finalize-session.ts) treats "no fields for this session
// in the live hash" as "everything is in Postgres". So while FlushAnswers is
// still running, the entry must remain visible there.
func TestFlusher_EntryStaysVisibleUntilPersisted(t *testing.T) {
	ctx := context.Background()
	rdb := newTestRedis(t)
	buf := NewBuffer(rdb)
	writer := &fakeWriter{}
	fl := NewFlusher(rdb, writer, time.Hour, nil)

	_ = buf.SaveAnswer(ctx, "exam-1", "sess-1", "q-1", json.RawMessage(`{"v":1}`), AnswerMeta{})

	var visibleDuringFlush []string
	writer.onFlush = func() {
		visibleDuringFlush, _ = rdb.HKeys(ctx, answersHashKey("exam-1")).Result()
	}
	if err := fl.FlushExamNow(ctx, "exam-1"); err != nil {
		t.Fatalf("FlushExamNow: %v", err)
	}

	if len(visibleDuringFlush) != 1 || visibleDuringFlush[0] != "sess-1:q-1" {
		t.Fatalf("live hash during flush = %v, want [sess-1:q-1]", visibleDuringFlush)
	}
	remaining, _ := rdb.HKeys(ctx, answersHashKey("exam-1")).Result()
	if len(remaining) != 0 {
		t.Fatalf("live hash after flush = %v, want empty", remaining)
	}
}

// A newer save landing while a successful flush is in flight must not be
// deleted with the entry the flush persisted, and must leave the exam dirty
// so the next tick writes it.
func TestFlusher_Success_KeepsConcurrentNewerWrite(t *testing.T) {
	ctx := context.Background()
	rdb := newTestRedis(t)
	buf := NewBuffer(rdb)
	writer := &fakeWriter{}
	fl := NewFlusher(rdb, writer, time.Hour, nil)

	_ = buf.SaveAnswer(ctx, "exam-1", "sess-1", "q-1", json.RawMessage(`{"v":1}`), AnswerMeta{})
	writer.onFlush = func() {
		_ = buf.SaveAnswer(ctx, "exam-1", "sess-1", "q-1", json.RawMessage(`{"v":2}`), AnswerMeta{})
	}
	if err := fl.FlushExamNow(ctx, "exam-1"); err != nil {
		t.Fatalf("FlushExamNow: %v", err)
	}

	fields, _ := rdb.HGetAll(ctx, answersHashKey("exam-1")).Result()
	if len(fields) != 1 {
		t.Fatalf("got %d buffered fields, want 1 (the newer save)", len(fields))
	}
	for _, v := range fields {
		var entry bufferEntry
		_ = json.Unmarshal([]byte(v), &entry)
		if string(entry.Content) != `{"v":2}` {
			t.Fatalf("buffered content = %s, want {\"v\":2}", entry.Content)
		}
	}
	members, _ := rdb.SMembers(ctx, dirtyExamsSet).Result()
	if len(members) != 1 || members[0] != "exam-1" {
		t.Fatalf("dirty exams = %v, want [exam-1]", members)
	}

	writer.onFlush = nil
	if err := fl.FlushExamNow(ctx, "exam-1"); err != nil {
		t.Fatalf("second FlushExamNow: %v", err)
	}
	writer.mu.Lock()
	defer writer.mu.Unlock()
	if len(writer.upserts) != 2 || string(writer.upserts[1].Content) != `{"v":2}` {
		t.Fatalf("upserts = %+v, want v1 then v2", writer.upserts)
	}
}

// The client sequence number and receive time are what the flush SQL orders
// and gates on, so they must survive the round trip through Redis.
func TestFlusher_CarriesAnswerMeta(t *testing.T) {
	ctx := context.Background()
	rdb := newTestRedis(t)
	buf := NewBuffer(rdb)
	writer := &fakeWriter{}
	fl := NewFlusher(rdb, writer, time.Hour, nil)

	seq := int64(1_790_000_000_123)
	received := time.Date(2026, 10, 3, 12, 0, 0, 456_789_000, time.UTC)
	_ = buf.SaveAnswer(ctx, "exam-1", "sess-1", "q-1", json.RawMessage(`{"v":1}`), AnswerMeta{ClientSeq: &seq, ReceivedAt: received})
	_ = buf.SaveAnswer(ctx, "exam-1", "sess-2", "q-1", json.RawMessage(`{"v":1}`), AnswerMeta{})

	if err := fl.FlushExamNow(ctx, "exam-1"); err != nil {
		t.Fatalf("FlushExamNow: %v", err)
	}
	writer.mu.Lock()
	defer writer.mu.Unlock()
	bySession := map[string]AnswerUpsert{}
	for _, u := range writer.upserts {
		bySession[u.SessionID] = u
	}
	withMeta := bySession["sess-1"]
	if withMeta.ClientSeq == nil || *withMeta.ClientSeq != seq {
		t.Fatalf("ClientSeq = %v, want %d", withMeta.ClientSeq, seq)
	}
	if withMeta.ReceivedAt == nil || !withMeta.ReceivedAt.Equal(received) {
		t.Fatalf("ReceivedAt = %v, want %v", withMeta.ReceivedAt, received)
	}
	legacy := bySession["sess-2"]
	if legacy.ClientSeq != nil || legacy.ReceivedAt != nil {
		t.Fatalf("meta-less save got ClientSeq=%v ReceivedAt=%v, want both nil", legacy.ClientSeq, legacy.ReceivedAt)
	}
}

func TestPgTimestamp_UTCMillis(t *testing.T) {
	berlin := time.FixedZone("CEST", 2*60*60)
	in := time.Date(2026, 10, 3, 14, 0, 0, 456_789_000, berlin)
	got := pgTimestamp(&in)
	if got == nil || *got != "2026-10-03T12:00:00.456" {
		t.Fatalf("pgTimestamp = %v, want 2026-10-03T12:00:00.456", got)
	}
	if pgTimestamp(nil) != nil {
		t.Fatal("pgTimestamp(nil) should be nil")
	}
}

// A stale frame must not erase a newer acked value before either reaches SQL.
func TestBuffer_SaveAnswer_PreservesHigherSequenceBeforeFlush(t *testing.T) {
	ctx := context.Background()
	rdb := newTestRedis(t)
	buf := NewBuffer(rdb)
	newer, older := int64(200), int64(100)
	for _, save := range []struct {
		content string
		seq     *int64
	}{
		{`{"v":2}`, &newer}, {`{"v":1}`, &older}, {`{"v":0}`, &newer},
	} {
		if err := buf.SaveAnswer(ctx, "exam-1", "sess-1", "q-1", json.RawMessage(save.content), AnswerMeta{ClientSeq: save.seq, ReceivedAt: time.Now()}); err != nil {
			t.Fatal(err)
		}
	}
	writer := &fakeWriter{}
	fl := NewFlusher(rdb, writer, time.Hour, nil)
	if err := fl.FlushExamNow(ctx, "exam-1"); err != nil {
		t.Fatal(err)
	}
	if len(writer.upserts) != 1 || string(writer.upserts[0].Content) != `{"v":2}` {
		t.Fatalf("flushed %#v, want newer answer", writer.upserts)
	}
}

func TestBuffer_SaveAnswer_ConcurrentSequenceOrder(t *testing.T) {
	ctx := context.Background()
	rdb := newTestRedis(t)
	buf := NewBuffer(rdb)
	var wg sync.WaitGroup
	for seq := int64(1); seq <= 100; seq++ {
		wg.Add(1)
		go func(seq int64) {
			defer wg.Done()
			if err := buf.SaveAnswer(ctx, "exam", "session", "q", json.RawMessage(`{"selectedOptionIds":[]}`), AnswerMeta{ClientSeq: &seq}); err != nil {
				t.Error(err)
			}
		}(seq)
	}
	wg.Wait()
	raw, err := rdb.HGet(ctx, answersHashKey("exam"), fieldKey("session", "q")).Result()
	if err != nil {
		t.Fatal(err)
	}
	var entry bufferEntry
	if err := json.Unmarshal([]byte(raw), &entry); err != nil {
		t.Fatal(err)
	}
	if entry.ClientSeq == nil || *entry.ClientSeq != 100 {
		t.Fatalf("got %s, want sequence 100", raw)
	}
}

func TestBuffer_SaveAnswer_LegacyWriteRetainsSequenceFloorAndArrays(t *testing.T) {
	ctx := context.Background()
	rdb := newTestRedis(t)
	buf := NewBuffer(rdb)
	seq := int64(9007199254740991)
	if err := buf.SaveAnswer(ctx, "exam", "session", "q", json.RawMessage(`{"v":1}`), AnswerMeta{ClientSeq: &seq}); err != nil {
		t.Fatal(err)
	}
	legacy := json.RawMessage(`{"type":"MULTIPLE_CHOICE","selectedOptionIds":[]}`)
	if err := buf.SaveAnswer(ctx, "exam", "session", "q", legacy, AnswerMeta{}); err != nil {
		t.Fatal(err)
	}
	seq--
	if err := buf.SaveAnswer(ctx, "exam", "session", "q", json.RawMessage(`{"v":0}`), AnswerMeta{ClientSeq: &seq}); err != nil {
		t.Fatal(err)
	}
	raw, err := rdb.HGet(ctx, answersHashKey("exam"), fieldKey("session", "q")).Result()
	if err != nil {
		t.Fatal(err)
	}
	var entry struct {
		bufferEntry
		OrderFloor *int64 `json:"orderFloor"`
	}
	if err := json.Unmarshal([]byte(raw), &entry); err != nil {
		t.Fatal(err)
	}
	if string(entry.Content) != string(legacy) || entry.ClientSeq != nil || entry.OrderFloor == nil || *entry.OrderFloor != 9007199254740991 {
		t.Fatalf("got %s, want legacy content, nil SQL sequence, and Redis-only ordering floor", raw)
	}
}

func TestBuffer_SaveAnswer_ReplacesMalformedEntry(t *testing.T) {
	for _, raw := range []string{"not-json", "true"} {
		t.Run(raw, func(t *testing.T) {
			ctx := context.Background()
			rdb := newTestRedis(t)
			if err := rdb.HSet(ctx, answersHashKey("exam"), fieldKey("session", "q"), raw).Err(); err != nil {
				t.Fatal(err)
			}
			seq := int64(1)
			if err := NewBuffer(rdb).SaveAnswer(ctx, "exam", "session", "q", json.RawMessage(`{"v":1}`), AnswerMeta{ClientSeq: &seq}); err != nil {
				t.Fatal(err)
			}
		})
	}
}

// A second flush of the same exam while one is in flight (every
// SESSION_SUBMITTED of a mass submission starts one) must not resend the
// batch the first flush is already writing. It returns at once, the exam
// stays dirty for anything newer, and the lock is free again afterwards.
func TestFlusher_ConcurrentFlushOfSameExam_SnapshotsOnce(t *testing.T) {
	ctx := context.Background()
	rdb := newTestRedis(t)
	buf := NewBuffer(rdb)
	writer := &fakeWriter{}
	fl := NewFlusher(rdb, writer, time.Hour, nil)

	_ = buf.SaveAnswer(ctx, "exam-1", "sess-1", "q-1", json.RawMessage(`{"v":1}`), AnswerMeta{})

	calls := 0
	writer.onFlush = func() {
		calls++
		if calls > 1 {
			return
		}
		_ = buf.SaveAnswer(ctx, "exam-1", "sess-2", "q-1", json.RawMessage(`{"v":2}`), AnswerMeta{})
		if err := fl.FlushExamNow(ctx, "exam-1"); err != nil {
			t.Errorf("concurrent FlushExamNow: %v", err)
		}
	}
	if err := fl.FlushExamNow(ctx, "exam-1"); err != nil {
		t.Fatalf("FlushExamNow: %v", err)
	}

	if calls != 1 || len(writer.upserts) != 1 || writer.upserts[0].SessionID != "sess-1" {
		t.Fatalf("FlushAnswers calls = %d, upserts = %+v; want one call with sess-1 only", calls, writer.upserts)
	}
	if dirty, _ := rdb.SIsMember(ctx, dirtyExamsSet, "exam-1").Result(); !dirty {
		t.Fatal("exam not dirty after a save during the in-flight flush")
	}
	if held, _ := rdb.Exists(ctx, flushLockKey("exam-1")).Result(); held != 0 {
		t.Fatal("flush lock still held after the flush returned")
	}

	writer.onFlush = nil
	if err := fl.FlushExamNow(ctx, "exam-1"); err != nil {
		t.Fatalf("follow-up FlushExamNow: %v", err)
	}
	if len(writer.upserts) != 2 || writer.upserts[1].SessionID != "sess-2" {
		t.Fatalf("upserts after follow-up = %+v, want sess-2 flushed second", writer.upserts)
	}
}

// A worker interrupted before its SQL write must not strand the acked answer:
// dirty membership survives the snapshot and only clears once the flush has
// committed and cleaned up, so a later worker's tick rediscovers the hash.
func TestFlusher_InterruptedWriteIsDiscoveredByNextWorker(t *testing.T) {
	ctx := context.Background()
	rdb := newTestRedis(t)
	if err := NewBuffer(rdb).SaveAnswer(ctx, "audit-exam", "s", "q", json.RawMessage(`{"type":"FREE_TEXT","text":"answer"}`), AnswerMeta{}); err != nil {
		t.Fatal(err)
	}
	writer := &fakeWriter{onFlush: func() { panic("simulated process interruption before SQL write") }}
	func() {
		defer func() {
			if recover() == nil {
				t.Error("expected crash boundary")
			}
		}()
		_ = NewFlusher(rdb, writer, time.Second, nil).FlushExamNow(ctx, "audit-exam")
	}()
	next := &fakeWriter{}
	NewFlusher(rdb, next, time.Second, nil).flushAll(ctx)
	remaining, err := rdb.HLen(ctx, answersHashKey("audit-exam")).Result()
	if err != nil {
		t.Fatal(err)
	}
	dirty, _ := rdb.SMembers(ctx, dirtyExamsSet).Result()
	t.Logf("after simulated crash + new flusher tick: pending fields=%d dirty=%v SQL writes=%d", remaining, dirty, len(next.upserts))
	if remaining != 0 || len(dirty) != 0 || len(next.upserts) != 1 {
		t.Fatal("new flusher did not recover the interrupted answer")
	}
}

// crashAfterCommitWriter persists the batch and then dies before the
// flusher's cleanup step. Wrapping the fake writer keeps the production
// store's write semantics untouched; the crash is the test's hook.
type crashAfterCommitWriter struct {
	inner *fakeWriter
}

func (w *crashAfterCommitWriter) FlushAnswers(ctx context.Context, answers []AnswerUpsert) error {
	if err := w.inner.FlushAnswers(ctx, answers); err != nil {
		return err
	}
	panic("simulated crash after SQL commit, before buffer cleanup")
}

func (w *crashAfterCommitWriter) TouchLastSeenBatch(ctx context.Context, sessionIDs []string) error {
	return w.inner.TouchLastSeenBatch(ctx, sessionIDs)
}

// A worker that commits the batch and then dies before cleanup must not
// strand the entries: dirty membership stays until cleanup completes, so the
// next worker's tick rediscovers the hash and re-upserts it. The duplicate
// upsert is harmless — sequenced writes are gated on clientSeq — and both
// the hash and the dirty set drain.
func TestFlusher_CrashAfterCommitBeforeCleanup_NoStrandedAnswer(t *testing.T) {
	ctx := context.Background()
	rdb := newTestRedis(t)
	if err := NewBuffer(rdb).SaveAnswer(ctx, "audit-exam", "s", "q", json.RawMessage(`{"type":"FREE_TEXT","text":"answer"}`), AnswerMeta{}); err != nil {
		t.Fatal(err)
	}

	committed := &fakeWriter{}
	func() {
		defer func() {
			if recover() == nil {
				t.Error("expected crash boundary")
			}
		}()
		_ = NewFlusher(rdb, &crashAfterCommitWriter{inner: committed}, time.Second, nil).FlushExamNow(ctx, "audit-exam")
	}()

	// The batch reached the store, so it must never be lost; the live hash is
	// still the submit drain's source of truth until cleanup runs.
	if len(committed.upserts) != 1 {
		t.Fatalf("committed upserts = %d, want 1", len(committed.upserts))
	}
	if remaining, _ := rdb.HLen(ctx, answersHashKey("audit-exam")).Result(); remaining != 1 {
		t.Fatalf("buffered fields after crash = %d, want 1", remaining)
	}

	// A fresh worker tick must recover the exam through the surviving dirty
	// membership, re-persist the batch, and drain both keys.
	next := &fakeWriter{}
	NewFlusher(rdb, next, time.Second, nil).flushAll(ctx)

	if remaining, _ := rdb.HLen(ctx, answersHashKey("audit-exam")).Result(); remaining != 0 {
		t.Fatalf("pending fields after the next tick = %d, want 0 (answer stranded)", remaining)
	}
	if dirty, _ := rdb.SMembers(ctx, dirtyExamsSet).Result(); len(dirty) != 0 {
		t.Fatalf("dirty exams after the next tick = %v, want none", dirty)
	}
	if len(next.upserts) != 1 || string(next.upserts[0].Content) != `{"type":"FREE_TEXT","text":"answer"}` {
		t.Fatalf("next tick upserts = %+v, want the recovered duplicate", next.upserts)
	}
}

// The flush lock is TTL-only: if its holder dies, the lock lapses on its own
// and a successor flush must still persist the buffered answer rather than
// short-circuiting forever. A stalled flush may delay persistence, but the
// entries and dirty membership survive, so nothing is stranded.
func TestFlusher_AbandonedLockLapsesAndSuccessorFlushes(t *testing.T) {
	ctx := context.Background()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	if err := NewBuffer(rdb).SaveAnswer(ctx, "audit-exam", "s", "q", json.RawMessage(`{"type":"FREE_TEXT","text":"answer"}`), AnswerMeta{}); err != nil {
		t.Fatal(err)
	}

	// A worker died holding the lock; only the TTL releases it.
	if err := rdb.Set(ctx, flushLockKey("audit-exam"), "dead-worker-token", flushLockTTL).Err(); err != nil {
		t.Fatal(err)
	}
	blocked := &fakeWriter{}
	if err := NewFlusher(rdb, blocked, time.Hour, nil).FlushExamNow(ctx, "audit-exam"); err != nil {
		t.Fatalf("flush against the dead lock: %v", err)
	}
	if len(blocked.upserts) != 0 {
		t.Fatalf("blocked flush wrote %d upserts, want 0", len(blocked.upserts))
	}
	if remaining, _ := rdb.HLen(ctx, answersHashKey("audit-exam")).Result(); remaining != 1 {
		t.Fatalf("buffered fields while the dead lock holds = %d, want 1", remaining)
	}

	mr.FastForward(flushLockTTL + time.Second)

	next := &fakeWriter{}
	if err := NewFlusher(rdb, next, time.Hour, nil).FlushExamNow(ctx, "audit-exam"); err != nil {
		t.Fatalf("successor flush after TTL lapse: %v", err)
	}
	if len(next.upserts) != 1 || next.upserts[0].SessionID != "s" {
		t.Fatalf("successor upserts = %+v, want the recovered answer", next.upserts)
	}
	if remaining, _ := rdb.HLen(ctx, answersHashKey("audit-exam")).Result(); remaining != 0 {
		t.Fatalf("pending fields after the successor flush = %d, want 0", remaining)
	}
	if held, _ := rdb.Exists(ctx, flushLockKey("audit-exam")).Result(); held != 0 {
		t.Fatal("flush lock still held after the successor flush returned")
	}
}
