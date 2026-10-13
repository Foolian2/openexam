package hub

import (
	"context"
	"time"

	"openexam/ws-backend/internal/metrics"
	"openexam/ws-backend/internal/protocol"
	"openexam/ws-backend/internal/recovery"
	"openexam/ws-backend/internal/store"
)

// Answer saves off the room goroutine.
//
// Each answer:save needs an authoritative Postgres lifecycle check (lock
// intervals, submission, close — see answerSaveRejection) and a Redis buffer
// write. Running both on the room goroutine serialized every student in the
// exam behind each round trip: at the load scenario's 100 students saving
// every 500 ms that is ~200 sequential queries per second, and any query
// latency turns into head-of-line blocking for timer, control and register
// traffic too.
//
// The room goroutine still runs every in-memory check (submitted, closed,
// rate limit, payload validation) and still owns every Client.enqueue (see
// the contract in async.go). Only the I/O moves: one lane per session runs
// that session's saves in arrival order, so saves of different students
// proceed concurrently while one student's saves never overtake each other.
// The lane hands its result back over r.saveResults, and the room goroutine
// sends the ack or error and the monitor update.

// saveLaneDepth bounds queued saves per session. The per-session rate limit
// (allowAnswerSave) keeps a well-behaved client far below this; a full lane
// means the session's I/O is stalled, so the save is refused and the client's
// retry loop resends it.
const saveLaneDepth = 32

// saveIOTimeout caps the Redis buffer write in a lane, like asyncJobTimeout
// caps background jobs: a wedged dependency must not park the lane forever.
const saveIOTimeout = 5 * time.Second

type saveJob struct {
	client   *Client
	envID    string
	data     protocol.AnswerSaveData
	recvAt   time.Time
	examID   string
	session  string
	question string
}

// saveResult is a lane's verdict. code is the answer:error code, or "" when
// the answer is buffered and should be acked.
type saveResult struct {
	job  saveJob
	code string
}

type saveLane struct {
	jobs chan saveJob
}

// dispatchSave queues a validated save on its session's lane, starting the
// lane on first use. Must only be called from the room goroutine. Returns
// false when the lane is full.
func (r *Room) dispatchSave(job saveJob) bool {
	lane := r.saveLanes[job.session]
	if lane == nil {
		lane = &saveLane{jobs: make(chan saveJob, saveLaneDepth)}
		r.saveLanes[job.session] = lane
		// The Hub's WaitGroup: shutdown waits for in-flight saves before it
		// closes the Postgres and Redis pools.
		r.flushWg.Add(1)
		go r.runSaveLane(lane)
	}
	select {
	case lane.jobs <- job:
		return true
	default:
		return false
	}
}

func (r *Room) runSaveLane(lane *saveLane) {
	defer r.flushWg.Done()
	defer recovery.Guard(r.log, "answer save lane")
	for job := range lane.jobs {
		res := saveResult{job: job, code: r.checkAndBuffer(job)}
		select {
		case r.saveResults <- res:
		case <-r.stopping:
			// The room is tearing down. A buffered answer is still flushed;
			// the client's retry loop resends an unacknowledged one.
		}
	}
}

// checkAndBuffer does a save's I/O: the authoritative lifecycle check, then
// the Redis buffer write. It touches no room state and never enqueues.
func (r *Room) checkAndBuffer(job saveJob) string {
	// Background, not the room ctx: the room ctx is cancelled at the start of
	// shutdown, exactly when in-flight saves should still land.
	checkStarted := time.Now()
	checkCtx, cancelCheck := context.WithTimeout(context.Background(), answerStateCheckTimeout)
	answerState, err := r.store.GetAnswerSaveState(checkCtx, job.examID, job.session, job.recvAt)
	cancelCheck()
	metrics.AnswerStateCheckSeconds.Observe(time.Since(checkStarted).Seconds())
	if err != nil {
		r.log.Error("answer:save lifecycle check failed", "sessionId", job.session, "error", err)
		metrics.AnswerStateCheckOutcomes.WithLabelValues("error").Inc()
		return "SAVE_UNAVAILABLE"
	}
	if code := answerSaveRejection(answerState, job.recvAt, r.submitGrace); code != "" {
		metrics.AnswerStateCheckOutcomes.WithLabelValues("denied").Inc()
		return code
	}
	metrics.AnswerStateCheckOutcomes.WithLabelValues("allowed").Inc()

	// recvAt is when the frame came off the socket. The flusher compares it
	// against the session's submittedAt so a save that raced past the
	// submitted gates still can't land after the submission.
	meta := store.AnswerMeta{ClientSeq: job.data.ClientSeq, ReceivedAt: job.recvAt}
	saveCtx, cancelSave := context.WithTimeout(context.Background(), saveIOTimeout)
	defer cancelSave()
	if err := r.buffer.SaveAnswer(saveCtx, job.examID, job.session, job.question, job.data.Content, meta); err != nil {
		r.log.Error("answer:save failed", "sessionId", job.session, "error", err)
		return "SAVE_FAILED"
	}
	return ""
}

// handleSaveResult replies to the client on the room goroutine.
func (r *Room) handleSaveResult(res saveResult) {
	job := res.job
	if res.code != "" {
		job.client.enqueue(mustEncode(protocol.TypeAnswerError, job.envID, protocol.AnswerErrorData{Code: res.code}))
		metrics.AnswerAckSeconds.WithLabelValues("rejected").Observe(time.Since(job.recvAt).Seconds())
		return
	}
	now := nowRFC3339()
	recvAt := job.recvAt
	// Success is observed when the write pump has put the ack on the wire,
	// not when it is queued (see handleAnswerSave).
	job.client.enqueueWithCallback(
		mustEncode(protocol.TypeAnswerAck, job.envID, protocol.AnswerAckData{QuestionID: job.question, SavedAt: now}),
		func() {
			metrics.AnswerAckSeconds.WithLabelValues("ok").Observe(time.Since(recvAt).Seconds())
		},
	)
	r.broadcastMonitorUpdate(job.session, map[string]any{"lastSeenAt": now})
}

// stopSaveLanes ends every lane at room teardown. Runs on the room goroutine
// after the run loop has stopped reading saveResults: closing stopping first
// releases any lane blocked on handing back a result.
func (r *Room) stopSaveLanes() {
	close(r.stopping)
	for _, lane := range r.saveLanes {
		close(lane.jobs)
	}
}
