package hub

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	ws "github.com/coder/websocket"
	"github.com/redis/go-redis/v9"

	"openexam/ws-backend/internal/protocol"
	"openexam/ws-backend/internal/store"
)

// JoinRoom is the hub-level entry point for WS handshakes: it must never
// leave a client connected-but-unregistered, even when the room it grabbed
// tore itself down between GetOrCreateRoom and the registration (idle
// timeout). Before JoinRoom, a handler that lost that race silently served a
// client with no timer:sync, no control events, and no message routing.
func TestHub_JoinRoom_RegistersClientAfterRoomTeardown(t *testing.T) {
	rdb := redis.NewClient(&redis.Options{Addr: miniredis.RunT(t).Addr()})
	t.Cleanup(func() { _ = rdb.Close() })

	h := New(rdb, &fakeRoomStore{}, &fakeBuffer{}, &fakeFlusher{}, 20*time.Millisecond, 0, nil)

	// Let the first room for the exam idle out before the client joins, so
	// the join is forced through a stopped room's replacement.
	first := h.GetOrCreateRoom("exam-1")
	select {
	case <-first.done:
	case <-time.After(2 * time.Second):
		t.Fatal("expected the empty first room to idle out")
	}

	// The join now has to go through the stopped room's replacement and
	// must land in a fresh room whose run loop the returned *Room routes
	// to — the client still has to end up registered.
	ts := newJoinTestServer(t, h)
	student := dial(t, wsURL(ts.URL, "/ws/exam"))
	defer func() { _ = student.Close(ws.StatusNormalClosure, "") }()

	env := readEnvelope(t, student)
	if env.Type != protocol.TypeTimerSync {
		t.Fatalf("got type %q, want timer:sync (client must be registered, not silently dropped)", env.Type)
	}
}

// newJoinTestServer serves one student WS endpoint that joins through the
// hub, mirroring the production handshake path (main.go studentHandler).
func newJoinTestServer(t *testing.T, h *Hub) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := ws.Accept(w, r, &ws.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		c := NewStudentClient(conn, "user-1", "sess-1", nil)
		room := h.JoinRoom("exam-1", c, &store.ExamSessionAuth{
			ID: "sess-1", Status: "IN_PROGRESS",
			Questions: []store.QuestionAuth{{ID: "q-1", Type: "FREE_TEXT"}},
		})
		if room == nil {
			return
		}
		runConn(room, c)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// A room that stops its run loop must remove its own hub entry, otherwise the
// stopped room — its closed channels and retained per-session maps — stays
// reachable for the hub's lifetime. The removal must delete only the
// identical stopped instance so a race with a joining client cannot drop the
// replacement room.
func TestHub_StoppedRoomIsRemoved(t *testing.T) {
	h := New(nil, &fakeRoomStore{}, &fakeBuffer{}, &fakeFlusher{}, 10*time.Millisecond, 0, nil)
	defer h.Shutdown(time.Second)
	r := h.GetOrCreateRoom("audit-exam")
	select {
	case <-r.done:
	case <-time.After(time.Second):
		t.Fatal("room did not stop")
	}
	h.wg.Wait()
	h.mu.Lock()
	retained := h.rooms["audit-exam"] == r
	h.mu.Unlock()
	t.Logf("stopped=%v retained in hub=%v", r.IsStopped(), retained)
	if retained {
		t.Fatal("stopped room is still retained")
	}
}

// TestHub_StoppedRoomIsRemoved above cannot see HOW the entry is deleted —
// an unconditional delete(h.rooms, examID) passes it just as well. The
// identity check is what actually prevents a stopped room's cleanup from
// deleting a replacement a join installed while it was draining, so it gets
// asserted directly: a stale cleanup must leave the replacement alone.
func TestHub_RemoveRoomIfCurrentKeepsReplacement(t *testing.T) {
	h := New(nil, &fakeRoomStore{}, &fakeBuffer{}, &fakeFlusher{}, 10*time.Millisecond, 0, nil)
	defer h.Shutdown(time.Second)

	stale := &Room{}
	replacement := &Room{}
	h.mu.Lock()
	h.rooms["audit-exam"] = replacement
	h.mu.Unlock()

	h.removeRoomIfCurrent("audit-exam", stale)
	h.mu.Lock()
	kept := h.rooms["audit-exam"]
	h.mu.Unlock()
	if kept != replacement {
		t.Fatalf("stale room cleanup removed the replacement (kept %p, want %p)", kept, replacement)
	}

	h.removeRoomIfCurrent("audit-exam", replacement)
	h.mu.Lock()
	_, ok := h.rooms["audit-exam"]
	h.mu.Unlock()
	if ok {
		t.Fatal("cleanup of the current room left its entry behind")
	}
}
