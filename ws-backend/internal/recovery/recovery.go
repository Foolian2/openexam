// Package recovery gives every long-lived goroutine a way to survive a
// panic instead of taking the whole process down with it.
//
// Before this package existed, ws-backend had zero panic recovery anywhere
// (confirmed: no `recover()` call in the codebase) — a panic in any one
// room's goroutine, write pump, or offloaded flush crashed the entire
// server, taking down every other room's students and monitors with it.
package recovery

import (
	"log/slog"

	"github.com/getsentry/sentry-go"
)

// Guard recovers a panic in the calling goroutine, logs it, and reports it
// to GlitchTip (a no-op if SENTRY_DSN was never configured — see main.go).
// Call it as the first `defer` in any goroutine meant to run for the
// lifetime of a room or connection:
//
//	go func() {
//	    defer recovery.Guard(log, "room run loop")
//	    r.run(ctx)
//	}()
func Guard(log *slog.Logger, where string) {
	if r := recover(); r != nil {
		log.Error("recovered from panic", "where", where, "panic", r)
		sentry.CurrentHub().Recover(r)
	}
}
