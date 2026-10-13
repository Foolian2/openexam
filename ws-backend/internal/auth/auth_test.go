package auth

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

const testSecret = "test-secret-value"

func signedCookieValue(token, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(token))
	sig := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	return url.QueryEscape(token + "." + sig)
}

func requestWithCookie(name, value string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/ws/exam/abc", nil)
	r.AddCookie(&http.Cookie{Name: name, Value: value})
	return r
}

func TestExtractToken_Valid(t *testing.T) {
	token := "cuid-token-123"
	r := requestWithCookie(cookieNameDev, signedCookieValue(token, testSecret))

	got, err := ExtractToken(r, testSecret)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != token {
		t.Fatalf("got %q, want %q", got, token)
	}
}

func TestExtractToken_ProdCookieName(t *testing.T) {
	token := "cuid-token-456"
	r := requestWithCookie(cookieNameProd, signedCookieValue(token, testSecret))

	got, err := ExtractToken(r, testSecret)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != token {
		t.Fatalf("got %q, want %q", got, token)
	}
}

func TestExtractToken_NoCookie(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/ws/exam/abc", nil)
	if _, err := ExtractToken(r, testSecret); err != ErrNoCookie {
		t.Fatalf("got %v, want ErrNoCookie", err)
	}
}

func TestExtractToken_TamperedSignature(t *testing.T) {
	token := "cuid-token-789"
	value := signedCookieValue(token, testSecret)
	// Flip the last character of the (still-escaped) signature.
	tampered := value[:len(value)-1] + "x"
	r := requestWithCookie(cookieNameDev, tampered)

	if _, err := ExtractToken(r, testSecret); err == nil {
		t.Fatal("expected error for tampered signature")
	}
}

func TestExtractToken_TamperedToken(t *testing.T) {
	token := "cuid-token-abc"
	unescaped, _ := url.QueryUnescape(signedCookieValue(token, testSecret))
	sepIdx := len(token)
	sig := unescaped[sepIdx:]
	forged := url.QueryEscape("attacker-controlled-token" + sig)
	r := requestWithCookie(cookieNameDev, forged)

	if _, err := ExtractToken(r, testSecret); err != ErrBadSignature {
		t.Fatalf("got %v, want ErrBadSignature", err)
	}
}

func TestExtractToken_WrongSecret(t *testing.T) {
	token := "cuid-token-def"
	r := requestWithCookie(cookieNameDev, signedCookieValue(token, "a-different-secret"))

	if _, err := ExtractToken(r, testSecret); err != ErrBadSignature {
		t.Fatalf("got %v, want ErrBadSignature", err)
	}
}

func TestExtractToken_Base64URLVariantRejected(t *testing.T) {
	// A signature encoded as base64url (no padding, "-_" alphabet) must be
	// rejected even if it verifies, since better-call always emits standard
	// base64 with "=" padding — this guards against alphabet confusion.
	token := "cuid-token-ghi"
	mac := hmac.New(sha256.New, []byte(testSecret))
	mac.Write([]byte(token))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil)) // no padding
	value := url.QueryEscape(token + "." + sig)
	r := requestWithCookie(cookieNameDev, value)

	if _, err := ExtractToken(r, testSecret); err != ErrMalformedCookie {
		t.Fatalf("got %v, want ErrMalformedCookie", err)
	}
}

func TestExtractToken_MalformedNoSeparator(t *testing.T) {
	r := requestWithCookie(cookieNameDev, url.QueryEscape("no-dot-here"))
	if _, err := ExtractToken(r, testSecret); err != ErrMalformedCookie {
		t.Fatalf("got %v, want ErrMalformedCookie", err)
	}
}

type fakeStore struct {
	userID    string
	role      string
	expiresAt time.Time
	err       error
}

func (f fakeStore) LookupSession(ctx context.Context, token string) (string, string, time.Time, error) {
	if f.err != nil {
		return "", "", time.Time{}, f.err
	}
	return f.userID, f.role, f.expiresAt, nil
}

func TestValidateRequest_Valid(t *testing.T) {
	token := "cuid-token-valid"
	r := requestWithCookie(cookieNameDev, signedCookieValue(token, testSecret))
	store := fakeStore{userID: "user-1", role: "STUDENT", expiresAt: time.Now().Add(time.Hour)}

	sess, err := ValidateRequest(context.Background(), r, testSecret, store)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sess.UserID != "user-1" || sess.Role != "STUDENT" {
		t.Fatalf("unexpected session: %+v", sess)
	}
}

func TestValidateRequest_Expired(t *testing.T) {
	token := "cuid-token-expired"
	r := requestWithCookie(cookieNameDev, signedCookieValue(token, testSecret))
	store := fakeStore{userID: "user-1", role: "STUDENT", expiresAt: time.Now().Add(-time.Hour)}

	if _, err := ValidateRequest(context.Background(), r, testSecret, store); err != ErrSessionExpired {
		t.Fatalf("got %v, want ErrSessionExpired", err)
	}
}

func TestValidateRequest_NotFound(t *testing.T) {
	token := "cuid-token-missing"
	r := requestWithCookie(cookieNameDev, signedCookieValue(token, testSecret))
	store := fakeStore{err: ErrSessionNotFound}

	if _, err := ValidateRequest(context.Background(), r, testSecret, store); err != ErrSessionNotFound {
		t.Fatalf("got %v, want ErrSessionNotFound", err)
	}
}
