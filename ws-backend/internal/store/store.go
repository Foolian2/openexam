// Package store centralizes raw SQL against the Prisma-managed schema. Keep
// all hand-written SQL here so drift from prisma/schema.prisma stays visible
// in one place. Table names follow Prisma's defaults: models without an
// explicit @@map use their PascalCase model name (quoted), so "User",
// "Exam", "ExamSession", "Answer", "Question" are quoted identifiers, while
// better-auth's own tables are lowercase via @@map ("session").
package store

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/lucsky/cuid"

	"openexam/ws-backend/internal/auth"
)

var ErrNotFound = errors.New("store: not found")

type Store struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

// LookupSession implements auth.Store: it resolves a raw session token to
// the owning user's id and role, ignoring the "session_data" cookie cache.
func (s *Store) LookupSession(ctx context.Context, token string) (userID, role string, expiresAt time.Time, err error) {
	row := s.pool.QueryRow(ctx, `
		SELECT u.id, u.role, sess."expiresAt"
		FROM "session" sess
		JOIN "User" u ON u.id = sess."userId"
		WHERE sess.token = $1
	`, token)

	err = row.Scan(&userID, &role, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", time.Time{}, ErrNotFound
	}
	if err != nil {
		return "", "", time.Time{}, err
	}
	return userID, role, expiresAt, nil
}

var _ auth.Store = (*Store)(nil)
var _ AnswerWriter = (*Store)(nil)

// ExamSessionAuth is the subset of ExamSession + Exam fields needed to
// authorize a WS connection and drive room state.
type ExamSessionAuth struct {
	ID                    string
	ExamID                string
	UserID                string
	Status                string
	TimeLimitMin          int
	TimeExtensionMin      int
	EffectiveEndTime      *time.Time
	ExamStatus            string
	ExamCreatorID         string
	SebRequired           bool
	SebConfigKey          *string
	SebKeyHash            *string
	SebUserAgent          *string
	SebBrowserExamKey     *string
	SebIntegrityFlaggedAt *time.Time

	// SessionSebConfigKey is the Config Key of the personalized config issued
	// to this session, whose startURL embeds a one-time login token (see
	// app/exam/[id]/seb-enter/route.ts). Nil when the session only ever used
	// the anonymous config, in which case SebConfigKey — the frozen
	// exam-level key — is the only candidate. Mirrors lib/seb-guard.ts, which
	// accepts a token matching either.
	SessionSebConfigKey *string

	// IntegrityEventCount excludes informational PAGE_FOCUS_LOST;
	// FocusLossEventCount counts those separately. Both count already-persisted
	// events for this session. Read at registration so the room's in-memory
	// counter survives reconnects and room restarts instead of starting
	// over at zero (which made the teacher-visible badge jump backwards).
	IntegrityEventCount int
	FocusLossEventCount int
	Questions           []QuestionAuth
}

// QuestionAuth is the minimum question data needed to validate a WS answer.
// Keeping it on the connection auth record means a student cannot write an
// answer for another exam's question without a database query per keystroke.
type QuestionAuth struct {
	ID   string
	Type string
}

func (s *Store) GetExamSessionAuth(ctx context.Context, sessionID string) (*ExamSessionAuth, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT es.id, es."examId", es."userId", es.status,
		       e."timeLimitMin", es."timeExtensionMin", es."effectiveEndTime",
		       e.status, e."creatorId", e."sebRequired", e."sebConfigKey",
		       es."sebConfigKey",
		       es."sebKeyHash", es."sebUserAgent",
		       es."sebBrowserExamKey", es."sebIntegrityFlaggedAt",
		       (SELECT count(*) FROM "IntegrityEvent" ie WHERE ie."sessionId" = es.id AND ie.kind <> 'PAGE_FOCUS_LOST'),
		       (SELECT count(*) FROM "IntegrityEvent" ie WHERE ie."sessionId" = es.id AND ie.kind = 'PAGE_FOCUS_LOST')
		FROM "ExamSession" es
		JOIN "Exam" e ON e.id = es."examId"
		WHERE es.id = $1
	`, sessionID)

	var out ExamSessionAuth
	err := row.Scan(&out.ID, &out.ExamID, &out.UserID, &out.Status,
		&out.TimeLimitMin, &out.TimeExtensionMin, &out.EffectiveEndTime,
		&out.ExamStatus, &out.ExamCreatorID, &out.SebRequired, &out.SebConfigKey,
		&out.SessionSebConfigKey,
		&out.SebKeyHash, &out.SebUserAgent,
		&out.SebBrowserExamKey, &out.SebIntegrityFlaggedAt, &out.IntegrityEventCount, &out.FocusLossEventCount)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}

	rows, err := s.pool.Query(ctx, `SELECT id, type FROM "Question" WHERE "examId" = $1`, out.ExamID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var question QuestionAuth
		if err := rows.Scan(&question.ID, &question.Type); err != nil {
			return nil, err
		}
		out.Questions = append(out.Questions, question)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	return &out, nil
}

// AnswerSaveState is the authoritative lifecycle state used before the WS
// backend acknowledges a buffered answer. Unlike room state and Redis pub/sub,
// this reflects the current committed session and exam rows.
type AnswerSaveState struct {
	SessionStatus       string
	ExamStatus          string
	LockedAt            *time.Time
	SubmittedAt         *time.Time
	StartedAt           *time.Time
	EffectiveEndTime    *time.Time
	ExamClosedAt        *time.Time
	ReceivedWhileLocked bool
}

// GetAnswerSaveState takes locks in parent-Exam then ExamSession order, the
// same order as close and lock transitions. A concurrent lifecycle update
// therefore serializes with this check; the receive timestamp is also tested
// against durable intervals so a delayed check sees completed lock cycles.
//
// The whole transaction goes to Postgres as one pgx batch (one round trip
// instead of five: BEGIN, two locks, the read, COMMIT) and commits with
// synchronous_commit off. The transaction writes nothing durable — FOR SHARE
// only stamps row locks, which do not outlive a crash — so waiting for the WAL
// flush at COMMIT bought no durability and capped the answer-ack rate under
// load (2026-10-13 benchmark: ~2.8k acks/s plateau, ack latency dominated by
// this check). Statement order and lock order are unchanged.
func (s *Store) GetAnswerSaveState(ctx context.Context, examID, sessionID string, receivedAt time.Time) (*AnswerSaveState, error) {
	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	// A batch that fails midway leaves the transaction aborted; pgxpool
	// destroys a connection released with a non-idle transaction status, so
	// no explicit ROLLBACK is needed.
	defer conn.Release()

	receivedAtValue := pgTimestamp(&receivedAt)
	batch := &pgx.Batch{}
	batch.Queue("BEGIN")
	batch.Queue("SET LOCAL synchronous_commit = off")
	// Row-lock waits can see newer row versions without refreshing a
	// statement's snapshot of SessionLockInterval. Acquire both locks first,
	// then read lifecycle and intervals in a new READ COMMITTED statement.
	batch.Queue(`SELECT id FROM "Exam" WHERE id=$1 FOR SHARE`, examID)
	batch.Queue(`SELECT id FROM "ExamSession" WHERE id=$1 AND "examId"=$2 FOR SHARE`, sessionID, examID)
	batch.Queue(`
		SELECT es.status, e.status, es."lockedAt", es."submittedAt",
		       es."startedAt", es."effectiveEndTime", e."closedAt",
		       EXISTS (
		         SELECT 1 FROM "SessionLockInterval" sli
		         WHERE sli."sessionId" = es.id
		           AND ($3::text IS NULL OR (
		             $3::text::timestamp > sli."lockedAt"
		             AND (sli."unlockedAt" IS NULL OR $3::text::timestamp < sli."unlockedAt")
		           ))
	       ) AS received_while_locked
		FROM "Exam" e
		JOIN "ExamSession" es ON es."examId" = e.id
		WHERE e.id = $1 AND es.id = $2
	`, examID, sessionID, receivedAtValue)
	batch.Queue("COMMIT")

	br := conn.SendBatch(ctx, batch)
	defer func() { _ = br.Close() }()

	for i := 0; i < 2; i++ { // BEGIN, SET LOCAL
		if _, err := br.Exec(); err != nil {
			return nil, err
		}
	}
	var lockedID string
	var missing bool
	for i := 0; i < 2; i++ { // Exam lock, ExamSession lock
		err := br.QueryRow().Scan(&lockedID)
		if errors.Is(err, pgx.ErrNoRows) {
			missing = true
			continue
		}
		if err != nil {
			return nil, err
		}
	}
	var out AnswerSaveState
	scanErr := br.QueryRow().Scan(&out.SessionStatus, &out.ExamStatus, &out.LockedAt,
		&out.SubmittedAt, &out.StartedAt, &out.EffectiveEndTime, &out.ExamClosedAt,
		&out.ReceivedWhileLocked)
	if _, err := br.Exec(); err != nil { // COMMIT
		return nil, err
	}
	if missing || errors.Is(scanErr, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if scanErr != nil {
		return nil, scanErr
	}
	return &out, nil
}

// BindSebSession persists the first-seen SEB Config Key token and
// User-Agent for a session, mirroring lib/seb-guard.ts's binding on the
// Next.js side. Called once, when SebKeyHash is still unset. The WHERE
// clause makes the bind set-once: verifySebWsAccess reads the row before
// this write lands, so two near-simultaneous handshakes can both decide to
// bind, and without the guard the second write would silently clobber the
// first-bound token/UA that this tripwire depends on. The returned bool
// tells the caller whether this call actually won the bind, so a lost race
// can be re-validated instead of admitted unconditionally.
func (s *Store) BindSebSession(ctx context.Context, sessionID, keyHash, userAgent string) (bool, error) {
	tag, err := s.pool.Exec(ctx,
		`UPDATE "ExamSession" SET "sebKeyHash" = $2, "sebUserAgent" = $3 WHERE id = $1 AND "sebKeyHash" IS NULL`,
		sessionID, keyHash, userAgent)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// GetSebBinding re-reads the SEB Config Key token/User-Agent bound to a
// session. Used after BindSebSession reports it lost the first-bind race, to
// validate the losing request's own token/UA against whatever the winning
// request actually bound.
func (s *Store) GetSebBinding(ctx context.Context, sessionID string) (keyHash, userAgent *string, err error) {
	row := s.pool.QueryRow(ctx,
		`SELECT "sebKeyHash", "sebUserAgent" FROM "ExamSession" WHERE id = $1`, sessionID)
	err = row.Scan(&keyHash, &userAgent)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, ErrNotFound
	}
	return keyHash, userAgent, err
}

// AuditLogParams mirrors the fields lib/audit.ts's createAuditLog accepts on
// the Next.js side, so a denial logged from either transport lands in the
// same AuditLog table with the same shape.
type AuditLogParams struct {
	Action     string
	EntityType string
	EntityID   string
	UserID     *string
	ExamID     *string
	Metadata   map[string]any
	IPAddress  *string
	UserAgent  *string
}

// CreateAuditLog inserts an AuditLog row. Best-effort by convention: callers
// log and continue on error rather than let an audit-trail write turn into a
// WS handshake failure on top of the denial it's recording.
func (s *Store) CreateAuditLog(ctx context.Context, p AuditLogParams) error {
	var metadataJSON []byte
	if p.Metadata != nil {
		var err error
		metadataJSON, err = json.Marshal(p.Metadata)
		if err != nil {
			return err
		}
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO "AuditLog" (id, action, "entityType", "entityId", "userId", "examId", metadata, "ipAddress", "userAgent", timestamp)
		VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, now())
	`, cuid.New(), p.Action, p.EntityType, p.EntityID, p.UserID, p.ExamID, metadataJSON, p.IPAddress, p.UserAgent)
	return err
}

// BindSebBrowserExamKey records the first-seen Browser Exam Key for a session.
// Trust-on-first-use, mirroring attestBrowserExamKey in lib/seb-guard.ts: the
// value is only ever bound and compared, never used to reject. The WHERE
// clause makes the bind set-once: sebIntegrityDecision reads the row before
// this write lands, so two near-simultaneous handshakes can both decide to
// bind, and without the guard the second write would silently clobber the
// first-bound key that change detection depends on.
func (s *Store) BindSebBrowserExamKey(ctx context.Context, sessionID, bek string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE "ExamSession" SET "sebBrowserExamKey" = $2
		 WHERE id = $1 AND ("sebBrowserExamKey" IS NULL OR "sebBrowserExamKey" = '')`,
		sessionID, bek)
	return err
}

// FlagSebIntegrity records that a session's Browser Exam Key changed or
// stopped arriving mid-exam. The WHERE clause makes it set-once, so a client
// that stays switched away doesn't rewrite the row on every reconnect. The
// returned bool distinguishes "this call set the flag" from "someone else
// already had", which is what tells the caller whether it's the one that
// should notify the live monitor.
func (s *Store) FlagSebIntegrity(ctx context.Context, sessionID, reason string) (bool, error) {
	tag, err := s.pool.Exec(ctx,
		`UPDATE "ExamSession" SET "sebIntegrityFlaggedAt" = now(), "sebIntegrityReason" = $2
		 WHERE id = $1 AND "sebIntegrityFlaggedAt" IS NULL`,
		sessionID, reason)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// ExamAuth is the subset of Exam fields needed to authorize a monitor
// connection (teacher watching all sessions of one exam).
type ExamAuth struct {
	ID        string
	CreatorID string
	Status    string
}

func (s *Store) GetExamAuth(ctx context.Context, examID string) (*ExamAuth, error) {
	row := s.pool.QueryRow(ctx, `SELECT id, "creatorId", status FROM "Exam" WHERE id = $1`, examID)
	var out ExamAuth
	err := row.Scan(&out.ID, &out.CreatorID, &out.Status)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// IncrementReconnectCount is called when a student's WS connection connects
// or replaces an existing one for the same session (browser refresh, network
// blip). It also bumps lastSeenAt in the same round trip, so a connected
// student who never writes an answer still shows as recently active on the
// monitor instead of wearing a stale timestamp from their last answer flush.
func (s *Store) IncrementReconnectCount(ctx context.Context, sessionID string) error {
	_, err := s.pool.Exec(ctx, `UPDATE "ExamSession" SET "lastSeenAt" = now(), "reconnectCount" = "reconnectCount" + 1 WHERE id = $1`, sessionID)
	return err
}

// MonitorStudent mirrors the nested `student` object in the REST monitor
// response (GET /api/exams/[id]/sessions).
type MonitorStudent struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

// MonitorSession mirrors the shape returned by GET /api/exams/[id]/sessions
// so the frontend can apply WS snapshots/deltas with the same types.
type MonitorSession struct {
	ID                  string         `json:"id"`
	Student             MonitorStudent `json:"student"`
	Status              string         `json:"status"`
	StartedAt           *time.Time     `json:"startedAt"`
	SubmittedAt         *time.Time     `json:"submittedAt"`
	SubmissionType      *string        `json:"submissionType"`
	EffectiveEndTime    *time.Time     `json:"effectiveEndTime"`
	TimeExtensionMin    int            `json:"timeExtensionMin"`
	NamApplied          bool           `json:"namApplied"`
	LastSeenAt          *time.Time     `json:"lastSeenAt"`
	ReconnectCount      int            `json:"reconnectCount"`
	AnswerCount         int            `json:"answerCount"`
	GradedCount         int            `json:"gradedCount"`
	ManuallyGradedCount int            `json:"manuallyGradedCount"`
	TotalPoints         float64        `json:"totalPoints"`
	MaxPoints           float64        `json:"maxPoints"`
	FocusLossEventCount int            `json:"focusLossEventCount"`
	IntegrityEventCount int            `json:"integrityEventCount"`
	// Mirrors the live delta key published by lib/seb-guard.ts, so a monitor
	// connecting after the event sees the same flag the live patch carried.
	SebIntegrityFlagged bool    `json:"sebIntegrityFlagged"`
	SebIntegrityReason  *string `json:"sebIntegrityReason"`
}

func (s *Store) ListMonitorSessions(ctx context.Context, examID string) ([]MonitorSession, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT
			es.id, u.id, u.name, u.email, es.status,
			es."startedAt", es."submittedAt", es."submissionType",
			es."effectiveEndTime", es."timeExtensionMin", es."namApplied", es."lastSeenAt", es."reconnectCount",
			(SELECT count(*) FROM "Answer" a WHERE a."sessionId" = es.id),
			(SELECT count(*) FROM "Grade" g WHERE g."sessionId" = es.id),
			(SELECT count(*) FROM "Grade" g WHERE g."sessionId" = es.id AND g."autoGraded" = false),
			(SELECT coalesce(sum(g.points), 0) FROM "Grade" g WHERE g."sessionId" = es.id),
			(SELECT coalesce(sum(g."maxPoints"), 0) FROM "Grade" g WHERE g."sessionId" = es.id),
			(SELECT count(*) FROM "IntegrityEvent" ie WHERE ie."sessionId" = es.id AND ie.kind <> 'PAGE_FOCUS_LOST'),
			(SELECT count(*) FROM "IntegrityEvent" ie WHERE ie."sessionId" = es.id AND ie.kind = 'PAGE_FOCUS_LOST'),
			es."sebIntegrityFlaggedAt" IS NOT NULL, es."sebIntegrityReason"
		FROM "ExamSession" es
		JOIN "User" u ON u.id = es."userId"
		WHERE es."examId" = $1
		ORDER BY es."startedAt" ASC NULLS LAST
	`, examID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]MonitorSession, 0)
	for rows.Next() {
		var m MonitorSession
		if err := rows.Scan(
			&m.ID, &m.Student.ID, &m.Student.Name, &m.Student.Email, &m.Status,
			&m.StartedAt, &m.SubmittedAt, &m.SubmissionType,
			&m.EffectiveEndTime, &m.TimeExtensionMin, &m.NamApplied, &m.LastSeenAt, &m.ReconnectCount,
			&m.AnswerCount, &m.GradedCount, &m.ManuallyGradedCount, &m.TotalPoints, &m.MaxPoints,
			&m.IntegrityEventCount, &m.FocusLossEventCount,
			&m.SebIntegrityFlagged, &m.SebIntegrityReason,
		); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// SaveIntegrityEvent persists one client-reported behavioral signal. Called
// directly (not buffered like answers) since the Room's rate limiting
// already keeps volume low.
func (s *Store) SaveIntegrityEvent(ctx context.Context, sessionID, kind, detail string, clientTime time.Time) error {
	var detailArg any
	if detail != "" {
		detailArg = detail
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO "IntegrityEvent" (id, "sessionId", kind, detail, "clientTime", "createdAt")
		VALUES ($1, $2, $3, $4, $5, now())
	`, cuid.New(), sessionID, kind, detailArg, clientTime)
	return err
}

// AnswerUpsert is one buffered answer flushed from Redis to Postgres.
type AnswerUpsert struct {
	SessionID  string
	QuestionID string
	Content    []byte // raw JSON
	ClientSeq  *int64
	ReceivedAt *time.Time
}

// flushAnswerSQL writes one buffered answer under two guards:
//
//   - Lock gate: the room relies on best-effort Redis pub/sub. Preserve saves
//     received before lockedAt (already acknowledged), but reject post-lock
//     saves even when the control message was dropped. Legacy locks without
//     a timestamp fail closed. The separate pre-submit drain still applies.
//   - Submission gate: an answer the WS backend received after the
//     session's submittedAt is dropped. Saves acked before the submit still
//     land (that is what the submit path's drain wait is for), but nothing
//     can edit a submission after the fact. submittedAt is a Prisma
//     TIMESTAMP(3) holding UTC, so $6 is a UTC wall-clock string truncated
//     to the same millisecond precision. It compares the WS backend's clock
//     with the web app's, which share a host in the compose deployment.
//   - Ordering: a save only replaces a stored answer with a lower clientSeq,
//     so an older value still sitting in Redis can't overwrite a newer one
//     the REST fallback already wrote (and vice versa — the REST route uses
//     the same predicate). A save without a seq (a client from before the
//     field existed) writes unconditionally, as before.
//
// The gate locks the session before writing its answers, matching the REST
// route's lock order. Otherwise a concurrent submission could grade before
// this statement commits, while its snapshot still sees submittedAt=NULL and
// fails to flag the late answer for regrading. The submitted flag must come
// from that locked gate too: if the gate waited for a concurrent submit, it
// sees the committed row, while an unlocked UPDATE predicate would still see
// submittedAt=NULL in the statement's original snapshot.
//
// Timestamps are written as UTC wall clock, the way Prisma stores DateTime,
// so they don't depend on the server's TimeZone setting.
//
// When the write lands on an already-submitted session, its auto-grades may
// predate it, so the session is flagged for regrading (see
// lib/grading/grade-session.ts).
const flushAnswerSQL = `
WITH gate AS (
	SELECT es.id, es."submittedAt" IS NOT NULL AS submitted FROM "ExamSession" es
	WHERE es.id = $2::text
	AND (es.status <> 'LOCKED' OR
	       (es."lockedAt" IS NOT NULL AND $6::text IS NOT NULL AND $6::text::timestamp <= es."lockedAt"))
	  AND NOT EXISTS (
	      SELECT 1 FROM "SessionLockInterval" sli
	      WHERE sli."sessionId" = es.id
	        AND ($6::text IS NULL OR (
	          $6::text::timestamp > sli."lockedAt"
	          AND (sli."unlockedAt" IS NULL OR $6::text::timestamp < sli."unlockedAt")
	        ))
	  )
	  AND (es."submittedAt" IS NULL OR $6::text IS NULL OR $6::text::timestamp <= es."submittedAt")
	FOR UPDATE
), up AS (
	INSERT INTO "Answer" (id, "sessionId", "questionId", content, version, "clientSeq", "createdAt", "updatedAt")
	SELECT $1::text, gate.id, $3::text, $4::jsonb, 1, $5::bigint, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC' FROM gate
	ON CONFLICT ("sessionId", "questionId") DO UPDATE
	SET content = EXCLUDED.content,
	    version = "Answer".version + 1,
	    "clientSeq" = COALESCE(EXCLUDED."clientSeq", "Answer"."clientSeq"),
	    "updatedAt" = now() AT TIME ZONE 'UTC'
	WHERE EXCLUDED."clientSeq" IS NULL
	   OR "Answer"."clientSeq" IS NULL
	   OR "Answer"."clientSeq" < EXCLUDED."clientSeq"
	RETURNING "sessionId"
)
UPDATE "ExamSession" SET "needsRegrade" = true
WHERE id IN (SELECT up."sessionId" FROM up JOIN gate ON gate.id = up."sessionId" WHERE gate.submitted)`

// pgTimestamp formats t the way Prisma stores a DateTime: UTC wall clock,
// millisecond precision, no zone.
func pgTimestamp(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := t.UTC().Format("2006-01-02T15:04:05.000")
	return &s
}

// FlushAnswers locks target sessions in a stable order, then writes the
// answer batch in the same explicit transaction (all rows or none). Taking
// locks in a separate statement gives interval guards a fresh READ COMMITTED
// snapshot after any lifecycle transition the lock acquisition waited for.
func (s *Store) FlushAnswers(ctx context.Context, answers []AnswerUpsert) error {
	if len(answers) == 0 {
		return nil
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	// Lock every target session before evaluating interval predicates. A
	// fresh statement snapshot then includes transitions we waited for.
	// Stable ordering also prevents batches from deadlocking one another.
	sessionSet := make(map[string]struct{}, len(answers))
	for _, answer := range answers {
		sessionSet[answer.SessionID] = struct{}{}
	}
	sessionIDs := make([]string, 0, len(sessionSet))
	for id := range sessionSet {
		sessionIDs = append(sessionIDs, id)
	}
	sort.Strings(sessionIDs)
	rows, err := tx.Query(ctx, `SELECT id FROM "ExamSession" WHERE id = ANY($1) ORDER BY id FOR UPDATE`, sessionIDs)
	if err != nil {
		return err
	}
	for rows.Next() {
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	batch := &pgx.Batch{}
	for _, a := range answers {
		batch.Queue(flushAnswerSQL, cuid.New(), a.SessionID, a.QuestionID, a.Content, a.ClientSeq, pgTimestamp(a.ReceivedAt))
	}
	br := tx.SendBatch(ctx, batch)
	defer func() { _ = br.Close() }()
	for range answers {
		if _, err := br.Exec(); err != nil {
			return err
		}
	}
	if err := br.Close(); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// TouchLastSeenBatch bumps lastSeenAt for many sessions in one round trip,
// used by the flusher alongside FlushAnswers.
func (s *Store) TouchLastSeenBatch(ctx context.Context, sessionIDs []string) error {
	if len(sessionIDs) == 0 {
		return nil
	}
	_, err := s.pool.Exec(ctx, `UPDATE "ExamSession" SET "lastSeenAt" = now() WHERE id = ANY($1)`, sessionIDs)
	return err
}
