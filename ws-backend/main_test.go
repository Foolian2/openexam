package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"openexam/ws-backend/internal/auth"
	"openexam/ws-backend/internal/config"
	"openexam/ws-backend/internal/store"
)

func TestWebSocketRoleAuthorization(t *testing.T) {
	tests := []struct {
		name      string
		role      string
		studentOK bool
		staffOK   bool
	}{
		{name: "student", role: "STUDENT", studentOK: true},
		{name: "teacher", role: "TEACHER", staffOK: true},
		{name: "admin", role: "ADMIN", staffOK: true},
		{name: "empty role", role: ""},
		{name: "unknown role", role: "OBSERVER"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := studentRoleAllowed(tc.role); got != tc.studentOK {
				t.Errorf("studentRoleAllowed(%q) = %v, want %v", tc.role, got, tc.studentOK)
			}
			if got := staffRoleAllowed(tc.role); got != tc.staffOK {
				t.Errorf("staffRoleAllowed(%q) = %v, want %v", tc.role, got, tc.staffOK)
			}
		})
	}
}

type mutableSessionLookup struct {
	mu        sync.Mutex
	userID    string
	role      string
	expiresAt time.Time
	err       error
}

func (s *mutableSessionLookup) LookupSession(context.Context, string) (string, string, string, time.Time, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return "auth-session-1", s.userID, s.role, s.expiresAt, s.err
}

func (s *mutableSessionLookup) set(userID, role string, expiresAt time.Time, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.userID, s.role, s.expiresAt, s.err = userID, role, expiresAt, err
}

func TestWatchSessionAuthorizationClosesRevokedSocket(t *testing.T) {
	tests := []struct {
		name         string
		requireStaff bool
		newState     func(*mutableSessionLookup)
	}{
		{
			name: "deleted token",
			newState: func(s *mutableSessionLookup) {
				s.set("", "", time.Time{}, nil)
			},
		},
		{
			name:         "staff role revoked",
			requireStaff: true,
			newState: func(s *mutableSessionLookup) {
				s.set("user-1", "STUDENT", time.Now().Add(time.Hour), nil)
			},
		},
		{
			name: "student role changed",
			newState: func(s *mutableSessionLookup) {
				s.set("user-1", "TEACHER", time.Now().Add(time.Hour), nil)
			},
		},
		{
			name: "lookup failure",
			newState: func(s *mutableSessionLookup) {
				s.set("user-1", "STUDENT", time.Now().Add(time.Hour), errors.New("database unavailable"))
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			lookup := &mutableSessionLookup{userID: "user-1", role: "STUDENT", expiresAt: time.Now().Add(time.Hour)}
			if tc.requireStaff {
				lookup.set("user-1", "TEACHER", time.Now().Add(time.Hour), nil)
			}
			sess := &auth.Session{Token: "opaque-token", UserID: "user-1", Role: lookup.role, ExpiresAt: time.Now().Add(time.Hour)}
			accepted := make(chan struct{})
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				serverConn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
				if err != nil {
					return
				}
				close(accepted)
				watchSessionAuthorization(r.Context(), serverConn, lookup, sess, tc.requireStaff, 10*time.Millisecond)
				_ = serverConn.CloseNow()
			}))
			defer srv.Close()

			conn, _, err := websocket.Dial(context.Background(), "ws"+srv.URL[len("http"):], nil)
			if err != nil {
				t.Fatalf("dial websocket: %v", err)
			}
			defer func() { _ = conn.CloseNow() }()
			select {
			case <-accepted:
			case <-time.After(time.Second):
				t.Fatal("server did not accept websocket")
			}
			tc.newState(lookup)

			readCtx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			_, _, err = conn.Read(readCtx)
			if err == nil {
				t.Fatal("socket remained open after authorization was revoked")
			}
			if got := websocket.CloseStatus(err); got != websocket.StatusPolicyViolation {
				t.Fatalf("close status = %v, want %v (error: %v)", got, websocket.StatusPolicyViolation, err)
			}
		})
	}
}

func TestWatchSessionAuthorizationEnforcesExpiryWithoutRecheck(t *testing.T) {
	expiresAt := time.Now().Add(40 * time.Millisecond)
	lookup := &mutableSessionLookup{userID: "user-1", role: "STUDENT", expiresAt: expiresAt}
	sess := &auth.Session{Token: "opaque-token", UserID: "user-1", ExpiresAt: expiresAt}
	accepted := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		serverConn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		close(accepted)
		watchSessionAuthorization(r.Context(), serverConn, lookup, sess, false, time.Hour)
		_ = serverConn.CloseNow()
	}))
	defer srv.Close()

	conn, _, err := websocket.Dial(context.Background(), "ws"+srv.URL[len("http"):], nil)
	if err != nil {
		t.Fatalf("dial websocket: %v", err)
	}
	defer func() { _ = conn.CloseNow() }()
	select {
	case <-accepted:
	case <-time.After(time.Second):
		t.Fatal("server did not accept websocket")
	}

	readCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, _, err = conn.Read(readCtx)
	if got := websocket.CloseStatus(err); got != websocket.StatusPolicyViolation {
		t.Fatalf("close status = %v, want %v (error: %v)", got, websocket.StatusPolicyViolation, err)
	}
}

// Mirrors the REST join gate in app/api/sessions/route.ts (exam.status must
// be ACTIVE) — the WS handshake must not accept a student an exam can no
// longer serve.
func TestStudentJoinAllowed(t *testing.T) {
	tests := []struct {
		name        string
		sessionSt   string
		examSt      string
		wantAllowed bool
	}{
		{name: "active exam, in-progress session", sessionSt: "IN_PROGRESS", examSt: "ACTIVE", wantAllowed: true},
		{name: "active exam, locked session still joins read-only", sessionSt: "LOCKED", examSt: "ACTIVE", wantAllowed: true},
		{name: "draft exam rejected", sessionSt: "IN_PROGRESS", examSt: "DRAFT", wantAllowed: false},
		{name: "published-but-not-active exam rejected", sessionSt: "IN_PROGRESS", examSt: "PUBLISHED", wantAllowed: false},
		{name: "closed exam rejected", sessionSt: "IN_PROGRESS", examSt: "CLOSED", wantAllowed: false},
		{name: "graded exam rejected", sessionSt: "IN_PROGRESS", examSt: "GRADED", wantAllowed: false},
		{name: "archived exam rejected", sessionSt: "IN_PROGRESS", examSt: "ARCHIVED", wantAllowed: false},
		{name: "active exam, submitted session rejected", sessionSt: "SUBMITTED", examSt: "ACTIVE", wantAllowed: false},
		{name: "active exam, auto-submitted session rejected", sessionSt: "AUTO_SUBMITTED", examSt: "ACTIVE", wantAllowed: false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := studentJoinAllowed(tc.sessionSt, tc.examSt); got != tc.wantAllowed {
				t.Errorf("studentJoinAllowed(%q, %q) = %v, want %v", tc.sessionSt, tc.examSt, got, tc.wantAllowed)
			}
		})
	}
}

// statusVectorFixture is the shared fixture
// testdata/session-status-vectors.json, also consumed by
// __tests__/session-state.test.ts. Keeping both sides reading the same file
// pins the Go handshake map and the TS predicates to one membership.
type statusVectorFixture struct {
	SubmitGraceMs int64 `json:"submitGraceMs"`
	Statuses      []struct {
		Status         string `json:"status"`
		Open           bool   `json:"open"`
		SocketJoinable bool   `json:"socketJoinable"`
		Active         bool   `json:"active"`
		Submitted      bool   `json:"submitted"`
	} `json:"statuses"`
}

func loadStatusVectors(t *testing.T) statusVectorFixture {
	t.Helper()
	raw, err := os.ReadFile("../testdata/session-status-vectors.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var f statusVectorFixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	if len(f.Statuses) == 0 {
		t.Fatal("fixture has no status vectors")
	}
	return f
}

// TestStudentJoinAllowedFixture pins studentAcceptableStatuses to the shared
// fixture: every socketJoinable status must be joinable, every other status
// must not be.
func TestStudentJoinAllowedFixture(t *testing.T) {
	f := loadStatusVectors(t)
	for _, v := range f.Statuses {
		got := studentJoinAllowed(v.Status, "ACTIVE")
		if got != v.SocketJoinable {
			t.Errorf("studentJoinAllowed(%q, ACTIVE) = %v, want %v (fixture)", v.Status, got, v.SocketJoinable)
		}
	}
}

// TestSubmitGraceFixture pins the ws-backend's grace constant to the shared
// fixture's submitGraceMs.
func TestSubmitGraceFixture(t *testing.T) {
	f := loadStatusVectors(t)
	t.Setenv("DATABASE_URL", "postgresql://x:x@localhost:5432/x")
	t.Setenv("BETTER_AUTH_SECRET", "test-secret")
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	if cfg.SubmitGraceMillis != f.SubmitGraceMs {
		t.Errorf("SubmitGraceMillis = %d, want %d (fixture)", cfg.SubmitGraceMillis, f.SubmitGraceMs)
	}
}

// Mirrors the table in __tests__/seb-guard.test.ts. The two implementations
// guard the same rule on different transports (REST vs the WS handshake), so
// they must agree row for row.
func TestSebIntegrityDecision(t *testing.T) {
	str := func(s string) *string { return &s }
	now := time.Now()

	tests := []struct {
		name       string
		session    store.ExamSessionAuth
		presented  string
		wantAction sebAttestAction
		wantReason string
	}{
		{
			name:       "nothing bound, none presented: degrade silently",
			session:    store.ExamSessionAuth{},
			presented:  "",
			wantAction: sebNoop,
		},
		{
			name:       "nothing bound, one presented: bind it",
			session:    store.ExamSessionAuth{},
			presented:  "bek-aaa",
			wantAction: sebBind,
		},
		{
			name:       "empty string treated as unbound, not as a value",
			session:    store.ExamSessionAuth{SebBrowserExamKey: str("")},
			presented:  "bek-aaa",
			wantAction: sebBind,
		},
		{
			name:       "bound and matching: no write",
			session:    store.ExamSessionAuth{SebBrowserExamKey: str("bek-aaa")},
			presented:  "bek-aaa",
			wantAction: sebNoop,
		},
		{
			name:       "bound and changed: flag",
			session:    store.ExamSessionAuth{SebBrowserExamKey: str("bek-aaa")},
			presented:  "bek-bbb",
			wantAction: sebFlag,
			wantReason: "bek_changed",
		},
		{
			name:       "bound and vanished: flag",
			session:    store.ExamSessionAuth{SebBrowserExamKey: str("bek-aaa")},
			presented:  "",
			wantAction: sebFlag,
			wantReason: "bek_disappeared",
		},
		{
			name: "already flagged: never flag twice",
			session: store.ExamSessionAuth{
				SebBrowserExamKey:     str("bek-aaa"),
				SebIntegrityFlaggedAt: &now,
			},
			presented:  "bek-bbb",
			wantAction: sebNoop,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			action, reason := sebIntegrityDecision(&tc.session, tc.presented)
			if action != tc.wantAction {
				t.Errorf("action = %v, want %v", action, tc.wantAction)
			}
			if reason != tc.wantReason {
				t.Errorf("reason = %q, want %q", reason, tc.wantReason)
			}
		})
	}
}

// TestSebIntegrityDecision_SharedVectors pins sebIntegrityDecision to the
// same fixture table __tests__/seb-token-vectors.test.ts runs against
// lib/seb-guard.ts's decideBekAction. The TS side guards the REST transport,
// this one the WS handshake; the shared fixture is what stops the decision
// rule drifting apart between languages.
func TestSebIntegrityDecision_SharedVectors(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "testdata", "seb-token-vectors.json"))
	if err != nil {
		t.Fatalf("read shared vectors: %v", err)
	}
	var fixture struct {
		BekVectors []struct {
			Name           string  `json:"name"`
			Bound          *string `json:"bound"`
			Presented      string  `json:"presented"`
			AlreadyFlagged bool    `json:"alreadyFlagged"`
			Action         string  `json:"action"`
			Reason         *string `json:"reason"`
		} `json:"bekVectors"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("parse shared vectors: %v", err)
	}
	if len(fixture.BekVectors) == 0 {
		t.Fatal("shared vector file has no bekVectors")
	}

	wantAction := func(action string) sebAttestAction {
		switch action {
		case "noop":
			return sebNoop
		case "bind":
			return sebBind
		case "flag":
			return sebFlag
		default:
			t.Fatalf("unknown action %q in fixture", action)
			return sebNoop
		}
	}

	for _, v := range fixture.BekVectors {
		t.Run(v.Name, func(t *testing.T) {
			var flaggedAt *time.Time
			if v.AlreadyFlagged {
				now := time.Now()
				flaggedAt = &now
			}
			session := store.ExamSessionAuth{
				SebBrowserExamKey:     v.Bound,
				SebIntegrityFlaggedAt: flaggedAt,
			}
			action, reason := sebIntegrityDecision(&session, v.Presented)
			if action != wantAction(v.Action) {
				t.Errorf("action = %v, want %v", action, v.Action)
			}
			wantReason := ""
			if v.Reason != nil {
				wantReason = *v.Reason
			}
			if reason != wantReason {
				t.Errorf("reason = %q, want %q", reason, wantReason)
			}
		})
	}
}

// TestSebAuthDecision covers the pure half of the first-message SEB
// handshake. It mirrors the table in __tests__/seb-guard.test.ts: both
// transports must agree on when a handshake is rejected, when it binds the
// session's first-seen values, and when it accepts against bound values.
func TestSebAuthDecision(t *testing.T) {
	str := func(s string) *string { return &s }
	const expected = "expected-token"

	tests := []struct {
		name       string
		session    store.ExamSessionAuth
		tokens     []string
		token      string
		identity   string
		ua         string
		wantAction sebAuthAction
		wantReason string
	}{
		{
			name:       "config key never persisted: fail closed",
			session:    store.ExamSessionAuth{},
			token:      expected,
			ua:         "SEB/3.6.0",
			wantAction: sebAuthReject,
			wantReason: "seb_not_configured",
		},
		{
			name:       "empty token: fail closed",
			session:    store.ExamSessionAuth{SebConfigKey: str("ck")},
			token:      "",
			ua:         "SEB/3.6.0",
			wantAction: sebAuthReject,
			wantReason: "missing_token",
		},
		{
			name:       "token mismatch: fail closed",
			session:    store.ExamSessionAuth{SebConfigKey: str("ck")},
			token:      "junk",
			ua:         "SEB/3.6.0",
			wantAction: sebAuthReject,
			wantReason: "invalid_token",
		},
		{
			name:       "first sighting binds",
			session:    store.ExamSessionAuth{SebConfigKey: str("ck")},
			token:      expected,
			ua:         "SEB/3.6.0",
			wantAction: sebAuthBind,
		},
		{
			// Mirrors lib/seb-guard.ts's two-candidate check: Windows SEB
			// presents the per-request-URL token, so the handshake must
			// accept it alongside the take-page token.
			name:       "first sighting with per-request-URL token binds",
			session:    store.ExamSessionAuth{SebConfigKey: str("ck")},
			tokens:     []string{expected, "per-url-token"},
			token:      "per-url-token",
			ua:         "SEB/3.6.0",
			wantAction: sebAuthBind,
		},
		{
			name: "bound, same token and UA: accept",
			session: store.ExamSessionAuth{
				SebConfigKey: str("ck"),
				SebKeyHash:   str(expected),
				SebUserAgent: str("SEB/3.6.0"),
			},
			token:      expected,
			ua:         "SEB/3.6.0",
			wantAction: sebAuthAccept,
		},
		{
			name: "bound, different token: reject",
			session: store.ExamSessionAuth{
				SebConfigKey: str("ck"),
				SebKeyHash:   str(expected),
				SebUserAgent: str("SEB/3.6.0"),
			},
			token:      "someone-elses-token",
			ua:         "SEB/3.6.0",
			wantAction: sebAuthReject,
			wantReason: "invalid_token",
		},
		{
			// A valid candidate that isn't the bound hash is still a
			// mismatch: the bind is what pins the session's token.
			name: "bound, valid candidate but not the bound hash: reject",
			session: store.ExamSessionAuth{
				SebConfigKey: str("ck"),
				SebKeyHash:   str(expected),
				SebUserAgent: str("SEB/3.6.0"),
			},
			tokens:     []string{expected, "per-url-token"},
			token:      "per-url-token",
			ua:         "SEB/3.6.0",
			wantAction: sebAuthReject,
			wantReason: "key_mismatch",
		},
		{
			name: "bound, UA switched to a plain browser: reject",
			session: store.ExamSessionAuth{
				SebConfigKey: str("ck"),
				SebKeyHash:   str(expected),
				SebUserAgent: str("SEB/3.6.0"),
			},
			token:      expected,
			ua:         "Mozilla/5.0",
			wantAction: sebAuthReject,
			wantReason: "ua_mismatch",
		},
		{
			// The Windows regression. SEB hashes per URL, so the token
			// presented on the WS upgrade differs from the take-page token
			// bound earlier — comparing the raw token rejected every Windows
			// client mid-exam. The identity token is URL-independent, so the
			// same session now authorizes.
			name: "bound take-page identity, per-URL token on the WS upgrade: accept",
			session: store.ExamSessionAuth{
				SebConfigKey: str("ck"),
				SebKeyHash:   str(expected),
				SebUserAgent: str("SEB/3.6.0"),
			},
			tokens:     []string{expected, "per-url-token"},
			token:      "per-url-token",
			identity:   expected,
			ua:         "SEB/3.6.0",
			wantAction: sebAuthAccept,
		},
		{
			// Same shape, but the identity belongs to a different config —
			// which is the switch the binding exists to catch.
			name: "per-URL token valid but identity differs from the bound one: reject",
			session: store.ExamSessionAuth{
				SebConfigKey: str("ck"),
				SebKeyHash:   str(expected),
				SebUserAgent: str("SEB/3.6.0"),
			},
			tokens:     []string{expected, "per-url-token"},
			token:      "per-url-token",
			identity:   "some-other-configs-identity",
			ua:         "SEB/3.6.0",
			wantAction: sebAuthReject,
			wantReason: "key_mismatch",
		},
		{
			// Only the personalized key is set: a session that fetched an
			// auto-login config for an exam whose own key was never frozen.
			name: "session-level config key alone authorizes",
			session: store.ExamSessionAuth{
				SessionSebConfigKey: str("session-ck"),
			},
			token:      expected,
			ua:         "SEB/3.6.0",
			wantAction: sebAuthBind,
		},
		{
			// seb-config/route.ts clears SebKeyHash when it rotates a
			// session's personalized key, so SEB can rebind after a relaunch.
			// Mirrors lib/seb-guard.ts: the rebind must come from the UA
			// already on record.
			name: "rebind after key rotation with the same UA: bind",
			session: store.ExamSessionAuth{
				SebConfigKey:        str("ck"),
				SessionSebConfigKey: str("session-ck"),
				SebUserAgent:        str("SEB/3.6.0"),
			},
			token:      expected,
			ua:         "SEB/3.6.0",
			wantAction: sebAuthBind,
		},
		{
			name: "rebind after key rotation from a different UA: reject",
			session: store.ExamSessionAuth{
				SebConfigKey:        str("ck"),
				SessionSebConfigKey: str("session-ck"),
				SebUserAgent:        str("SEB/3.6.0"),
			},
			token:      expected,
			ua:         "Mozilla/5.0",
			wantAction: sebAuthReject,
			wantReason: "ua_mismatch",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			tokens := tc.tokens
			if tokens == nil {
				tokens = []string{expected}
			}
			// Default identity to the presented token: that is what the old
			// take-page-only model effectively did, so every pre-existing case
			// keeps asserting exactly what it asserted before.
			identity := tc.identity
			if identity == "" {
				identity = tc.token
			}
			action, reason := sebAuthDecision(&tc.session, tokens, identity, tc.token, tc.ua)
			if action != tc.wantAction {
				t.Errorf("action = %v, want %v", action, tc.wantAction)
			}
			if reason != tc.wantReason {
				t.Errorf("reason = %q, want %q", reason, tc.wantReason)
			}
		})
	}
}

// watchOnce runs the watchdog against lookup with a fast recheck interval and
// returns the client side of the socket.
func watchOnce(t *testing.T, lookup *mutableSessionLookup) (*websocket.Conn, func()) {
	t.Helper()
	sess := &auth.Session{Token: "opaque-token", UserID: "user-1", Role: "STUDENT", ExpiresAt: time.Now().Add(time.Hour)}
	accepted := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		serverConn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		close(accepted)
		watchSessionAuthorization(r.Context(), serverConn, lookup, sess, false, 20*time.Millisecond)
		_ = serverConn.CloseNow()
	}))
	conn, _, err := websocket.Dial(context.Background(), "ws"+srv.URL[len("http"):], nil)
	if err != nil {
		srv.Close()
		t.Fatalf("dial websocket: %v", err)
	}
	select {
	case <-accepted:
	case <-time.After(time.Second):
		t.Fatal("server did not accept websocket")
	}
	return conn, func() { _ = conn.CloseNow(); srv.Close() }
}

// sequencedLookup answers each call from a script, then repeats the last entry.
type sequencedLookup struct {
	mutableSessionLookup
	errs []error
	n    int
}

func (s *sequencedLookup) LookupSession(ctx context.Context, token string) (string, string, string, time.Time, error) {
	s.mu.Lock()
	i := s.n
	if i >= len(s.errs) {
		i = len(s.errs) - 1
	}
	s.n++
	err := s.errs[i]
	s.mu.Unlock()
	if err != nil {
		return "", "", "", time.Time{}, err
	}
	return "auth-session-1", "user-1", "STUDENT", time.Now().Add(time.Hour), nil
}

func TestWatchSessionAuthorizationToleratesOneTransientFailure(t *testing.T) {
	blip := errors.New("database unavailable")
	lookup := &sequencedLookup{errs: []error{blip, nil, blip, nil}}
	sess := &auth.Session{Token: "opaque-token", UserID: "user-1", Role: "STUDENT", ExpiresAt: time.Now().Add(time.Hour)}
	accepted := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		serverConn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		close(accepted)
		watchSessionAuthorization(r.Context(), serverConn, lookup, sess, false, 20*time.Millisecond)
		_ = serverConn.CloseNow()
	}))
	defer srv.Close()
	conn, _, err := websocket.Dial(context.Background(), "ws"+srv.URL[len("http"):], nil)
	if err != nil {
		t.Fatalf("dial websocket: %v", err)
	}
	defer func() { _ = conn.CloseNow() }()
	<-accepted

	// Isolated blips separated by successful rechecks never close the socket.
	readCtx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	if _, _, err := conn.Read(readCtx); websocket.CloseStatus(err) != -1 {
		t.Fatalf("socket closed after isolated transient failures: %v", err)
	}
}

func TestWatchSessionAuthorizationClosesAfterTwoConsecutiveFailures(t *testing.T) {
	lookup := &mutableSessionLookup{}
	lookup.set("user-1", "STUDENT", time.Now().Add(time.Hour), errors.New("database unavailable"))
	conn, done := watchOnce(t, lookup)
	defer done()
	start := time.Now()
	readCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, _, err := conn.Read(readCtx)
	if got := websocket.CloseStatus(err); got != websocket.StatusPolicyViolation {
		t.Fatalf("close status = %v, want %v (error: %v)", got, websocket.StatusPolicyViolation, err)
	}
	if elapsed := time.Since(start); elapsed < 30*time.Millisecond {
		t.Fatalf("closed after %v, before a second recheck could run", elapsed)
	}
}

func TestWatchSessionAuthorizationClosesRevokedTokenImmediately(t *testing.T) {
	lookup := &mutableSessionLookup{}
	lookup.set("", "", time.Time{}, store.ErrNotFound)
	conn, done := watchOnce(t, lookup)
	defer done()
	readCtx, cancel := context.WithTimeout(context.Background(), 35*time.Millisecond)
	defer cancel()
	_, _, err := conn.Read(readCtx)
	if got := websocket.CloseStatus(err); got != websocket.StatusPolicyViolation {
		t.Fatalf("revoked token not closed on the first recheck: status %v (error: %v)", got, err)
	}
}

func TestActiveDeviceAllowed(t *testing.T) {
	claimed := "auth-1"
	device := "device-1"
	empty := ""
	cases := []struct {
		name         string
		activeAuth   *string
		activeDevice *string
		login        string
		device       string
		want         bool
	}{
		{"unclaimed admits any login", nil, nil, "auth-2", "device-2", true},
		{"empty counts as unclaimed", &empty, &empty, "auth-2", "device-2", true},
		{"legacy tab claim allows new tab", &claimed, nil, "auth-1", "device-2", true},
		{"claiming login and tab", &claimed, &device, "auth-1", "device-1", true},
		{"replaced login", &claimed, &device, "auth-2", "device-1", false},
		{"replaced tab", &claimed, &device, "auth-1", "device-2", false},
		{"missing tab", &claimed, &device, "auth-1", "", false},
	}
	for _, tc := range cases {
		if got := activeDeviceAllowed(tc.activeAuth, tc.activeDevice, tc.login, tc.device); got != tc.want {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestRequestedDeviceID(t *testing.T) {
	for _, tc := range []struct {
		query string
		want  string
		ok    bool
	}{
		{"", "", true},
		{"?deviceId=550e8400-e29b-41d4-a716-446655440000", "550e8400-e29b-41d4-a716-446655440000", true},
		{"?deviceId=", "", false},
		{"?deviceId=anything", "", false},
		{"?deviceId=550e8400-e29b-41d4-a716-446655440000&deviceId=550e8400-e29b-41d4-a716-446655440001", "", false},
	} {
		r := httptest.NewRequest(http.MethodGet, "/ws/exam/s"+tc.query, nil)
		got, ok := requestedDeviceID(r)
		if got != tc.want || ok != tc.ok {
			t.Errorf("query %q: got (%q, %v), want (%q, %v)", tc.query, got, ok, tc.want, tc.ok)
		}
	}
}
