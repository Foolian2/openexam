package hub

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	ws "github.com/coder/websocket"

	"openexam/ws-backend/internal/protocol"
)

// BroadcastMonitorUpdate is the one entry point into a room's monitor fan-out
// that is called from outside the room goroutine: the SEB BEK attestation
// invokes it from the WebSocket handshake's HTTP handler, before the
// connection is accepted (ws-backend/main.go).
//
// Room's contract is that students/monitors/state are owned by a single
// goroutine and therefore unlocked, so this must hand the delta over rather
// than fan out inline. It previously called broadcastMonitorUpdate directly,
// which raced handleRegister over the r.monitors map — a concurrent map
// read/write Go can escalate into an unrecoverable fatal error.
//
// Run under -race, this fails if the delta is ever fanned out on the caller's
// goroutine again. The monitor churn is what supplies the racing map writes.
func TestRoom_BroadcastMonitorUpdate_IsHandedToRoomGoroutine(t *testing.T) {
	room, _ := newTestRoom(t, &fakeRoomStore{}, &fakeBuffer{}, &fakeFlusher{}, time.Minute)
	ts := newTestServer(t, room)

	var wg sync.WaitGroup

	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 30; i++ {
			c := dial(t, wsURL(ts.srv.URL, "/ws/monitor/exam-1"))
			time.Sleep(time.Millisecond)
			_ = c.Close(ws.StatusNormalClosure, "")
		}
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 300; i++ {
			// A fresh map per call: ownership passes to the room.
			room.BroadcastMonitorUpdate("sess-1", map[string]any{
				"sebIntegrityStatus": "bek_changed",
			})
		}
	}()

	wg.Wait()
}

// A monitor connected throughout must actually receive a delta published from
// a foreign goroutine — the hand-off must not silently drop it.
func TestRoom_BroadcastMonitorUpdate_ReachesMonitors(t *testing.T) {
	room, _ := newTestRoom(t, &fakeRoomStore{}, &fakeBuffer{}, &fakeFlusher{}, time.Minute)
	ts := newTestServer(t, room)

	monitor := dial(t, wsURL(ts.srv.URL, "/ws/monitor/exam-1"))
	if snap := readEnvelope(t, monitor); snap.Type != protocol.TypeMonitorSnapshot {
		t.Fatalf("got type %q, want monitor:snapshot", snap.Type)
	}

	room.BroadcastMonitorUpdate("sess-1", map[string]any{"sebIntegrityStatus": "bek_changed"})

	env := readEnvelope(t, monitor)
	if env.Type != protocol.TypeMonitorUpdate {
		t.Fatalf("got type %q, want monitor:update", env.Type)
	}
	var data protocol.MonitorUpdateData
	if err := json.Unmarshal(env.Data, &data); err != nil {
		t.Fatalf("unmarshal monitor update: %v", err)
	}
	if data.SessionID != "sess-1" {
		t.Fatalf("got sessionId %q, want sess-1", data.SessionID)
	}
	if got := data.Patch["sebIntegrityStatus"]; got != "bek_changed" {
		t.Fatalf("got patch %v, want sebIntegrityStatus=bek_changed", data.Patch)
	}
}

// The Go side is a pass-through for monitor patches — the known-key filter
// lives client-side (lib/monitor-patch.ts mergeKnownPatchKeys). The contract
// on this side is therefore that every key the backend ever publishes is a
// member of the shared fixture's patchKeys (testdata/
// integrity-event-vectors.json). This test broadcasts a patch built from
// exactly the fixture keys — the same values the real call sites produce
// (room.go's integrity/answer/control broadcasts and main.go's BEK
// attestation notify) — and asserts it reaches the monitor unchanged.
func TestRoom_BroadcastMonitorUpdate_PublishesOnlyFixturePatchKeys(t *testing.T) {
	room, _ := newTestRoom(t, &fakeRoomStore{}, &fakeBuffer{}, &fakeFlusher{}, time.Minute)
	ts := newTestServer(t, room)

	monitor := dial(t, wsURL(ts.srv.URL, "/ws/monitor/exam-1"))
	if snap := readEnvelope(t, monitor); snap.Type != protocol.TypeMonitorSnapshot {
		t.Fatalf("got type %q, want monitor:snapshot", snap.Type)
	}

	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "testdata", "integrity-event-vectors.json"))
	if err != nil {
		t.Fatalf("read shared fixture: %v", err)
	}
	var fixture struct {
		PatchKeys []string `json:"patchKeys"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("parse shared fixture: %v", err)
	}
	if len(fixture.PatchKeys) == 0 {
		t.Fatal("fixture has no patchKeys")
	}
	allowed := make(map[string]bool, len(fixture.PatchKeys))
	for _, k := range fixture.PatchKeys {
		allowed[k] = true
	}

	want := map[string]any{
		"integrityEventCount": 4,
		"lastIntegrityEvent":  map[string]any{"kind": "TAB_HIDDEN", "detail": "", "at": "2026-08-13T12:00:00Z"},
		"lastSeenAt":          "2026-08-13T12:00:01Z",
		"status":              "IN_PROGRESS",
		"effectiveEndTime":    "2026-08-13T13:00:00Z",
		"timeExtensionMin":    5,
		"sebIntegrityFlagged": true,
		"sebIntegrityReason":  "bek_changed",
		"deviceReplacedCount": 1,
	}

	room.BroadcastMonitorUpdate("sess-1", want)

	// Normalize the expectation through the same JSON round-trip the wire
	// does: JSON numbers arrive as float64, so int literals in `want` would
	// never DeepEqual what the monitor received.
	// Normalize into a fresh map, never into `want`: BroadcastMonitorUpdate
	// hands the map to the room goroutine, which json.Marshal's it off the
	// test goroutine. Writing back into `want` here races that marshal
	// (caught by -race in CI) — ownership left the test at the call above.
	wantJSON, err := json.Marshal(want)
	if err != nil {
		t.Fatalf("marshal want patch: %v", err)
	}
	var normalized map[string]any
	if err := json.Unmarshal(wantJSON, &normalized); err != nil {
		t.Fatalf("unmarshal want patch: %v", err)
	}

	env := readEnvelope(t, monitor)
	if env.Type != protocol.TypeMonitorUpdate {
		t.Fatalf("got type %q, want monitor:update", env.Type)
	}
	var data protocol.MonitorUpdateData
	if err := json.Unmarshal(env.Data, &data); err != nil {
		t.Fatalf("unmarshal monitor update: %v", err)
	}
	for key := range data.Patch {
		if !allowed[key] {
			t.Errorf("published patch key %q is not in fixture patchKeys — either the fixture is stale or a call site publishes a new key; the client-side merge would silently drop it", key)
		}
	}
	if !reflect.DeepEqual(data.Patch, normalized) {
		t.Fatalf("patch changed in transit: got %v want %v", data.Patch, normalized)
	}
}
