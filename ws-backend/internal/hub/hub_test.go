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
