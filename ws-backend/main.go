// Command ws-backend is OpenExam's Go WebSocket server: realtime answer
// sync, timer/control broadcasts, and live exam monitoring alongside the
// Next.js REST API.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/coder/websocket"
	"github.com/getsentry/sentry-go"
	sentryhttp "github.com/getsentry/sentry-go/http"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/go-redis/v9"

	"openexam/ws-backend/internal/auth"
	"openexam/ws-backend/internal/config"
	"openexam/ws-backend/internal/hub"
	"openexam/ws-backend/internal/metrics"
	"openexam/ws-backend/internal/protocol"
	"openexam/ws-backend/internal/ratelimit"
	"openexam/ws-backend/internal/seb"
	"openexam/ws-backend/internal/store"
)

func main() {
	// Docker HEALTHCHECK probe (the distroless runtime image has no shell or
	// curl): GET /healthz on ourselves and exit 0/1 accordingly. Returns
	// before any config load or connection setup, so it can't emit side
	// effects.
	if len(os.Args) > 1 && os.Args[1] == "-healthcheck" {
		os.Exit(healthcheck())
	}

	// JSON, not text: makes `docker logs ws-backend` greppable/jq-able by a
	// log aggregator instead of a fixed-width text format meant for a
	// terminal.
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	cfg, err := config.Load()
	if err != nil {
		log.Error("config", "error", err)
		os.Exit(1)
	}

	// GlitchTip (self-hosted, Sentry-protocol-compatible) error reporting.
	// A no-op client when SentryDSN is empty (monitoring stack not
	// deployed — scripts/setup-monitoring.sh is opt-in), so sentry.CaptureException
	// / recovery.Guard calls elsewhere are safe regardless of whether this
	// ran.
	if cfg.SentryDSN != "" {
		if err := sentry.Init(sentry.ClientOptions{
			Dsn:              cfg.SentryDSN,
			EnableTracing:    false,
			AttachStacktrace: true,
		}); err != nil {
			log.Error("sentry init failed", "error", err)
		}
		defer sentry.Flush(2 * time.Second)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Error("failed to connect to postgres", "error", err)
		os.Exit(1)
	}
	defer pool.Close()

	rdb := redis.NewClient(mustParseRedisURL(cfg.RedisURL, log))
	defer func() { _ = rdb.Close() }()

	st := store.New(pool)
	buf := store.NewBuffer(rdb)
	flusher := store.NewFlusher(rdb, st, cfg.FlushInterval, log)

	h := hub.New(rdb, st, buf, flusher, cfg.RoomIdleTimeout, time.Duration(cfg.SubmitGraceMillis)*time.Millisecond, log)

	go h.SubscribeControl(ctx)

	flusherCtx, flusherCancel := context.WithCancel(context.Background())
	flusherDone := make(chan struct{})
	go func() {
		flusher.Run(flusherCtx)
		close(flusherDone)
	}()

	srv := &http.Server{
		Addr:    ":" + cfg.Port,
		Handler: newMux(cfg, log, st, h, rdb),
		// No timeouts before meant an unauthenticated client could hold the
		// handshake open forever by trickling bytes (slowloris), pinning a
		// goroutine + fd per connection. websocket.Accept hijacks the
		// connection, so these deadlines stop applying once the upgrade
		// happens — long-lived WS connections are unaffected.
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	// shutdownDone signals once the hub and flusher have fully drained, so
	// main doesn't let its deferred pool.Close()/rdb.Close() run out from
	// under a still-in-progress final flush (ListenAndServe unblocks as
	// soon as srv.Shutdown closes the listener, which is well before the
	// hub/flusher below are done — a prior version returned from main and
	// closed Redis/Postgres while the flusher's final flush was still
	// trying to use them).
	shutdownDone := make(chan struct{})
	go func() {
		<-ctx.Done()
		log.Info("shutting down")

		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)

		// Must exceed the offloaded force-flush budget (15s in
		// Room.offloadFlush): Shutdown also drains those goroutines, and
		// giving up early would close the pools out from under an in-flight
		// flush.
		h.Shutdown(20 * time.Second)

		flusherCancel()
		<-flusherDone
		close(shutdownDone)
	}()

	log.Info("ws-backend listening", "port", cfg.Port)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("server error", "error", err)
		os.Exit(1)
	}
	<-shutdownDone
}

func mustParseRedisURL(raw string, log *slog.Logger) *redis.Options {
	opts, err := redis.ParseURL(raw)
	if err != nil {
		log.Error("invalid REDIS_URL", "error", err)
		os.Exit(1)
	}
	return opts
}

func healthcheck() int {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/healthz")
	if err != nil {
		return 1
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusOK {
		return 0
	}
	return 1
}

func newMux(cfg *config.Config, log *slog.Logger, st *store.Store, h *hub.Hub, rdb *redis.Client) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	// Runtime counters for load-test telemetry. Deliberately separate from /healthz so the
	// liveness response stays a fixed "ok" body, and deliberately not a
	// Prometheus exporter — the benchmark target is a small VPS and this
	// costs one goroutine-free ReadMemStats per second.
	//
	// goroutines is the leak signal: the hub runs one goroutine per room, plus
	// one more per room for its async I/O worker (internal/hub/async.go),
	// plus reader/writer pairs per client (internal/hub/hub.go) — so after a
	// run drains it should return to its idle baseline. Not published by
	// docker-compose; reachable only on the internal network.
	mux.HandleFunc("GET /debugz", func(w http.ResponseWriter, r *http.Request) {
		var m runtime.MemStats
		runtime.ReadMemStats(&m)

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"goroutines":   runtime.NumGoroutine(),
			"heap_alloc":   m.HeapAlloc,
			"heap_sys":     m.Sys,
			"heap_objects": m.HeapObjects,
			"gc_pause_ns":  m.PauseTotalNs,
			"num_gc":       m.NumGC,
		})
	})

	// Prometheus scrape target. Not a docker-compose `ports:` entry (only
	// nginx publishes any port — see /debugz's comment above), reachable
	// only over the internal Docker network, same reachability as /debugz.
	mux.Handle("GET /metrics", promhttp.HandlerFor(metrics.Registry, promhttp.HandlerOpts{}))

	mux.HandleFunc("GET /ws/exam/{sessionId}", studentHandler(cfg, log, st, h, rdb))
	mux.HandleFunc("GET /ws/monitor/{examId}", monitorHandler(cfg, log, st, h))

	// Recovers any panic that escapes a handler (there is otherwise no
	// recover() anywhere on the request path) and reports it to GlitchTip;
	// a no-op wrapper when SentryDSN is unset, since sentry.Init was never
	// called.
	return sentryhttp.New(sentryhttp.Options{Repanic: false}).Handle(mux)
}

// studentAcceptableStatuses are the ExamSession states a WS connection may
// join in: IN_PROGRESS to take the exam, LOCKED read-only so a locked
// student still receives the unlock event. Pinned to the shared fixture in
// testdata/session-status-vectors.json via TestStudentJoinAllowed.
var studentAcceptableStatuses = map[string]bool{
	"IN_PROGRESS": true,
	"LOCKED":      true,
}

// studentJoinAllowed is the WS handshake's join gate. The exam must be ACTIVE
// — mirroring the REST join route (app/api/sessions/route.ts) and the take
// page's redirect, so a closed/graded/archived exam can't be joined through
// the socket — and the session itself must be in a status that may be joined.
// A LOCKED session under an ACTIVE exam still connects read-only, so the
// unlock event can still reach it.
func studentJoinAllowed(sessionStatus, examStatus string) bool {
	return examStatus == "ACTIVE" && studentAcceptableStatuses[sessionStatus]
}

func studentRoleAllowed(role string) bool { return role == "STUDENT" }

func staffRoleAllowed(role string) bool { return role == "TEACHER" || role == "ADMIN" }

func studentHandler(cfg *config.Config, log *slog.Logger, st *store.Store, h *hub.Hub, rdb *redis.Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sessionID := r.PathValue("sessionId")
		deviceID, validDeviceID := requestedDeviceID(r)
		if !validDeviceID {
			http.Error(w, "invalid deviceId", http.StatusBadRequest)
			return
		}

		sess, err := auth.ValidateRequest(r.Context(), r, cfg.BetterAuthSecret, st)
		if err != nil || !studentRoleAllowed(sess.Role) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		examSession, err := st.GetExamSessionAuth(r.Context(), sessionID)
		if err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		if examSession.UserID != sess.UserID {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if !studentJoinAllowed(examSession.Status, examSession.ExamStatus) {
			http.Error(w, "session not active", http.StatusConflict)
			return
		}

		if examSession.SebRequired {
			// Throttle repeated handshake attempts before spending a DB round
			// trip on sebHandshake — bounds scripted token/UA guessing
			// against the SEB guard, the same way the REST session routes are
			// throttled on the Next.js side.
			if !ratelimit.Allow(r.Context(), rdb, "ws-seb:"+sess.UserID, 30, 60) {
				http.Error(w, "too many requests", http.StatusTooManyRequests)
				return
			}
		}

		// Read before Accept: the SEB handshake needs it, and the header is
		// most usefully captured while it is guaranteed un-tampered with.
		ua := r.Header.Get("User-Agent")
		ip := clientIP(r)

		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: cfg.AllowedOrigins})
		if err != nil {
			log.Error("websocket accept failed", "sessionId", sessionID, "error", err)
			return
		}

		// Another login owns this session (lib/exam-device.ts). Refused
		// after Accept rather than with an HTTP status, which a browser
		// WebSocket never exposes: the client needs the control event to
		// stop reconnecting and show its takeover screen.
		if !activeDeviceAllowed(examSession.ActiveAuthSessionID, examSession.ActiveDeviceID, sess.ID, deviceID) {
			sessionReplacedClose(r.Context(), conn, sessionID)
			return
		}

		if examSession.SebRequired {
			// Browsers cannot set custom headers on a WebSocket handshake, so
			// the SEB tokens travel as the connection's first message instead
			// of — as they used to — the URL's query string, where reverse
			// proxies and access logs would record them. Nothing is
			// registered with the room until the handshake message has been
			// verified; a failed handshake writes an error envelope and
			// closes the socket.
			if !sebHandshake(r.Context(), cfg, log, st, h, conn, r, examSession, sess.UserID, ua, ip) {
				return
			}
			// The handshake can take up to sebAuthTimeout, and a takeover
			// committed meanwhile publishes its control event before this
			// socket is in the room to receive it. Re-read ownership so
			// the room registers this socket with a current claim version.
			fresh, err := st.GetExamSessionAuth(r.Context(), sessionID)
			if err != nil || !studentJoinAllowed(fresh.Status, fresh.ExamStatus) {
				_ = conn.Close(websocket.StatusPolicyViolation, "session not active")
				return
			}
			if !activeDeviceAllowed(fresh.ActiveAuthSessionID, fresh.ActiveDeviceID, sess.ID, deviceID) {
				sessionReplacedClose(r.Context(), conn, sessionID)
				return
			}
			examSession = fresh
		}

		client := hub.NewStudentClient(conn, sess.UserID, sessionID, sess.ID, log)
		client.SetDeviceID(deviceID)
		room := h.JoinRoom(examSession.ExamID, client, examSession)
		if room == nil {
			// e.g. hub shutdown raced the join; nothing can serve this
			// connection, so close it rather than leave it connected but
			// unregistered (no timer:sync, no control events).
			_ = client.Conn().Close(websocket.StatusInternalError, "room unavailable")
			return
		}
		_ = st.IncrementReconnectCount(r.Context(), sessionID)

		runConnWithSession(room, client, st, sess, false)
	}
}

// sebIntegrityDenialReasons are the denial reasons that indicate a
// hijacked/cloned session (the bound token or UA no longer matches), mirroring
// SEB_INTEGRITY_DENIAL_REASONS in lib/seb-guard.ts — kept as a distinct audit
// action so the audit UI can filter for the signal that actually matters
// without parsing metadata.
var sebIntegrityDenialReasons = map[string]bool{"key_mismatch": true, "ua_mismatch": true}

// clientIP mirrors lib/client-ip.ts: nginx is the single edge proxy in
// production and overwrites both headers with $remote_addr, so the first
// X-Forwarded-For entry (or X-Real-Ip) is the client's real address, not
// something the client can forge. Both are empty in local dev.
func clientIP(r *http.Request) *string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if first := strings.TrimSpace(strings.SplitN(xff, ",", 2)[0]); first != "" {
			return &first
		}
	}
	if ip := strings.TrimSpace(r.Header.Get("X-Real-Ip")); ip != "" {
		return &ip
	}
	return nil
}

// logSebWsDenial audit-logs a WS handshake denial directly against Postgres
// (rather than routed through the Next.js API) so it lands in the same
// AuditLog table lib/audit.ts writes to, on the same latency budget
// BindSebSession already pays.
func logSebWsDenial(ctx context.Context, log *slog.Logger, st *store.Store, examSession *store.ExamSessionAuth, userID string, ip *string, ua, reason string) {
	action := "SEB_ACCESS_DENIED"
	if sebIntegrityDenialReasons[reason] {
		action = "SEB_INTEGRITY_DENIED"
	}
	log.Warn("seb access denied", "sessionId", examSession.ID, "reason", reason)
	if err := st.CreateAuditLog(ctx, store.AuditLogParams{
		Action:     action,
		EntityType: "ExamSession",
		EntityID:   examSession.ID,
		UserID:     &userID,
		ExamID:     &examSession.ExamID,
		Metadata:   map[string]any{"reason": reason},
		IPAddress:  ip,
		UserAgent:  &ua,
	}); err != nil {
		log.Error("failed to audit-log seb denial", "sessionId", examSession.ID, "error", err)
	}
}

// sebAuthTimeout bounds how long the server waits for the first-message SEB
// handshake before closing the connection. The client resolves the Config
// Key through SEB's JS API before connecting, so the message should be
// effectively immediate; ten seconds is generous enough for a slow first
// page load without letting unauthenticated sockets pin resources.
const sebAuthTimeout = 10 * time.Second

// sebWriteTimeout bounds each handshake reply write so a stalled peer can't
// hold the handler goroutine beyond the timeout.
const sebWriteTimeout = 5 * time.Second

// sebAuthEnvelope is the first WebSocket message a student client sends when
// the exam requires SEB. It mirrors what lib/seb-client.ts attaches to REST
// requests as headers, and the values it carries are the same ones that used
// to travel as ?sebKey=/&bekKey= query parameters.
type sebAuthEnvelope struct {
	Type   string `json:"type"`
	SebKey string `json:"sebKey"`
	BekKey string `json:"bekKey"`
}

// sebAuthAction is the verdict of sebAuthDecision: reject the handshake,
// bind the session's first-seen values, or accept against the values a
// previous handshake bound.
type sebAuthAction int

const (
	sebAuthReject sebAuthAction = iota
	sebAuthBind
	sebAuthAccept
)

// sebAuthDecision is the pure half of the first-message SEB handshake,
// mirroring lib/seb-guard.ts's verifySebAccess so the two transports guard
// the same rule. It only consumes the Config Key already persisted by the
// Next.js side — see internal/seb for why the algorithm itself isn't
// duplicated here. The presented token must match one of expectedTokens: the
// take-page token (what the SEB JS API returns on every platform) or the
// per-request-URL token (what Windows SEB's native header carries), each
// computed against either the session's personalized Config Key or the frozen
// exam-level one — the same candidate set the TS guard accepts. The returned
// reason is sent to the client verbatim so it can tell a student *why* the
// handshake failed.
// identityToken is the take-page token of whichever Config Key validated the
// request. It is what gets bound and compared, NOT the presented token —
// Windows SEB hashes per URL, so the raw token differs between the take page
// and this WS upgrade, and comparing it against the bound value rejected every
// Windows client with key_mismatch. Mirrors lib/seb-guard.ts.
func sebAuthDecision(examSession *store.ExamSessionAuth, expectedTokens []string, identityToken, token, ua string) (sebAuthAction, string) {
	if examSession.SebConfigKey == nil && examSession.SessionSebConfigKey == nil {
		return sebAuthReject, "seb_not_configured"
	}
	if token == "" {
		return sebAuthReject, "missing_token"
	}
	tokenValid := false
	for _, expected := range expectedTokens {
		if seb.TokensEqual(expected, token) {
			tokenValid = true
			break
		}
	}
	if !tokenValid {
		return sebAuthReject, "invalid_token"
	}
	if identityToken == "" {
		return sebAuthReject, "invalid_token"
	}
	if examSession.SebKeyHash == nil {
		// A cleared hash may be a rebind after the Next.js side rotated this
		// session's personalized Config Key, not a first handshake. Mirrors
		// lib/seb-guard.ts: if a UA is already on record the rebinding client
		// must present the same one, or the rotation would be a way to move a
		// live session out of SEB and into a normal browser.
		if examSession.SebUserAgent != nil && *examSession.SebUserAgent != ua {
			return sebAuthReject, "ua_mismatch"
		}
		return sebAuthBind, ""
	}
	if !seb.TokensEqual(*examSession.SebKeyHash, identityToken) {
		return sebAuthReject, "key_mismatch"
	}
	if examSession.SebUserAgent == nil || *examSession.SebUserAgent != ua {
		return sebAuthReject, "ua_mismatch"
	}
	return sebAuthAccept, ""
}

// sebHandshake reads and verifies the first-message SEB auth envelope, then
// answers seb_auth_ok on success or seb_auth_failed + close on failure. The
// connection is NOT registered with any room until it returns true. Every
// denial is audit-logged via logSebWsDenial, mirroring lib/seb-guard.ts's
// verifySebAccess wrapper on the Next.js side.
func sebHandshake(ctx context.Context, cfg *config.Config, log *slog.Logger, st *store.Store, h *hub.Hub, conn *websocket.Conn, r *http.Request, examSession *store.ExamSessionAuth, userID, ua string, ip *string) bool {
	readCtx, cancel := context.WithTimeout(ctx, sebAuthTimeout)
	_, data, err := conn.Read(readCtx)
	cancel()
	if err != nil {
		logSebWsDenial(ctx, log, st, examSession, userID, ip, ua, "missing_token")
		_ = conn.Close(websocket.StatusPolicyViolation, "seb auth required")
		return false
	}

	var env sebAuthEnvelope
	if err := json.Unmarshal(data, &env); err != nil || env.Type != "seb_auth" || env.SebKey == "" {
		logSebWsDenial(ctx, log, st, examSession, userID, ip, ua, "missing_token")
		sebHandshakeFailed(ctx, conn, "missing_token")
		return false
	}

	// Two transports per key, mirroring lib/seb-guard.ts: the take-page token
	// (what the SEB JS API returns on every platform) and the per-request-URL
	// token for this WS upgrade request (what Windows SEB's native header
	// hashes). Accepting only the first would strand sessions whose REST bind
	// saw the second.
	//
	// And two keys can each legitimately authorize the session: the
	// personalized one issued for the auto-login handoff and the frozen
	// exam-level one the anonymous config still carries. Four candidates in
	// all, and the same set the TS guard builds.
	scheme := "ws"
	if r.TLS != nil {
		scheme = "wss"
	}
	wsURL := scheme + "://" + r.Host + r.URL.Path
	takeURL := cfg.AppBaseURL + "/exam/" + examSession.ExamID + "/take"

	candidates := make([]string, 0, 4)
	// identityToken is the take-page token of the key that matched, resolved
	// alongside the candidates so the bind/compare below is URL-independent.
	identityToken := ""
	for _, key := range []*string{examSession.SessionSebConfigKey, examSession.SebConfigKey} {
		if key == nil {
			continue
		}
		takeToken := seb.ExpectedToken(takeURL, *key)
		wsToken := seb.ExpectedToken(wsURL, *key)
		candidates = append(candidates, takeToken, wsToken)
		if identityToken == "" && (seb.TokensEqual(takeToken, env.SebKey) || seb.TokensEqual(wsToken, env.SebKey)) {
			identityToken = takeToken
		}
	}

	action, reason := sebAuthDecision(examSession, candidates, identityToken, env.SebKey, ua)
	switch action {
	case sebAuthBind:
		bound, err := st.BindSebSession(ctx, examSession.ID, identityToken, ua)
		if err != nil {
			log.Error("failed to bind SEB session", "sessionId", examSession.ID, "error", err)
			logSebWsDenial(ctx, log, st, examSession, userID, ip, ua, "key_mismatch")
			sebHandshakeFailed(ctx, conn, "key_mismatch")
			return false
		}
		if !bound {
			// Lost the bind race: a concurrent handshake bound first. Judge
			// this one against the winner's values instead of trusting our
			// own stale read.
			settled, err := st.GetExamSessionAuth(ctx, examSession.ID)
			if err != nil {
				logSebWsDenial(ctx, log, st, examSession, userID, ip, ua, "key_mismatch")
				sebHandshakeFailed(ctx, conn, "key_mismatch")
				return false
			}
			examSession = settled
			// Fail closed, mirroring lib/seb-guard.ts's loser path: no
			// settled key means nobody won the bind, not that this client
			// did.
			if examSession.SebKeyHash == nil {
				logSebWsDenial(ctx, log, st, examSession, userID, ip, ua, "key_mismatch")
				sebHandshakeFailed(ctx, conn, "key_mismatch")
				return false
			}
			if action, reason = sebAuthDecision(examSession, candidates, identityToken, env.SebKey, ua); action == sebAuthReject {
				logSebWsDenial(ctx, log, st, examSession, userID, ip, ua, reason)
				sebHandshakeFailed(ctx, conn, reason)
				return false
			}
		}
	case sebAuthReject:
		logSebWsDenial(ctx, log, st, examSession, userID, ip, ua, reason)
		sebHandshakeFailed(ctx, conn, reason)
		return false
	}

	// Looking the room up (rather than creating it) is enough for the
	// attestation notify path: if nobody is watching this exam's monitor yet,
	// there's nothing local to deliver a live delta to, and the persisted
	// flag still shows on the next snapshot fetch. GetOrCreateRoom is
	// idempotent, so the normal student-registration path below still
	// creates it as before.
	notify := func(patch map[string]any) {
		h.GetOrCreateRoom(examSession.ExamID).BroadcastMonitorUpdate(examSession.ID, patch)
	}

	// Runs only once the handshake is already authorized and cannot change
	// that verdict.
	attestBrowserExamKey(ctx, log, st, examSession, env.BekKey, notify)
	sebHandshakeOk(ctx, conn)
	return true
}

var deviceIDPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// The tab identifier is public but must have the UUID shape the client sends.
func requestedDeviceID(r *http.Request) (string, bool) {
	values, present := r.URL.Query()["deviceId"]
	if !present {
		return "", true
	}
	if len(values) != 1 || !deviceIDPattern.MatchString(values[0]) {
		return "", false
	}
	return values[0], true
}

// A missing claim dimension is allowed for legacy rows. Once a claim exists,
// both the authenticated login and browser tab must match it.
func activeDeviceAllowed(activeAuth, activeDevice *string, authSessionID, deviceID string) bool {
	return (activeAuth == nil || *activeAuth == "" || *activeAuth == authSessionID) &&
		(activeDevice == nil || *activeDevice == "" || *activeDevice == deviceID)
}

// sessionReplacedClose tells a connection whose login no longer owns the
// session that it was replaced, then closes it.
func sessionReplacedClose(ctx context.Context, conn *websocket.Conn, sessionID string) {
	writeCtx, cancel := context.WithTimeout(ctx, sebWriteTimeout)
	defer cancel()
	msg, err := protocol.Encode(protocol.TypeExamControl, "", protocol.ControlEventData{Action: protocol.ActionSessionReplaced, SessionID: sessionID})
	if err == nil {
		_ = conn.Write(writeCtx, websocket.MessageText, msg)
	}
	_ = conn.Close(websocket.StatusNormalClosure, "replaced by another login")
}

// sebHandshakeFailed writes the rejection envelope and closes the socket.
// Write errors are ignored: the close below tears the connection down
// either way, and a stalled peer is exactly the case the write timeout
// guards against.
func sebHandshakeFailed(ctx context.Context, conn *websocket.Conn, reason string) {
	writeCtx, cancel := context.WithTimeout(ctx, sebWriteTimeout)
	defer cancel()
	msg, _ := json.Marshal(map[string]string{"type": "seb_auth_failed", "reason": reason})
	_ = conn.Write(writeCtx, websocket.MessageText, msg)
	_ = conn.Close(websocket.StatusPolicyViolation, "seb auth failed")
}

// sebHandshakeOk confirms the handshake so the client knows the socket is
// registered and answering (mirroring the connected state it only reached
// on WebSocket open for non-SEB exams).
func sebHandshakeOk(ctx context.Context, conn *websocket.Conn) {
	writeCtx, cancel := context.WithTimeout(ctx, sebWriteTimeout)
	defer cancel()
	msg, _ := json.Marshal(map[string]string{"type": "seb_auth_ok"})
	_ = conn.Write(writeCtx, websocket.MessageText, msg)
}

// attestBrowserExamKey mirrors attestBrowserExamKey in lib/seb-guard.ts and
// must not drift from it: bind on first sighting, flag a later change, and
// never reject. Returns nothing precisely because the outcome may not affect
// whether the student connects — a false positive mid-exam is worse than a
// missed detection. See lib/SEB_OUT_OF_SCOPE.md for what it does and does not
// prove. Persistence failures are logged rather than surfaced, for the same
// reason: losing the signal is acceptable, refusing an authorized student is
// not.
//
// The value compared here MUST be the take-page hash the SEB JS API returns
// (lib/seb-client.ts getSebRequestHash), which is what the handshake's bekKey
// carries and what the REST guard now reads from x-openexam-seb-requesthash.
// SEB's own X-SafeExamBrowser-RequestHash is sha256(requestURL + BEK) and so
// differs per endpoint; mixing the two into one column is what flagged every
// Windows student "bek_changed" on their first REST poll. This path was always
// on the correct side of that — keep it there.
func attestBrowserExamKey(ctx context.Context, log *slog.Logger, st *store.Store, examSession *store.ExamSessionAuth, bek string, notify func(patch map[string]any)) {
	switch action, reason := sebIntegrityDecision(examSession, bek); action {
	case sebBind:
		if err := st.BindSebBrowserExamKey(ctx, examSession.ID, bek); err != nil {
			log.Error("failed to bind SEB browser exam key", "sessionId", examSession.ID, "error", err)
		}
	case sebFlag:
		updated, err := st.FlagSebIntegrity(ctx, examSession.ID, reason)
		if err != nil {
			log.Error("failed to flag SEB integrity", "sessionId", examSession.ID, "reason", reason, "error", err)
			return
		}
		// Mirrors the TS guard's own updateMany-count check: count==0 means a
		// concurrent request already won the race and already notified.
		if updated {
			notify(map[string]any{"sebIntegrityFlagged": true, "sebIntegrityReason": reason})
		}
	}
}

type sebAttestAction int

const (
	sebNoop sebAttestAction = iota
	sebBind
	sebFlag
)

// sebIntegrityDecision is the pure half of attestBrowserExamKey, split out so
// the rule can be tested without a database — it is the piece that must stay
// in lockstep with decideBekAction in lib/seb-guard.ts. Both are pinned
// against the same fixture (testdata/seb-token-vectors.json) by
// TestSebIntegrityDecision_SharedVectors and the TS side's
// __tests__/seb-token-vectors.test.ts, so the two transports keep flagging
// the same situations. Mirror the TS control flow row for row: the compare
// is computed up front by the caller (seb.TokensEqual) and the decision
// never rejects — a false positive mid-exam is worse than a missed
// detection.
func sebIntegrityDecision(examSession *store.ExamSessionAuth, bek string) (sebAttestAction, string) {
	bound := examSession.SebBrowserExamKey
	presentedMatches := bek != "" && bound != nil && *bound != "" && seb.TokensEqual(*bound, bek)
	alreadyFlagged := examSession.SebIntegrityFlaggedAt != nil

	switch {
	case bound == nil || *bound == "":
		// Absent is indistinguishable from an SEB build that exposes no BEK,
		// so it is never itself suspicious — just bind the first one seen.
		if bek == "" {
			return sebNoop, ""
		}
		return sebBind, ""
	case bek != "" && presentedMatches:
		return sebNoop, ""
	case alreadyFlagged:
		// Set-once, so a client that stays switched away doesn't rewrite the
		// row on every reconnect.
		return sebNoop, ""
	case bek == "":
		return sebFlag, "bek_disappeared"
	default:
		return sebFlag, "bek_changed"
	}
}

func monitorHandler(cfg *config.Config, log *slog.Logger, st *store.Store, h *hub.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		examID := r.PathValue("examId")

		sess, err := auth.ValidateRequest(r.Context(), r, cfg.BetterAuthSecret, st)
		if err != nil || !staffRoleAllowed(sess.Role) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		exam, err := st.GetExamAuth(r.Context(), examID)
		if err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		if exam.CreatorID != sess.UserID {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}

		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: cfg.AllowedOrigins})
		if err != nil {
			log.Error("websocket accept failed", "examId", examID, "error", err)
			return
		}

		client := hub.NewMonitorClient(conn, sess.UserID, log)
		room := h.JoinRoom(examID, client, nil)
		if room == nil {
			_ = client.Conn().Close(websocket.StatusInternalError, "room unavailable")
			return
		}

		runConnWithSession(room, client, st, sess, true)
	}
}

// readLimitBytes bounds a whole WS frame, so it must stay comfortably above
// the 64 KiB raw answer cap in hub.validAnswerContent: the frame also carries
// the message envelope and JSON escaping of the answer body. If the two were
// equal, an oversized answer would trip the read limit and kill the student's
// connection mid-exam instead of being rejected cleanly by validation.
const readLimitBytes = 128 * 1024

// pingInterval/pingTimeout bound how long a half-open connection (laptop
// sleep, dropped WiFi, a dead browser tab) can be held open. Without a
// server-initiated ping, Conn().Read blocks forever on a socket the peer
// will never respond on again — the connection never errors out, so it's
// never unregistered. Each such zombie pins its client goroutines, its
// room's state map entry, and (via the room's idle timer only firing once
// both student/monitor maps are empty) can keep an otherwise-empty room
// alive indefinitely. A transport-level ping is independent of the
// application-level ping/pong the client sends on its own schedule
// (protocol.TypePing in room.go) — this one is server-initiated and doesn't
// depend on client cooperation to detect a dead peer.
const (
	pingInterval = 20 * time.Second
	pingTimeout  = 5 * time.Second
)

type sessionLookup interface {
	LookupSession(ctx context.Context, token string) (sessionID, userID, role string, expiresAt time.Time, err error)
}

const (
	sessionRecheckInterval = 30 * time.Second
	sessionLookupTimeout   = 5 * time.Second
)

func runConnWithSession(room *hub.Room, c *hub.Client, sessions sessionLookup, sess *auth.Session, requireStaff bool) {
	ctx, cancel := context.WithCancel(context.Background())
	// Defers run LIFO, so declared bottom-to-top the execution order is:
	// cancel first, then unregister, then CloseNow, then Wait. Cancel must
	// run first: if the read loop exited because the remote closed the
	// connection, the pump is idle in its select and nothing but ctx.Done
	// will make it exit — waiting on it before canceling would deadlock the
	// handler forever and Unregister would never run. Canceling does not
	// lose a queued close frame in the cases that matter: if the pump
	// already processed one it has returned (Wait is instant), and if the
	// remote closed first there is nothing left to flush. CloseNow (no close
	// handshake, no write-lock wait) then frees the fd and aborts any write
	// the pump is still blocked on, so Wait returns promptly; it is a no-op
	// when the pump already closed the connection.
	defer c.Wait()
	defer func() { _ = c.Conn().CloseNow() }()
	defer room.Unregister(c)
	var watcherDone chan struct{}
	defer func() {
		if watcherDone != nil {
			<-watcherDone
		}
	}()
	defer cancel()
	if sessions != nil && sess != nil {
		watcherDone = make(chan struct{})
		go func() {
			defer close(watcherDone)
			watchSessionAuthorization(ctx, c.Conn(), sessions, sess, requireStaff, sessionRecheckInterval)
		}()
	}
	c.Conn().SetReadLimit(readLimitBytes)
	c.StartPump(ctx)
	go pingLoop(ctx, cancel, c)
	for {
		_, data, err := c.Conn().Read(ctx)
		if err != nil {
			return
		}
		room.HandleMessage(c, data)
	}
}

// watchSessionAuthorization bounds stale authorization on established
// sockets. At expiration a bounded DB lookup rechecks the deadline; token existence,
// owner, and role are re-read periodically to catch revocation and promotion
// or demotion. A definitive answer (token gone, owner or role changed,
// expired) closes the connection at once. A transient lookup error on a
// periodic recheck is tolerated once, so a single database blip does not
// disconnect every open socket in a reconnect storm; a second consecutive
// failure closes (fail closed, ~2 recheck intervals). At the known expiry an
// unconfirmed lookup always closes.
func watchSessionAuthorization(ctx context.Context, conn *websocket.Conn, sessions sessionLookup, sess *auth.Session, requireStaff bool, recheckInterval time.Duration) {
	if recheckInterval <= 0 {
		recheckInterval = sessionRecheckInterval
	}
	remaining := time.Until(sess.ExpiresAt)
	if remaining <= 0 {
		closeUnauthorizedConn(conn)
		return
	}
	expires := time.NewTimer(remaining)
	defer expires.Stop()
	ticker := time.NewTicker(recheckInterval)
	defer ticker.Stop()
	// transient reports a lookup error that says nothing about the session
	// itself (database or network trouble), as opposed to ErrNotFound.
	revalidate := func() (expiresAt time.Time, valid, transient bool) {
		if ctx.Err() != nil {
			return time.Time{}, false, false
		}
		checkCtx, cancel := context.WithTimeout(ctx, sessionLookupTimeout)
		defer cancel()
		_, userID, role, expiresAt, err := sessions.LookupSession(checkCtx, sess.Token)
		if err != nil {
			return time.Time{}, false, !errors.Is(err, store.ErrNotFound)
		}
		valid = userID == sess.UserID && expiresAt.After(time.Now()) &&
			((requireStaff && staffRoleAllowed(role)) || (!requireStaff && studentRoleAllowed(role)))
		return expiresAt, valid, false
	}
	resetExpiry := func(expiresAt time.Time) {
		if !expires.Stop() {
			select {
			case <-expires.C:
			default:
			}
		}
		expires.Reset(time.Until(expiresAt))
	}

	transientFailures := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-expires.C:
			expiresAt, valid, _ := revalidate()
			if !valid {
				closeUnauthorizedConn(conn)
				return
			}
			transientFailures = 0
			resetExpiry(expiresAt)
		case <-ticker.C:
			expiresAt, valid, transient := revalidate()
			if transient && transientFailures == 0 && ctx.Err() == nil {
				transientFailures++
				continue
			}
			if !valid {
				closeUnauthorizedConn(conn)
				return
			}
			transientFailures = 0
			resetExpiry(expiresAt)
		}
	}
}

func closeUnauthorizedConn(conn *websocket.Conn) {
	_ = conn.Close(websocket.StatusPolicyViolation, "session authorization expired")
}

// pingLoop periodically pings the peer over the WS control channel. A ping
// that doesn't get a pong within pingTimeout cancels ctx, which unblocks the
// blocking Read in runConn with an error and tears the connection down
// through its normal defer chain (unregister, then wait for the pump).
func pingLoop(ctx context.Context, cancel context.CancelFunc, c *hub.Client) {
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			pingCtx, pingCancel := context.WithTimeout(ctx, pingTimeout)
			err := c.Conn().Ping(pingCtx)
			pingCancel()
			if err != nil {
				cancel()
				return
			}
		}
	}
}
