// Package auth validates Better Auth session cookies against the shared
// Postgres session table. It never trusts the "session_data" cookie cache —
// every request is checked against the database.
package auth

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var (
	ErrNoCookie        = errors.New("auth: no session cookie")
	ErrMalformedCookie = errors.New("auth: malformed session cookie")
	ErrBadSignature    = errors.New("auth: invalid cookie signature")
	ErrSessionNotFound = errors.New("auth: session not found")
	ErrSessionExpired  = errors.New("auth: session expired")
)

// Cookie names Better Auth may emit — the "__Secure-" prefixed variant is
// used in production when cookies are set with Secure=true.
const (
	cookieNameDev  = "better-auth.session_token"
	cookieNameProd = "__Secure-better-auth.session_token"
)

// Session is the authenticated identity resolved from a valid cookie.
type Session struct {
	Token     string
	UserID    string
	Role      string
	ExpiresAt time.Time
}

// Store is the subset of DB access auth needs, implemented by internal/store.
type Store interface {
	LookupSession(ctx context.Context, token string) (userID, role string, expiresAt time.Time, err error)
}

// ExtractToken pulls the raw session token out of the request's cookies and
// verifies its HMAC-SHA256 signature against secret, mirroring better-call's
// setSignedCookie: value = encodeURIComponent(token + "." + base64(HMAC(secret, token))).
func ExtractToken(r *http.Request, secret string) (string, error) {
	raw, err := findSessionCookie(r)
	if err != nil {
		return "", err
	}

	unescaped, err := url.QueryUnescape(raw)
	if err != nil {
		return "", ErrMalformedCookie
	}

	sepIdx := strings.LastIndex(unescaped, ".")
	if sepIdx < 1 {
		return "", ErrMalformedCookie
	}
	token := unescaped[:sepIdx]
	sigB64 := unescaped[sepIdx+1:]

	// better-call requires standard base64 with padding (44 chars for a
	// 32-byte SHA-256 signature, ending in "=").
	if len(sigB64) != 44 || !strings.HasSuffix(sigB64, "=") {
		return "", ErrMalformedCookie
	}
	sig, err := base64.StdEncoding.DecodeString(sigB64)
	if err != nil {
		return "", ErrMalformedCookie
	}

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(token))
	expected := mac.Sum(nil)
	if !hmac.Equal(sig, expected) {
		return "", ErrBadSignature
	}

	return token, nil
}

func findSessionCookie(r *http.Request) (string, error) {
	if c, err := r.Cookie(cookieNameProd); err == nil && c.Value != "" {
		return c.Value, nil
	}
	if c, err := r.Cookie(cookieNameDev); err == nil && c.Value != "" {
		return c.Value, nil
	}
	return "", ErrNoCookie
}

// ValidateRequest verifies the request's session cookie signature (without
// touching the database) and then looks up the token in Postgres, rejecting
// expired sessions.
func ValidateRequest(ctx context.Context, r *http.Request, secret string, store Store) (*Session, error) {
	token, err := ExtractToken(r, secret)
	if err != nil {
		return nil, err
	}

	userID, role, expiresAt, err := store.LookupSession(ctx, token)
	if err != nil {
		return nil, err
	}
	if userID == "" {
		return nil, ErrSessionNotFound
	}
	if time.Now().After(expiresAt) {
		return nil, ErrSessionExpired
	}

	return &Session{Token: token, UserID: userID, Role: role, ExpiresAt: expiresAt}, nil
}
