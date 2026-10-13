package store

import (
	"context"
	"crypto/rand"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"
)

const dirtyExamsSet = "ws:dirtyexams"

func answersHashKey(examID string) string {
	return fmt.Sprintf("exam:%s:answers", examID)
}

// Buffer is a Redis-backed write-behind cache for answer saves: WS clients
// get an ack as soon as the value lands in Redis, and a background Flusher
// batches it into Postgres every FlushInterval. This bounds Postgres write
// load under ~1000 concurrent typists without losing acked data (a crash
// only loses the unflushed tail, matching the accepted risk in the design).
//
// An entry stays in the live hash until Postgres has it. lib/finalize-session
// waits for a submitted session's fields to leave this hash before grading,
// so the hash must never look empty while a flush is still in flight.
type Buffer struct {
	rdb *redis.Client
}

func NewBuffer(rdb *redis.Client) *Buffer {
	return &Buffer{rdb: rdb}
}

// bufferEntry is what's actually stored per HSET field so a flush can
// reconstruct both the SQL row and which exam/session/question it belongs to.
type bufferEntry struct {
	SessionID  string          `json:"sessionId"`
	QuestionID string          `json:"questionId"`
	Content    json.RawMessage `json:"content"`
	ClientSeq  *int64          `json:"clientSeq,omitempty"`
	// Pointer so entries buffered by a build without it decode as "unknown"
	// rather than the zero time, which the submission gate would read as
	// "received long before submit".
	ReceivedAt *time.Time `json:"receivedAt,omitempty"`
}

// AnswerMeta carries the ordering data a save needs to be flushed safely:
// the client's sequence number (nil for clients that predate it) and when
// the server received the save.
type AnswerMeta struct {
	ClientSeq  *int64
	ReceivedAt time.Time
}

func fieldKey(sessionID, questionID string) string {
	return sessionID + ":" + questionID
}

// SaveAnswer buffers one answer write. It returns once the value is durably
// in Redis (the ack the client sees), not once it's in Postgres.
func (b *Buffer) SaveAnswer(ctx context.Context, examID, sessionID, questionID string, content json.RawMessage, meta AnswerMeta) error {
	entry := bufferEntry{SessionID: sessionID, QuestionID: questionID, Content: content, ClientSeq: meta.ClientSeq}
	if !meta.ReceivedAt.IsZero() {
		receivedAt := meta.ReceivedAt
		entry.ReceivedAt = &receivedAt
	}
	raw, err := json.Marshal(entry)
	if err != nil {
		return err
	}

	// The SQL predicate cannot recover a newer value erased here before the
	// next flush. Compare and write in one Redis operation, keeping equal-seq
	// retries from replacing the original pre-submit receive timestamp too.
	return saveAnswerScript.Run(ctx, b.rdb,
		[]string{answersHashKey(examID), dirtyExamsSet},
		fieldKey(sessionID, questionID), string(raw), examID).Err()
}

// Unsequenced clients retain last-write-wins compatibility. Their writes keep
// a Redis-only sequence floor so a stale sequenced frame cannot replace them.
// Their clientSeq stays nil so SQL still writes them unconditionally, even if
// a concurrent flush already committed the sequence that supplied the floor.
// Malformed old entries are
// replaced normally rather than making the buffer permanently unwritable.
var saveAnswerScript = redis.NewScript(`
local incoming = cjson.decode(ARGV[2])
local current = redis.call("HGET", KEYS[1], ARGV[1])
if current then
 local ok, stored = pcall(cjson.decode, current)
 local floor = ok and type(stored) == "table" and (stored.clientSeq or stored.orderFloor)
 if floor then
  if incoming.clientSeq then
   if incoming.clientSeq <= floor then return 0 end
  else
   -- Do not re-encode answer content through Lua cjson: empty JSON arrays
   -- would become objects. Add the numeric metadata to the original JSON.
   ARGV[2] = string.sub(ARGV[2], 1, -2) .. ',"orderFloor":' .. string.format("%.0f", floor) .. '}'
  end
 end
end
redis.call("HSET", KEYS[1], ARGV[1], ARGV[2])
redis.call("SADD", KEYS[2], ARGV[3])
return 1
`)

// AnswerWriter is the subset of Store the Flusher needs to persist a batch —
// narrowed to an interface so tests can flush against a fake instead of a
// real Postgres connection.
type AnswerWriter interface {
	FlushAnswers(ctx context.Context, answers []AnswerUpsert) error
	TouchLastSeenBatch(ctx context.Context, sessionIDs []string) error
}

// Flusher periodically drains buffered answers into Postgres.
type Flusher struct {
	rdb      *redis.Client
	store    AnswerWriter
	interval time.Duration
	log      *slog.Logger
}

func NewFlusher(rdb *redis.Client, store AnswerWriter, interval time.Duration, log *slog.Logger) *Flusher {
	if log == nil {
		log = slog.Default()
	}
	return &Flusher{rdb: rdb, store: store, interval: interval, log: log}
}

// Run blocks, flushing every interval until ctx is canceled. On cancellation
// it performs one final synchronous flush before returning (graceful
// shutdown drain).
func (f *Flusher) Run(ctx context.Context) {
	ticker := time.NewTicker(f.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			flushCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			f.flushAll(flushCtx)
			cancel()
			return
		case <-ticker.C:
			f.flushAll(ctx)
		}
	}
}

// FlushExamNow forces an immediate flush of one exam's buffer, used on
// SESSION_SUBMITTED / EXAM_CLOSED so submitted answers aren't left waiting
// for the next tick.
func (f *Flusher) FlushExamNow(ctx context.Context, examID string) error {
	return f.flushExam(ctx, examID)
}

func (f *Flusher) flushAll(ctx context.Context) {
	examIDs, err := f.rdb.SMembers(ctx, dirtyExamsSet).Result()
	if err != nil {
		f.log.Error("flusher: failed to list dirty exams", "error", err)
		return
	}
	for _, examID := range examIDs {
		if err := f.flushExam(ctx, examID); err != nil {
			f.log.Error("flusher: failed to flush exam", "examId", examID, "error", err)
		}
	}
}

// snapshotAndClearDirtyScript reads the exam's buffer and clears its dirty
// flag in one step. A SaveAnswer landing after it re-adds the exam to the
// dirty set (its SADD runs after this SREM), so the next tick picks it up
// even when this flush deletes nothing of it.
var snapshotAndClearDirtyScript = redis.NewScript(`
redis.call("SREM", KEYS[2], ARGV[1])
return redis.call("HGETALL", KEYS[1])
`)

// deleteIfUnchangedScript removes each flushed field only if it still holds
// the exact value that was flushed (compared by SHA-1 so the values aren't
// sent back to Redis). A field overwritten by a newer save while the flush
// was in flight keeps the newer value for the next tick. Every entry carries
// its receive time, so a re-save of identical content is still a new value.
// ARGV is field1, sha1(value1), field2, sha1(value2), ...
var deleteIfUnchangedScript = redis.NewScript(`
for i = 1, #ARGV, 2 do
	local current = redis.call("HGET", KEYS[1], ARGV[i])
	if current and redis.sha1hex(current) == ARGV[i + 1] then
		redis.call("HDEL", KEYS[1], ARGV[i])
	end
end
return 0
`)

func flushLockKey(examID string) string {
	return fmt.Sprintf("exam:%s:flushlock", examID)
}

// flushLockTTL outlives a normal flush (FlushAnswers plus cleanup) so the
// lock only lapses if its holder died; the next tick then takes over.
const flushLockTTL = 30 * time.Second

// releaseFlushLockScript deletes the lock only if this flush still owns it,
// so a holder that outlived its TTL can't release a successor's lock.
var releaseFlushLockScript = redis.NewScript(`
if redis.call("GET", KEYS[1]) == ARGV[1] then
	return redis.call("DEL", KEYS[1])
end
return 0
`)

func newLockToken() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// flushExam drains one exam's buffer. At most one flush per exam runs at a
// time across all ws-backend instances: the snapshot leaves entries in the
// hash until Postgres has them, so overlapping flushes (every
// SESSION_SUBMITTED of a mass submission starts one) would each resend the
// whole batch, and an older snapshot of an unsequenced save could commit
// after a newer one.
func (f *Flusher) flushExam(ctx context.Context, examID string) error {
	token, err := newLockToken()
	if err != nil {
		return err
	}
	lockKey := flushLockKey(examID)
	acquired, err := f.rdb.SetNX(ctx, lockKey, token, flushLockTTL).Result()
	if err != nil {
		return err
	}
	if !acquired {
		// The running flush's snapshot covers everything buffered before it
		// started, and anything newer re-added the exam to the dirty set, so
		// the next tick picks it up.
		return nil
	}
	defer func() {
		releaseCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := releaseFlushLockScript.Run(releaseCtx, f.rdb, []string{lockKey}, token).Err(); err != nil && !errors.Is(err, redis.Nil) {
			f.log.Error("flusher: failed to release flush lock", "examId", examID, "error", err)
		}
	}()

	hashKey := answersHashKey(examID)

	values, err := snapshotAndClearDirtyScript.Run(ctx, f.rdb, []string{hashKey, dirtyExamsSet}, examID).StringSlice()
	if err != nil {
		return err
	}
	if len(values) == 0 {
		return nil
	}

	upserts := make([]AnswerUpsert, 0, len(values)/2)
	sessionSet := make(map[string]struct{})
	deleteArgs := make([]any, 0, len(values))
	for i := 0; i+1 < len(values); i += 2 {
		field, raw := values[i], values[i+1]
		sum := sha1.Sum([]byte(raw))
		deleteArgs = append(deleteArgs, field, hex.EncodeToString(sum[:]))

		var entry bufferEntry
		if err := json.Unmarshal([]byte(raw), &entry); err != nil {
			// Dropped from the buffer with the rest of the batch: it can
			// never decode, so keeping it would only fail every future tick.
			f.log.Error("flusher: skipping malformed buffer entry", "examId", examID, "error", err)
			continue
		}
		upserts = append(upserts, AnswerUpsert{
			SessionID:  entry.SessionID,
			QuestionID: entry.QuestionID,
			Content:    entry.Content,
			ClientSeq:  entry.ClientSeq,
			ReceivedAt: entry.ReceivedAt,
		})
		sessionSet[entry.SessionID] = struct{}{}
	}

	if err := f.store.FlushAnswers(ctx, upserts); err != nil {
		f.log.Error("flusher: flush failed, keeping buffer for retry", "examId", examID, "error", err)
		// Nothing was removed from the hash, so only the dirty flag needs
		// restoring. Use a fresh context: if ctx was canceled (e.g. room
		// shutdown) the exam must still be retried by a later tick.
		restoreCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if dirtyErr := f.rdb.SAdd(restoreCtx, dirtyExamsSet, examID).Err(); dirtyErr != nil {
			f.log.Error("flusher: failed to re-mark exam dirty after flush error", "examId", examID, "error", dirtyErr)
		}
		return err
	}

	// The rows are committed, so the buffer entries must go even if ctx was
	// canceled meanwhile; a leftover entry would only be rewritten next tick
	// (a no-op for sequenced saves), but would hold up the submit drain wait.
	cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := deleteIfUnchangedScript.Run(cleanupCtx, f.rdb, []string{hashKey}, deleteArgs...).Err(); err != nil && !errors.Is(err, redis.Nil) {
		f.log.Error("flusher: failed to clear flushed entries", "examId", examID, "error", err)
		// Fresh context: the failure may be cleanupCtx's own deadline, and
		// without the dirty flag the leftover entries are never revisited.
		restoreCtx, cancelRestore := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancelRestore()
		if dirtyErr := f.rdb.SAdd(restoreCtx, dirtyExamsSet, examID).Err(); dirtyErr != nil {
			f.log.Error("flusher: failed to re-mark exam dirty", "examId", examID, "error", dirtyErr)
		}
	}

	sessionIDs := make([]string, 0, len(sessionSet))
	for id := range sessionSet {
		sessionIDs = append(sessionIDs, id)
	}
	return f.store.TouchLastSeenBatch(ctx, sessionIDs)
}
