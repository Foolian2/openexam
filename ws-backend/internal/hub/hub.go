// Package hub manages one goroutine-owned Room per exam and the
// cross-instance Redis pub/sub that keeps rooms on different server
// processes in sync.
package hub

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"openexam/ws-backend/internal/metrics"
	"openexam/ws-backend/internal/recovery"
	"openexam/ws-backend/internal/store"
)

const (
	controlPattern = "exam:*:control"
	monitorPattern = "exam:*:monitor"

	// publishTimeout caps one cross-instance monitor publish. Well under
	// async.go's per-job timeout so a slow publish surfaces as its own error
	// rather than as a generic job timeout.
	publishTimeout = 2 * time.Second
)

type Hub struct {
	rdb        *redis.Client
	store      RoomStore
	buffer     AnswerBuffer
	flusher    ExamFlusher
	instanceID string

	idleTimeout time.Duration
	submitGrace time.Duration

	mu    sync.Mutex
	rooms map[string]*Room

	// deliveryMu guards pendingControl/delivering: control messages are
	// queued per room and drained by one goroutine per room, so a wedged
	// room stalls only its own control delivery — never the shared
	// SubscribeControl goroutine that serves every exam on this instance.
	deliveryMu     sync.Mutex
	pendingControl map[*Room][]redisControlMessage
	delivering     map[*Room]bool

	roomCtx    context.Context
	roomCancel context.CancelFunc
	wg         sync.WaitGroup

	// flushWg tracks the force-flush goroutines offloaded by rooms
	// (offloadFlush), so Shutdown can wait for them to finish before the
	// process closes its Postgres/Redis pools — a flush still in flight
	// when the pools close fails after the dirty flag was already handed
	// off, losing acked answers.
	flushWg sync.WaitGroup

	log *slog.Logger
}

func New(rdb *redis.Client, st RoomStore, buf AnswerBuffer, fl ExamFlusher, idleTimeout, submitGrace time.Duration, log *slog.Logger) *Hub {
	if log == nil {
		log = slog.Default()
	}
	roomCtx, cancel := context.WithCancel(context.Background())
	return &Hub{
		rdb:            rdb,
		store:          st,
		buffer:         buf,
		flusher:        fl,
		instanceID:     randomID(),
		idleTimeout:    idleTimeout,
		submitGrace:    submitGrace,
		rooms:          make(map[string]*Room),
		pendingControl: make(map[*Room][]redisControlMessage),
		delivering:     make(map[*Room]bool),
		roomCtx:        roomCtx,
		roomCancel:     cancel,
		log:            log,
	}
}

func randomID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// GetOrCreateRoom returns the room for examID, starting it if this is the
// first local client for that exam (or the previous room already timed out).
func (h *Hub) GetOrCreateRoom(examID string) *Room {
	h.mu.Lock()
	defer h.mu.Unlock()

	if r, ok := h.rooms[examID]; ok && !r.IsStopped() {
		return r
	}

	r := newRoom(examID, h.store, h.buffer, h.flusher, h.publish, h.instanceID, h.idleTimeout, h.submitGrace, h.log)
	// Point the room's offloaded flushes at the hub's WaitGroup so Shutdown
	// can drain them. Set before the room goroutine starts, so no race.
	r.flushWg = &h.flushWg
	h.rooms[examID] = r
	metrics.ActiveRooms.Inc()
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		defer recovery.Guard(h.log, "room run loop")
		r.run(h.roomCtx)
	}()
	return r
}

// publish fans a monitor delta out to the other ws-backend instances.
//
// Bounded rather than context.Background(): this used to be able to block
// forever against an unresponsive Redis. It now runs on a room's async worker
// (see async.go), and an unbounded call there would park the worker and back
// the queue up behind it — turning a slow dependency into a stalled room,
// which is exactly what moving it off the room goroutine was meant to prevent.
func (h *Hub) publish(channel string, payload []byte) error {
	ctx, cancel := context.WithTimeout(context.Background(), publishTimeout)
	defer cancel()
	return h.rdb.Publish(ctx, channel, payload).Err()
}

// JoinRoom registers a client (student with sessionAuth, or monitor with
// nil) with the room for examID, creating it if needed. Registering into a
// room that tore itself down between GetOrCreateRoom and the register would
// silently no-op — leaving a connected-but-unregistered client that never
// receives timer:sync or control events — so it retries once with a fresh
// room before giving up and returning nil.
func (h *Hub) JoinRoom(examID string, c *Client, sessionAuth *store.ExamSessionAuth) *Room {
	for attempt := 0; attempt < 2; attempt++ {
		r := h.GetOrCreateRoom(examID)
		if sessionAuth != nil {
			r.RegisterStudent(c, sessionAuth)
		} else {
			r.RegisterMonitor(c)
		}
		// RegisterStudent/RegisterMonitor block until the room accepts the
		// registration or the room's done channel closes, so a non-stopped
		// room here has definitely taken the client.
		if !r.IsStopped() {
			return r
		}
	}
	h.log.Error("failed to join room", "examId", examID)
	return nil
}

// SubscribeControl runs the Redis pub/sub listener for exam control and
// monitor-delta channels until ctx is canceled. Meant to run in its own
// goroutine for the lifetime of the process.
func (h *Hub) SubscribeControl(ctx context.Context) {
	sub := h.rdb.PSubscribe(ctx, controlPattern, monitorPattern)
	defer func() { _ = sub.Close() }()

	ch := sub.Channel()
	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-ch:
			if !ok {
				return
			}
			h.dispatch(msg.Channel, []byte(msg.Payload))
		}
	}
}

// dispatch routes one pub/sub message to its room, if that room currently
// has any local clients. A control/monitor event for an exam with no local
// connections is simply dropped — there's nothing local to deliver it to.
func (h *Hub) dispatch(channel string, payload []byte) {
	examID, kind, ok := parseChannel(channel)
	if !ok {
		return
	}

	h.mu.Lock()
	r, ok := h.rooms[examID]
	h.mu.Unlock()
	if !ok || r.IsStopped() {
		return
	}

	switch kind {
	case "control":
		var msg redisControlMessage
		if err := json.Unmarshal(payload, &msg); err != nil {
			h.log.Warn("dropping malformed control message", "channel", channel, "error", err)
			return
		}
		// Control events are authoritative state transitions (EXAM_CLOSED,
		// SESSION_LOCKED, ...) with no client-side recovery if one is lost —
		// a dropped EXAM_CLOSED keeps students typing in a closed exam. So
		// delivery never drops. But it must not block this shared subscriber
		// goroutine either: a single wedged room (control channel full while
		// it is stuck on slow I/O) would otherwise stall control delivery to
		// every other exam on this instance. deliverControl queues the message
		// per room and drains it on a per-room goroutine instead.
		h.deliverControl(r, msg)
	case "monitor":
		var msg redisMonitorMessage
		if err := json.Unmarshal(payload, &msg); err != nil {
			h.log.Warn("dropping malformed monitor message", "channel", channel, "error", err)
			return
		}
		// Monitor deltas are idempotent patches and loss-tolerant — a dropped
		// one is corrected by the next delta or snapshot fetch — so dropping
		// under load is preferable to blocking the shared subscriber.
		select {
		case r.monitorRel <- msg:
		default:
			h.log.Warn("monitor relay channel full, dropping message", "examId", examID, "sessionId", msg.SessionID)
		}
	}
}

// deliverControl hands one control message to the room without ever blocking
// the caller (the shared SubscribeControl goroutine). It appends to the
// room's pending queue and, if no drainer is currently running for that room,
// starts one. Each drainer owns its room's queue, so a room that is slow to
// consume control events only holds up its own delivery — never the control
// delivery of any other exam on this instance.
func (h *Hub) deliverControl(r *Room, msg redisControlMessage) {
	h.deliveryMu.Lock()
	h.pendingControl[r] = append(h.pendingControl[r], msg)
	if h.delivering[r] {
		h.deliveryMu.Unlock()
		return
	}
	h.delivering[r] = true
	h.deliveryMu.Unlock()

	go h.drainControl(r)
}

// drainControl delivers the room's queued control messages one at a time
// until the queue is empty, then deregisters itself. It stops delivering and
// discards the queue if the room tears down (<-r.done), since a stopped room
// will never consume them. The drainer is the only goroutine that sends on
// r.control for queued messages, so ordering is preserved.
func (h *Hub) drainControl(r *Room) {
	for {
		h.deliveryMu.Lock()
		queue := h.pendingControl[r]
		if len(queue) == 0 {
			delete(h.pendingControl, r)
			delete(h.delivering, r)
			h.deliveryMu.Unlock()
			return
		}
		msg := queue[0]
		h.pendingControl[r] = queue[1:]
		h.deliveryMu.Unlock()

		select {
		case r.control <- msg:
		case <-r.done:
			h.discardControl(r)
			return
		}
	}
}

// discardControl drops any messages still queued for a torn-down room and
// marks it no longer delivering.
func (h *Hub) discardControl(r *Room) {
	h.deliveryMu.Lock()
	delete(h.pendingControl, r)
	delete(h.delivering, r)
	h.deliveryMu.Unlock()
}

func parseChannel(channel string) (examID, kind string, ok bool) {
	parts := strings.Split(channel, ":")
	if len(parts) != 3 || parts[0] != "exam" {
		return "", "", false
	}
	return parts[1], parts[2], true
}

// Shutdown stops accepting room work, cancels every room's context (which
// closes its clients), waits for all room goroutines to exit, and then
// drains the force-flush goroutines they offloaded. The flush wait comes
// after the room wait on purpose: rooms are the only callers of
// offloadFlush, so once they're gone no new flushes can start and the
// WaitGroup can't be Add'ed while we Wait on it.
func (h *Hub) Shutdown(timeout time.Duration) {
	h.roomCancel()
	done := make(chan struct{})
	go func() {
		defer recovery.Guard(h.log, "hub shutdown wait")
		h.wg.Wait()
		h.flushWg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(timeout):
		h.log.Warn("hub shutdown timed out waiting for rooms to drain")
	}
}
