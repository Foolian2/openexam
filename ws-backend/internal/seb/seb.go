// Package seb implements Safe Exam Browser Config Key token verification
// for the WS handshake. It deliberately does not compute the Config Key
// itself — that algorithm (SEB-JSON canonicalization, see lib/seb-key.ts)
// lives in exactly one place, TypeScript, to avoid two implementations
// silently drifting apart. This package only consumes the value already
// persisted by the Next.js side — either Exam.sebConfigKey (the anonymous
// config) or ExamSession.sebConfigKey (the personalized auto-login config).
package seb

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// ExpectedToken computes sha256(urlWithoutFragment + configKey) in hex,
// matching lib/seb-key.ts's configKeyTokenForUrl and the SEB JS API's
// SafeExamBrowser.security.configKey.
func ExpectedToken(takeURL, configKey string) string {
	urlNoFragment, _, _ := strings.Cut(takeURL, "#")
	sum := sha256.Sum256([]byte(urlNoFragment + configKey))
	return hex.EncodeToString(sum[:])
}

// TokensEqual is a constant-time comparison for two hex token strings.
func TokensEqual(a, b string) bool {
	return hmac.Equal([]byte(a), []byte(b))
}
