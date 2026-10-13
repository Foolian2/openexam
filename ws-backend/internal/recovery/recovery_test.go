package recovery

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
)

func newLogger() (*slog.Logger, *bytes.Buffer) {
	var buf bytes.Buffer
	return slog.New(slog.NewTextHandler(&buf, nil)), &buf
}

// Runs fn in its own goroutine, the way production code uses Guard, and
// waits for it. A panic that Guard failed to recover would crash the test
// binary rather than fail this test, which is the behavior under test.
func runGuarded(log *slog.Logger, where string, fn func()) {
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer Guard(log, where)
		fn()
	}()
	<-done
}

func TestGuardRecoversAndLogsPanic(t *testing.T) {
	log, buf := newLogger()

	runGuarded(log, "room run loop", func() { panic("boom") })

	out := buf.String()
	for _, want := range []string{
		"level=ERROR",
		`msg="recovered from panic"`,
		`where="room run loop"`,
		"panic=boom",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("log %q missing %q", out, want)
		}
	}
}

func TestGuardRecoversRuntimeError(t *testing.T) {
	log, buf := newLogger()

	var items []int
	idx := len(items)
	runGuarded(log, "write pump", func() {
		_ = items[idx] // index out of range at runtime
	})

	if !strings.Contains(buf.String(), "index out of range") {
		t.Errorf("log %q missing the runtime error", buf.String())
	}
}

func TestGuardIsSilentWithoutPanic(t *testing.T) {
	log, buf := newLogger()

	ran := false
	runGuarded(log, "flush", func() { ran = true })

	if !ran {
		t.Fatal("guarded function did not run")
	}
	if buf.Len() != 0 {
		t.Errorf("expected no log output, got %q", buf.String())
	}
}
