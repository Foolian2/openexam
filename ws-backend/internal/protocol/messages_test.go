package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestIntegrityEventKindsPin pins the runtime allow-list to the shared
// fixture testdata/integrity-event-vectors.json, which is also read by
// __tests__/integrity-event-contract.test.ts. The fixture's kinds must be
// exactly the DB enum members (prisma/schema.prisma IntegrityEventKind) —
// that enum is the source of truth, this map is the runtime gate that backs
// it up on the WS path, and the TS types/labels are derived from the same
// enum. Any of them drifting apart turns one of the two suites red.
func TestIntegrityEventKindsPin(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "testdata", "integrity-event-vectors.json"))
	if err != nil {
		t.Fatalf("read shared fixture: %v", err)
	}
	var fixture struct {
		Kinds []string `json:"kinds"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("parse shared fixture: %v", err)
	}
	if len(fixture.Kinds) == 0 {
		t.Fatal("fixture has no kinds")
	}

	if len(IntegrityEventKinds) != len(fixture.Kinds) {
		t.Fatalf("IntegrityEventKinds has %d kinds, fixture has %d — the allow-list and the DB enum must be exactly the same set",
			len(IntegrityEventKinds), len(fixture.Kinds))
	}
	for _, kind := range fixture.Kinds {
		if !IntegrityEventKinds[kind] {
			t.Errorf("IntegrityEventKinds is missing %q — add it to messages.go and to the IntegrityEventKind DB enum", kind)
		}
	}
}
