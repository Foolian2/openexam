package hub

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/coder/websocket"

	"openexam/ws-backend/internal/recovery"
)

// sendBufferSize bounds how many outbound messages queue per client before
// the connection is treated as a slow consumer and dropped — a client that
// can't keep up shouldn't be allowed to back-pressure the whole room.
const sendBufferSize = 64

// ClientKind distinguishes a student exam connection from a teacher monitor
// connection; a Room treats each differently for routing and eviction.
type ClientKind int

const (
	KindStudent ClientKind = iota
	KindMonitor
)

// outboundItem is either a text frame to write or a request to close the
// connection. Routing both through one channel keeps FIFO order: a close
// requested right after a message (e.g. SESSION_REPLACED, EXAM_CLOSED) only
// takes effect once the write pump has flushed everything queued before it.
type outboundItem struct {
	payload []byte
	close   *closeRequest
	// onSent, if set, runs on the write pump goroutine right after payload is
	// successfully written to the wire — not when it is merely queued. Used
	// for latency observations (e.g. answer-ack) that must reflect when the
	// client actually received the frame, not when enqueue returned.
	onSent func()
}

type closeRequest struct {
	code   websocket.StatusCode
	reason string
}

// Client wraps one WebSocket connection with a buffered outbound queue so a
// slow reader can't block the room's single goroutine.
type Client struct {
	conn      *websocket.Conn
	kind      ClientKind
	userID    string
	sessionID string // student only
	send      chan outboundItem
	closed    chan struct{}
	closeOnce sync.Once
	// wg tracks the write pump goroutine so a connection's handler can wait
	// for its close frame to be flushed before returning.
	wg  sync.WaitGroup
	log *slog.Logger
}

func newClient(conn *websocket.Conn, kind ClientKind, userID, sessionID string, log *slog.Logger) *Client {
	return &Client{
		conn:      conn,
		kind:      kind,
		userID:    userID,
		sessionID: sessionID,
		send:      make(chan outboundItem, sendBufferSize),
		closed:    make(chan struct{}),
		log:       log,
	}
}

// NewStudentClient wraps an accepted WebSocket connection for a student's
// exam-taking session.
func NewStudentClient(conn *websocket.Conn, userID, sessionID string, log *slog.Logger) *Client {
	return newClient(conn, KindStudent, userID, sessionID, log)
}

// NewMonitorClient wraps an accepted WebSocket connection for a teacher's
// live monitor view of one exam.
func NewMonitorClient(conn *websocket.Conn, userID string, log *slog.Logger) *Client {
	return newClient(conn, KindMonitor, userID, "", log)
}

// Conn exposes the underlying connection so the HTTP handler's read loop can
// call Read directly (the room only ever writes via the send channel).
func (c *Client) Conn() *websocket.Conn { return c.conn }

// Closed signals when the client has been marked for disconnection (slow
// consumer), so the caller's read loop can stop promptly.
func (c *Client) Closed() <-chan struct{} { return c.closed }

// StartPump runs the write pump in its own goroutine and registers it with
// the client's WaitGroup; call Wait before letting the connection's handler
// return so the close frame has been flushed and the pump goroutine is
// guaranteed gone.
func (c *Client) StartPump(ctx context.Context) {
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		defer recovery.Guard(c.log, "client write pump")
		c.writePump(ctx)
	}()
}

// Wait blocks until the write pump has exited.
func (c *Client) Wait() { c.wg.Wait() }

// enqueue queues a message for the write pump. If the buffer is full the
// client is treated as a slow consumer and disconnected instead of blocking.
func (c *Client) enqueue(msg []byte) {
	c.enqueueWithCallback(msg, nil)
}

// enqueueWithCallback is enqueue, plus a callback the write pump runs after
// this exact payload is successfully written to the wire (not run at all if
// the connection is congested and the message is dropped instead). Use this
// when a caller needs to measure client-visible delivery latency rather than
// queueing latency.
func (c *Client) enqueueWithCallback(msg []byte, onSent func()) {
	select {
	case c.send <- outboundItem{payload: msg, onSent: onSent}:
	default:
		c.closeAsync(websocket.StatusPolicyViolation, "slow consumer")
	}
}

// requestClose queues a close frame behind anything already enqueued, so a
// message sent just before (e.g. exam:control) is guaranteed to be flushed
// first instead of racing the close.
func (c *Client) requestClose(code websocket.StatusCode, reason string) {
	select {
	case c.send <- outboundItem{close: &closeRequest{code: code, reason: reason}}:
	default:
		c.closeAsync(code, reason)
	}
}

// closeAsync runs closeNow on its own goroutine. enqueue/requestClose are
// called from the room goroutine, and Conn.Close performs a close handshake
// whose write-control and close-handshake waits each block for up to ~5s —
// against a stalled peer (a write blocked on its 10s timeout) a synchronous
// close would freeze the entire exam room behind it. The write pump's own
// error path may keep calling closeNow directly: it already runs on its own
// goroutine.
func (c *Client) closeAsync(code websocket.StatusCode, reason string) {
	go c.closeNow(code, reason)
}

// closeNow marks the client closed and closes the underlying connection with
// the requested code/reason. Conn.Close is safe to call concurrently and
// multiple times (it's CAS-guarded), so this aborts a write the pump is
// currently blocked on instead of leaving the connection open for up to the
// write's 10s timeout. closeOnce guards the closed channel: closeNow can be
// reached concurrently (the room goroutine's slow-consumer path and the
// pump's write-error path), and a plain select-then-close would race into a
// double close.
func (c *Client) closeNow(code websocket.StatusCode, reason string) {
	c.closeOnce.Do(func() { close(c.closed) })
	_ = c.conn.Close(code, reason)
}

// writePump drains the send channel until the client closes or the
// connection fails. Runs in its own goroutine per client.
func (c *Client) writePump(ctx context.Context) {
	for {
		select {
		case <-c.closed:
			return
		case <-ctx.Done():
			return
		case item, ok := <-c.send:
			if !ok {
				return
			}
			if item.close != nil {
				_ = c.conn.Close(item.close.code, item.close.reason)
				return
			}
			writeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := c.conn.Write(writeCtx, websocket.MessageText, item.payload)
			cancel()
			if err != nil {
				c.closeNow(websocket.StatusInternalError, "write failed")
				return
			}
			if item.onSent != nil {
				item.onSent()
			}
		}
	}
}
