package hub

import (
	"context"
	"time"

	"openexam/ws-backend/internal/metrics"
)

// Background I/O for a room.
//
// A Room processes everything for one exam on a single goroutine, which is what
// lets it own students/monitors/state without locks. The cost is that any
// blocking I/O on that goroutine stalls every other student in the room behind
// it. Idle CPU next to a multi-second tail is the signature of queueing, not
// saturation — more vCPU cannot fix it, so the I/O has to come off the
// goroutine.
//
// The contract that keeps this safe is narrow and deliberate:
//
//	An async job performs I/O only. It must not touch room state
//	(students/monitors/state/sessionState) and must not call Client.enqueue.
//
// Both halves matter. Room state is unsynchronized by design. And enqueue's
// overflow path (Client.closeOnce) is not safe against two goroutines racing
// it — two concurrent overflows would both pass the select and double-close
// c.closed, which panics. Only the room goroutine calls enqueue; keeping it
// that way means this change adds no new races rather than trading one
// problem for another.
//
// That "only the room goroutine" premise is enforced, not just assumed: the
// one caller that used to reach broadcastMonitorUpdate from outside this
// goroutine — the SEB BEK attestation, from the WebSocket handshake's HTTP
// handler — now hands its delta to the room over r.extBroadcast instead of
// calling in directly (see BroadcastMonitorUpdate and the case in run()).
// A future exported method that skips that hand-off and calls an async job
// or enqueue directly would reopen exactly the class of bug that fix closed.

// asyncQueueDepth bounds queued background jobs per room. Generous because the
// cost of a slot is one closure: at 25 students saving every 500ms a room
// offers ~50 jobs/s, so this is ~20s of buffer before either backpressure
// policy engages.
const asyncQueueDepth = 1024

// asyncJobTimeout caps a single background job. Without it a wedged Redis or
// Postgres would park the worker forever and the queue would fill behind it,
// which converts a slow dependency into a stalled room — exactly what this
// mechanism exists to prevent.
const asyncJobTimeout = 5 * time.Second

type asyncJob func(context.Context)

// runAsync drains the job queue on exactly ONE goroutine per room.
//
// Single consumer is a correctness requirement, not a simplification. Jobs
// include the cross-instance monitor publishes, and MonitorUpdateData carries
// no sequence number while the frontend blind-merges each patch into its state
// (components/monitor/live-monitor.tsx). Reordering two patches that touch the
// same key for the same session leaves the stale value winning permanently —
// a teacher's integrityEventCount going backwards, or a SESSION_LOCKED badge
// that never clears. The existing design already tolerates *loss* (the Hub
// drops on a full channel, and the monitor UI has a REST poll fallback), but
// nothing tolerates reordering. A worker pool here would be a real bug.
func (r *Room) runAsync(done chan<- struct{}) {
	defer close(done)
	for job := range r.async {
		// context.Background(), never the room ctx: the room ctx is cancelled
		// at the START of shutdown, so using it here would fail every job
		// queued at exactly the moment we most want them to land. Same reason
		// the flusher uses a fresh context for its drain (store/buffer.go).
		ctx, cancel := context.WithTimeout(context.Background(), asyncJobTimeout)
		job(ctx)
		cancel()
	}
}

// offloadLossy queues a job, dropping it if the queue is full.
//
// For work where losing one item degrades nothing that isn't already
// degradable — the cross-instance monitor publish, whose local delivery has
// already happened and whose remote consumers have a REST fallback. Mirrors
// the Hub's existing drop-on-full behaviour for control/monitor relay.
// Must only be called from the room goroutine.
func (r *Room) offloadLossy(what string, job asyncJob) {
	select {
	case r.async <- job:
	default:
		r.log.Warn("async queue full, dropping job", "examId", r.examID, "job", what)
		metrics.AsyncQueueFull.WithLabelValues("lossy").Inc()
	}
}

// offloadDurable queues a job, running it INLINE if the queue is full.
//
// For work whose loss is a real data loss — the integrity event INSERT. Under
// enough pressure to fill the queue this degrades to the old synchronous
// behaviour (a stalled room) rather than silently dropping rows, which is the
// right trade: slow beats wrong. Must only be called from the room goroutine,
// since the inline path runs the job there.
func (r *Room) offloadDurable(what string, job asyncJob) {
	select {
	case r.async <- job:
	default:
		r.log.Warn("async queue full, running job inline", "examId", r.examID, "job", what)
		metrics.AsyncQueueFull.WithLabelValues("durable_inline").Inc()
		ctx, cancel := context.WithTimeout(context.Background(), asyncJobTimeout)
		defer cancel()
		job(ctx)
	}
}
