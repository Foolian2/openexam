package hub

import (
	"context"
	"time"

	"github.com/coder/websocket"

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
// The write runs while the session's share locks are held, so a slow Redis
// also delays takeover claims and teacher locks; keep it short.
const saveIOTimeout = 3 * time.Second

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
	// Keep the session share lock through Redis buffering. A claim must wait
	// for an already-authorized save; a save after a claim sees its new owner.
	// This also preserves acknowledged pre-takeover answers for the new tab.
	ioCtx, cancel := context.WithTimeout(context.Background(), answerStateCheckTimeout+saveIOTimeout)
	defer cancel()
	checkStarted := time.Now()
	checked := false
	code := ""
	err := r.store.WithAnswerSaveState(ioCtx, job.examID, job.session, job.recvAt, func(state *store.AnswerSaveState) error {
		checked = true
		metrics.AnswerStateCheckSeconds.Observe(time.Since(checkStarted).Seconds())
		if state == nil {
			code = "SAVE_UNAVAILABLE"
		} else if !clientOwnsSession(job.client, state.ActiveAuthSessionID, state.ActiveDeviceID) {
			code = "SESSION_REPLACED"
		} else {
			code = answerSaveRejection(state, job.recvAt, r.submitGrace)
		}
		if code != "" {
			metrics.AnswerStateCheckOutcomes.WithLabelValues("denied").Inc()
			return nil
		}
		metrics.AnswerStateCheckOutcomes.WithLabelValues("allowed").Inc()
		meta := store.AnswerMeta{ClientSeq: job.data.ClientSeq, ReceivedAt: job.recvAt}
		saveCtx, cancelSave := context.WithTimeout(ioCtx, saveIOTimeout)
		defer cancelSave()
		if err := r.buffer.SaveAnswer(saveCtx, job.examID, job.session, job.question, job.data.Content, meta); err != nil {
			code = "SAVE_FAILED"
			return err
		}
		return nil
	})
	if !checked {
		metrics.AnswerStateCheckSeconds.Observe(time.Since(checkStarted).Seconds())
		metrics.AnswerStateCheckOutcomes.WithLabelValues("error").Inc()
	}
	if err != nil {
		r.log.Error("answer:save authorization/buffer failed", "sessionId", job.session, "error", err)
		// A failed commit after a successful buffer write also lands here:
		// the answer is buffered, but the client retries it anyway, which is
		// harmless because the buffer is idempotent by clientSeq.
		if code == "" {
			return "SAVE_UNAVAILABLE"
		}
	}
	return code
}

// handleSaveResult replies to the client on the room goroutine.
func (r *Room) handleSaveResult(res saveResult) {
	job := res.job
	if res.code != "" {
		job.client.enqueue(mustEncode(protocol.TypeAnswerError, job.envID, protocol.AnswerErrorData{Code: res.code}))
		metrics.AnswerAckSeconds.WithLabelValues("rejected").Observe(time.Since(job.recvAt).Seconds())
		if res.code == "SESSION_REPLACED" {
			// The committed owner is someone else, whether or not the
			// advisory Redis event reached this socket. Close it so it
			// stops sending integrity events into the owner's session.
			job.client.enqueue(mustEncode(protocol.TypeExamControl, "", protocol.ControlEventData{Action: protocol.ActionSessionReplaced, SessionID: job.session}))
			job.client.requestClose(websocket.StatusNormalClosure, "replaced by another tab or login")
		}
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
