package store

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Uses its own schema; run with TEST_DATABASE_URL against an expendable DB.
func testPostgres(t *testing.T) (context.Context, *pgx.Conn, *pgx.Conn, *pgx.Conn) {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	t.Cleanup(cancel)
	admin, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("review_flush_%d", time.Now().UnixNano())
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
		_ = admin.Close(context.Background())
	})
	connect := func() *pgx.Conn {
		c, err := pgx.Connect(ctx, url)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := c.Exec(ctx, "SET search_path = "+schema); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = c.Close(context.Background()) })
		return c
	}
	setup, flush, submit := connect(), connect(), connect()
	_, err = setup.Exec(ctx, `CREATE TABLE "ExamSession" (id text PRIMARY KEY, status text NOT NULL DEFAULT 'IN_PROGRESS', "submittedAt" timestamp(3), "lockedAt" timestamp(3), "needsRegrade" boolean NOT NULL DEFAULT false);
 CREATE TABLE "SessionLockInterval" (id bigserial PRIMARY KEY, "sessionId" text NOT NULL REFERENCES "ExamSession"(id) ON DELETE CASCADE, "lockedAt" timestamp(3) NOT NULL, "unlockedAt" timestamp(3));
 CREATE INDEX lock_interval_lookup ON "SessionLockInterval" ("sessionId", "lockedAt", "unlockedAt");
 CREATE TABLE "Answer" (id text PRIMARY KEY, "sessionId" text REFERENCES "ExamSession"(id), "questionId" text, content jsonb, version int, "clientSeq" float8, "createdAt" timestamp(3), "updatedAt" timestamp(3), UNIQUE("sessionId", "questionId"));
 INSERT INTO "ExamSession" (id) VALUES ('s');`)
	if err != nil {
		t.Fatal(err)
	}
	return ctx, setup, flush, submit
}

func TestGetAnswerSaveStateReadsCommittedLifecycleRows(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	t.Cleanup(cancel)
	admin, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("review_answer_state_%d", time.Now().UnixNano())
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		_ = admin.Close(context.Background())
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
		_ = admin.Close(context.Background())
	})
	poolConfig, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	poolConfig.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	_, err = pool.Exec(ctx, `
		CREATE TABLE "Exam" (id text PRIMARY KEY, status text NOT NULL, "closedAt" timestamp(3));
		CREATE TABLE "ExamSession" (
			id text PRIMARY KEY, "examId" text NOT NULL, status text NOT NULL,
			"lockedAt" timestamp(3), "submittedAt" timestamp(3),
			"startedAt" timestamp(3), "effectiveEndTime" timestamp(3)
		);
		CREATE TABLE "SessionLockInterval" (
			id bigserial PRIMARY KEY, "sessionId" text NOT NULL REFERENCES "ExamSession"(id) ON DELETE CASCADE,
			"lockedAt" timestamp(3) NOT NULL, "unlockedAt" timestamp(3)
		);
		CREATE INDEX lock_interval_lookup ON "SessionLockInterval" ("sessionId", "lockedAt", "unlockedAt");
		INSERT INTO "Exam" (id, status) VALUES ('e', 'ACTIVE');
		INSERT INTO "ExamSession" (id, "examId", status) VALUES ('s', 'e', 'IN_PROGRESS');
	`)
	if err != nil {
		t.Fatal(err)
	}

	state, err := New(pool).GetAnswerSaveState(ctx, "e", "s", time.Now())
	if err != nil {
		t.Fatalf("read lifecycle state: %v", err)
	}
	if state.SessionStatus != "IN_PROGRESS" || state.ExamStatus != "ACTIVE" ||
		state.LockedAt != nil || state.SubmittedAt != nil || state.StartedAt != nil {
		t.Fatalf("unexpected lifecycle state: %+v", state)
	}
	lockedAt := time.Now().UTC().Truncate(time.Millisecond)
	lockTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := lockTx.Exec(ctx, `UPDATE "ExamSession" SET status='LOCKED', "lockedAt"=$1 WHERE id='s'`, lockedAt); err != nil {
		t.Fatal(err)
	}
	if _, err := lockTx.Exec(ctx, `INSERT INTO "SessionLockInterval" ("sessionId", "lockedAt") VALUES ('s', $1)`, lockedAt); err != nil {
		t.Fatal(err)
	}
	if err := lockTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	state, err = New(pool).GetAnswerSaveState(ctx, "e", "s", lockedAt.Add(time.Millisecond))
	if err != nil {
		t.Fatalf("read locked lifecycle state: %v", err)
	}
	if state.SessionStatus != "LOCKED" || state.LockedAt == nil || !state.LockedAt.Equal(lockedAt) {
		t.Fatalf("locked state = %+v, want lockedAt %v", state, lockedAt)
	}
	if !state.ReceivedWhileLocked {
		t.Fatal("query missed the open lock interval")
	}

	cycle1Start := lockedAt.Add(time.Minute)
	cycle1End := cycle1Start.Add(time.Minute)
	cycle2Start := cycle1End.Add(time.Minute)
	cycle2End := cycle2Start.Add(time.Minute)
	cycleTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := cycleTx.Exec(ctx, `UPDATE "ExamSession" SET status='IN_PROGRESS', "lockedAt"=NULL WHERE id='s'`); err != nil {
		t.Fatal(err)
	}
	if _, err := cycleTx.Exec(ctx, `UPDATE "SessionLockInterval" SET "unlockedAt"=$1 WHERE "sessionId"='s' AND "unlockedAt" IS NULL`, cycle1Start); err != nil {
		t.Fatal(err)
	}
	if _, err := cycleTx.Exec(ctx, `INSERT INTO "SessionLockInterval" ("sessionId", "lockedAt", "unlockedAt") VALUES ('s', $1, $2), ('s', $3, $4)`, cycle1Start, cycle1End, cycle2Start, cycle2End); err != nil {
		t.Fatal(err)
	}
	if err := cycleTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	for _, receivedAt := range []time.Time{cycle1Start.Add(time.Second), cycle2Start.Add(time.Second)} {
		state, err := New(pool).GetAnswerSaveState(ctx, "e", "s", receivedAt)
		if err != nil || !state.ReceivedWhileLocked {
			t.Fatalf("receivedAt %v: state=%+v err=%v, want locked interval", receivedAt, state, err)
		}
	}
	for _, receivedAt := range []time.Time{cycle1Start, cycle1End, cycle2End.Add(time.Second)} {
		state, err := New(pool).GetAnswerSaveState(ctx, "e", "s", receivedAt)
		if err != nil || state.ReceivedWhileLocked {
			t.Fatalf("receivedAt %v: state=%+v err=%v, want outside lock intervals", receivedAt, state, err)
		}
	}

	// Match exam-close ordering (parent Exam, then child ExamSession) while a
	// save check is blocked. The check must wait on Exam before taking a share
	// lock on the session, so close can update the child and commit without a
	// PostgreSQL deadlock.
	closeTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = closeTx.Rollback(context.Background()) }()
	if err := closeTx.QueryRow(ctx, `SELECT id FROM "Exam" WHERE id='e' FOR UPDATE`).Scan(new(string)); err != nil {
		t.Fatal(err)
	}
	type lifecycleResult struct {
		state *AnswerSaveState
		err   error
	}
	checked := make(chan lifecycleResult, 1)
	go func() {
		state, err := New(pool).GetAnswerSaveState(ctx, "e", "s", time.Now())
		checked <- lifecycleResult{state: state, err: err}
	}()
	deadline := time.Now().Add(3 * time.Second)
	for {
		var waiting int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity
			WHERE query LIKE '%SELECT id FROM "Exam" WHERE id=$1 FOR SHARE%'
			AND wait_event_type = 'Lock'`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("save-state query never waited on the parent Exam lock")
		}
		time.Sleep(time.Millisecond)
	}
	if _, err := closeTx.Exec(ctx, `UPDATE "ExamSession" SET status='AUTO_SUBMITTED', "submittedAt"=now() WHERE id='s'`); err != nil {
		t.Fatalf("close-side session update deadlocked: %v", err)
	}
	if _, err := closeTx.Exec(ctx, `UPDATE "Exam" SET status='CLOSED', "closedAt"=now() WHERE id='e'`); err != nil {
		t.Fatal(err)
	}
	if err := closeTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	result := <-checked
	if result.err != nil || result.state.ExamStatus != "CLOSED" {
		t.Fatalf("save check after close: state=%+v err=%v", result.state, result.err)
	}
}

func TestFlushAnswers_SerializesSubmissionWithInFlightWrite(t *testing.T) {
	ctx, setup, flush, submit := testPostgres(t)
	_, err := setup.Exec(ctx, `CREATE FUNCTION pause_flush() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(987654); RETURN NEW; END $$;
 CREATE TRIGGER pause BEFORE INSERT ON "Answer" FOR EACH ROW EXECUTE FUNCTION pause_flush(); SELECT pg_advisory_lock(987654);`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = setup.Exec(context.Background(), "SELECT pg_advisory_unlock(987654)") }()
	flushed := make(chan error, 1)
	go func() {
		_, err := flush.Exec(ctx, flushAnswerSQL, "a", "s", "q", `{"v":1}`, int64(1), "2026-10-05T00:00:00.000")
		flushed <- err
	}()
	waitEvent := func(pid uint32) string {
		var event string
		if err := setup.QueryRow(ctx, "SELECT COALESCE(wait_event, '') FROM pg_stat_activity WHERE pid=$1", pid).Scan(&event); err != nil {
			t.Fatal(err)
		}
		return event
	}
	for waitEvent(flush.PgConn().PID()) != "advisory" {
		select {
		case err := <-flushed:
			t.Fatalf("flush ended before pause: %v", err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(time.Millisecond):
		}
	}
	submitted := make(chan error, 1)
	go func() {
		_, err := submit.Exec(ctx, `UPDATE "ExamSession" SET status='SUBMITTED', "submittedAt"='2026-10-05T00:00:01.000' WHERE id='s'`)
		submitted <- err
	}()
	// Observe an actual lock wait instead of assuming scheduler/timing order.
	for waitEvent(submit.PgConn().PID()) != "transactionid" {
		select {
		case err := <-submitted:
			t.Fatalf("submit raced ahead of pending answer: %v", err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(time.Millisecond):
		}
	}
	if _, err := setup.Exec(ctx, "SELECT pg_advisory_unlock(987654)"); err != nil {
		t.Fatal(err)
	}
	if err := <-flushed; err != nil {
		t.Fatal(err)
	}
	if err := <-submitted; err != nil {
		t.Fatal(err)
	}
	var count int
	if err := submit.QueryRow(ctx, `SELECT count(*) FROM "Answer"`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("submission can only grade after the answer committed, got %d answers", count)
	}
}

func TestFlushAnswers_SequenceAndSubmissionGates(t *testing.T) {
	ctx, setup, flush, _ := testPostgres(t)
	save := func(seq *int64, content, received string) {
		t.Helper()
		_, err := flush.Exec(ctx, flushAnswerSQL, fmt.Sprintf("a-%d", time.Now().UnixNano()), "s", "q", content, seq, received)
		if err != nil {
			t.Fatal(err)
		}
	}
	seq := int64(200)
	save(&seq, `{"v":2}`, "2026-10-05T00:00:00.000")
	seq = 100
	save(&seq, `{"v":1}`, "2026-10-05T00:00:00.000")
	if _, err := setup.Exec(ctx, `UPDATE "ExamSession" SET status='SUBMITTED', "submittedAt"='2026-10-05T00:00:01.000' WHERE id='s'`); err != nil {
		t.Fatal(err)
	}
	seq = 300
	save(&seq, `{"v":3}`, "2026-10-05T00:00:01.001")
	var value int
	var needs bool
	if err := setup.QueryRow(ctx, `SELECT (content->>'v')::int FROM "Answer"`).Scan(&value); err != nil {
		t.Fatal(err)
	}
	if value != 2 {
		t.Fatalf("stale or post-submit answer replaced current content: %d", value)
	}
	save(&seq, `{"v":4}`, "2026-10-05T00:00:00.999")
	if err := setup.QueryRow(ctx, `SELECT "needsRegrade" FROM "ExamSession" WHERE id='s'`).Scan(&needs); err != nil {
		t.Fatal(err)
	}
	if !needs {
		t.Fatal("late pre-submit save must flag session for regrading")
	}
	save(nil, `{"v":5}`, "2026-10-05T00:00:00.999")
	seq = 250
	save(&seq, `{"v":0}`, "2026-10-05T00:00:00.999")
	if err := setup.QueryRow(ctx, `SELECT (content->>'v')::int FROM "Answer"`).Scan(&value); err != nil {
		t.Fatal(err)
	}
	if value != 5 {
		t.Fatalf("legacy save did not preserve sequence floor: %d", value)
	}
}

func TestFlushAnswers_FlagsLateAnswerAfterWaitingForSubmission(t *testing.T) {
	ctx, setup, flush, check := testPostgres(t)
	if _, err := setup.Exec(ctx, `BEGIN; UPDATE "ExamSession" SET status='SUBMITTED', "submittedAt"='2026-10-05T00:00:01.000' WHERE id='s'`); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = setup.Exec(context.Background(), "ROLLBACK") }()
	flushed := make(chan error, 1)
	go func() {
		_, err := flush.Exec(ctx, flushAnswerSQL, "a", "s", "q", `{"v":1}`, int64(1), "2026-10-05T00:00:00.999")
		flushed <- err
	}()
	for {
		var event string
		if err := check.QueryRow(ctx, "SELECT COALESCE(wait_event,'') FROM pg_stat_activity WHERE pid=$1", flush.PgConn().PID()).Scan(&event); err != nil {
			t.Fatal(err)
		}
		if event == "transactionid" {
			break
		}
		select {
		case err := <-flushed:
			t.Fatalf("flush ended before submit committed: %v", err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(time.Millisecond):
		}
	}
	if _, err := setup.Exec(ctx, "COMMIT"); err != nil {
		t.Fatal(err)
	}
	if err := <-flushed; err != nil {
		t.Fatal(err)
	}
	var needs bool
	var submittedAt time.Time
	var status string
	if err := check.QueryRow(ctx, `SELECT "needsRegrade", "submittedAt", status FROM "ExamSession" WHERE id='s'`).Scan(&needs, &submittedAt, &status); err != nil {
		t.Fatal(err)
	}
	if !needs {
		t.Fatal("late pre-submit answer must flag regrading even if statement snapshot predates submission")
	}
	if status != "SUBMITTED" {
		t.Fatalf("flush changed submission status: %s", status)
	}
	if submittedAt.UTC().Format("2006-01-02T15:04:05.000") != "2026-10-05T00:00:01.000" {
		t.Fatalf("flush changed submission timestamp: %s", submittedAt)
	}
}

// A LOCKED session must never accept a flushed answer: if the Redis
// SESSION_LOCKED pub/sub is dropped, an open socket keeps buffering saves, and
// this DB gate is the fail-closed backstop mirroring the REST answers route.
func TestFlushAnswers_DropsLockedSession(t *testing.T) {
	ctx, setup, flush, _ := testPostgres(t)
	if _, err := setup.Exec(ctx, `UPDATE "ExamSession" SET status='LOCKED' WHERE id='s'`); err != nil {
		t.Fatal(err)
	}
	seq := int64(100)
	if _, err := flush.Exec(ctx, flushAnswerSQL, "a-locked", "s", "q", `{"v":1}`, &seq, nil); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := setup.QueryRow(ctx, `SELECT count(*) FROM "Answer" WHERE "sessionId"='s'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("flusher wrote %d answer(s) to a LOCKED session; expected 0", n)
	}
	// Unlocking restores normal behavior.
	if _, err := setup.Exec(ctx, `UPDATE "ExamSession" SET status='IN_PROGRESS' WHERE id='s'`); err != nil {
		t.Fatal(err)
	}
	if _, err := flush.Exec(ctx, flushAnswerSQL, "a-ok", "s", "q", `{"v":2}`, &seq, nil); err != nil {
		t.Fatal(err)
	}
	if err := setup.QueryRow(ctx, `SELECT count(*) FROM "Answer" WHERE "sessionId"='s'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("flusher did not write to an unlocked session; got %d answers", n)
	}
}

// Acknowledged saves received BEFORE a lock must not disappear just because
// the periodic flush happens after the teacher locks the session.
func TestFlushAnswers_PreservesPreLockSave(t *testing.T) {
	ctx, setup, flush, _ := testPostgres(t)
	if _, err := setup.Exec(ctx, `INSERT INTO "SessionLockInterval" ("sessionId", "lockedAt", "unlockedAt") VALUES
		('s', '2026-10-06T00:00:01.000', '2026-10-06T00:00:02.000'),
		('s', '2026-10-06T00:00:03.000', '2026-10-06T00:00:04.000')`); err != nil {
		t.Fatal(err)
	}
	seq := int64(100)
	if _, err := flush.Exec(ctx, flushAnswerSQL, "pre-lock", "s", "q", `{"v":1}`, &seq, "2026-10-06T00:00:00.999"); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := setup.QueryRow(ctx, `SELECT count(*) FROM "Answer"`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("lost acknowledged pre-lock save: got %d rows", n)
	}
	seq = 101
	if _, err := flush.Exec(ctx, flushAnswerSQL, "post-lock-cycle-1", "s", "q", `{"v":2}`, &seq, "2026-10-06T00:00:01.001"); err != nil {
		t.Fatal(err)
	}
	seq = 102
	if _, err := flush.Exec(ctx, flushAnswerSQL, "post-lock-cycle-2", "s", "q", `{"v":3}`, &seq, "2026-10-06T00:00:03.500"); err != nil {
		t.Fatal(err)
	}
	var value int
	if err := setup.QueryRow(ctx, `SELECT (content->>'v')::int FROM "Answer"`).Scan(&value); err != nil {
		t.Fatal(err)
	}
	if value != 1 {
		t.Fatalf("save received during completed lock interval replaced pre-lock answer: got %d", value)
	}
	seq = 103
	if _, err := flush.Exec(ctx, flushAnswerSQL, "post-unlock", "s", "q", `{"v":4}`, &seq, "2026-10-06T00:00:04.001"); err != nil {
		t.Fatal(err)
	}
	if err := setup.QueryRow(ctx, `SELECT (content->>'v')::int FROM "Answer"`).Scan(&value); err != nil {
		t.Fatal(err)
	}
	if value != 4 {
		t.Fatalf("fresh post-unlock answer did not replace older value: got %d", value)
	}
}

// Lock waits update row versions, but not the statement's interval snapshot.
func TestLifecycleReadsRefreshIntervalSnapshotAfterLockWait(t *testing.T) {
	ctx, setup, _, transition := testPostgres(t)
	if _, err := setup.Exec(ctx, `CREATE TABLE "Exam" (id text PRIMARY KEY, status text, "closedAt" timestamp(3)); INSERT INTO "Exam" VALUES ('e','ACTIVE',NULL); ALTER TABLE "ExamSession" ADD COLUMN "examId" text DEFAULT 'e', ADD COLUMN "startedAt" timestamp(3), ADD COLUMN "effectiveEndTime" timestamp(3);`); err != nil {
		t.Fatal(err)
	}
	var schema string
	if err := setup.QueryRow(ctx, `SHOW search_path`).Scan(&schema); err != nil {
		t.Fatal(err)
	}
	config, err := pgxpool.ParseConfig(os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	config.ConnConfig.RuntimeParams["application_name"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	received := time.Date(2026, 10, 6, 10, 0, 5, 0, time.UTC)
	for _, operation := range []string{"check", "flush"} {
		t.Run(operation, func(t *testing.T) {
			if _, err := setup.Exec(ctx, `TRUNCATE "SessionLockInterval", "Answer"`); err != nil {
				t.Fatal(err)
			}
			tx, err := transition.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = tx.Rollback(context.Background()) }()
			// A cycle wins the session lock ahead of the waiting reader.
			if _, err := tx.Exec(ctx, `UPDATE "ExamSession" SET status='IN_PROGRESS', "lockedAt"=NULL WHERE id='s'; INSERT INTO "SessionLockInterval" ("sessionId", "lockedAt", "unlockedAt") VALUES ('s','2026-10-06 10:00:00','2026-10-06 10:00:10')`); err != nil {
				t.Fatal(err)
			}
			finished := make(chan error, 1)
			go func() {
				st := New(pool)
				if operation == "check" {
					state, err := st.GetAnswerSaveState(ctx, "e", "s", received)
					if err == nil && !state.ReceivedWhileLocked {
						err = fmt.Errorf("missed committed lock interval: %+v", state)
					}
					finished <- err
				} else {
					finished <- st.FlushAnswers(ctx, []AnswerUpsert{{SessionID: "s", QuestionID: "q", Content: []byte(`{"v":1}`), ReceivedAt: &received}})
				}
			}()
			deadline := time.Now().Add(3 * time.Second)
			for {
				var waiting bool
				if err := setup.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock')`, schema).Scan(&waiting); err != nil {
					t.Fatal(err)
				}
				if waiting {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("lifecycle reader did not wait on session lock")
				}
				time.Sleep(time.Millisecond)
			}
			if err := tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			if err := <-finished; err != nil {
				t.Fatal(err)
			}
			if operation == "flush" {
				var count int
				if err := setup.QueryRow(ctx, `SELECT count(*) FROM "Answer"`).Scan(&count); err != nil {
					t.Fatal(err)
				}
				if count != 0 {
					t.Fatal("flush accepted an answer received in the committed lock interval")
				}
			}
		})
	}
}

// Exercises both SQL snapshot paths, including their scan order, against
// persisted informational and actionable events in an isolated schema.
func TestMonitorCountsSeparatePageFocusLoss(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	admin, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("focus_counts_%d", time.Now().UnixNano())
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
		_ = admin.Close(context.Background())
	})
	config, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	_, err = pool.Exec(ctx, `
 CREATE TYPE "IntegrityEventKind" AS ENUM ('PAGE_FOCUS_LOST', 'TAB_HIDDEN');
 CREATE TABLE "User" (id text, name text, email text);
 CREATE TABLE "Exam" (id text, "timeLimitMin" int, status text, "creatorId" text, "sebRequired" bool, "sebConfigKey" text);
 CREATE TABLE "ExamSession" (
  id text, "examId" text, "userId" text, status text,
  "timeExtensionMin" int DEFAULT 0, "effectiveEndTime" timestamp,
  "sebConfigKey" text, "sebKeyHash" text, "sebUserAgent" text,
  "sebBrowserExamKey" text, "sebIntegrityFlaggedAt" timestamp,
  "sebIntegrityReason" text, "startedAt" timestamp, "submittedAt" timestamp,
  "submissionType" text, "namApplied" bool DEFAULT false,
  "lastSeenAt" timestamp, "reconnectCount" int DEFAULT 0
 );
 CREATE TABLE "Question" (id text, type text, "examId" text);
 CREATE TABLE "Answer" ("sessionId" text);
 CREATE TABLE "Grade" ("sessionId" text, points float8, "maxPoints" float8, "autoGraded" bool);
 CREATE TABLE "IntegrityEvent" (id text, "sessionId" text, kind "IntegrityEventKind", detail text, "clientTime" timestamp, "createdAt" timestamp);
 INSERT INTO "User" VALUES ('u', 'Test Student', 'test@example.invalid');
 INSERT INTO "Exam" VALUES ('e', 30, 'ACTIVE', 'teacher', true, NULL);
 INSERT INTO "ExamSession" (id, "examId", "userId", status) VALUES ('s', 'e', 'u', 'IN_PROGRESS');
 `)
	if err != nil {
		t.Fatal(err)
	}
	s := &Store{pool: pool}
	assertCounts := func(warnings, info int) {
		t.Helper()
		auth, err := s.GetExamSessionAuth(ctx, "s")
		if err != nil {
			t.Fatal(err)
		}
		rows, err := s.ListMonitorSessions(ctx, "e")
		if err != nil {
			t.Fatal(err)
		}
		if len(rows) != 1 {
			t.Fatalf("got %d monitor sessions, want 1", len(rows))
		}
		if auth.IntegrityEventCount != warnings || auth.FocusLossEventCount != info ||
			rows[0].IntegrityEventCount != warnings || rows[0].FocusLossEventCount != info {
			t.Fatalf("counts diverged: auth=%+v snapshot=%+v, want warnings=%d info=%d", auth, rows[0], warnings, info)
		}
	}
	assertCounts(0, 0)
	if err := s.SaveIntegrityEvent(ctx, "s", "PAGE_FOCUS_LOST", "", time.Now()); err != nil {
		t.Fatal(err)
	}
	assertCounts(0, 1)
	if err := s.SaveIntegrityEvent(ctx, "s", "TAB_HIDDEN", "", time.Now()); err != nil {
		t.Fatal(err)
	}
	assertCounts(1, 1)
}
