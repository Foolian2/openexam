// Package config loads Go WS backend configuration from the environment.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Port              string
	DatabaseURL       string
	RedisURL          string
	BetterAuthSecret  string
	AllowedOrigins    []string
	FlushInterval     time.Duration
	RoomIdleTimeout   time.Duration
	SubmitGraceMillis int64
	// AppBaseURL is the Next.js app's origin, used to reconstruct the exam
	// take-page URL for SEB Config Key token verification (internal/seb).
	AppBaseURL string
	// SentryDSN points at the internal-only glitchtip-web address (empty
	// when the monitoring stack isn't deployed — scripts/setup-monitoring.sh
	// is opt-in). See main.go's Sentry.Init call.
	SentryDSN string
}

func Load() (*Config, error) {
	cfg := &Config{
		Port:              getEnv("PORT", "8080"),
		DatabaseURL:       os.Getenv("DATABASE_URL"),
		RedisURL:          getEnv("REDIS_URL", "redis://localhost:6379"),
		BetterAuthSecret:  os.Getenv("BETTER_AUTH_SECRET"),
		AllowedOrigins:    splitCSV(getEnv("ALLOWED_ORIGINS", "http://localhost:3000")),
		FlushInterval:     getDuration("FLUSH_INTERVAL", 5*time.Second),
		RoomIdleTimeout:   getDuration("ROOM_IDLE_TIMEOUT", 60*time.Second),
		SubmitGraceMillis: 30_000,
		AppBaseURL: firstNonEmpty(
			getEnv("NEXT_PUBLIC_BASE_URL", ""),
			getEnv("APP_BASE_URL", ""),
			"http://localhost:3000",
		),
		SentryDSN: os.Getenv("SENTRY_DSN"),
	}

	if cfg.DatabaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required")
	}
	if cfg.BetterAuthSecret == "" {
		return nil, fmt.Errorf("BETTER_AUTH_SECRET is required")
	}

	return cfg, nil
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// firstNonEmpty returns the first value that is non-empty after trimming
// whitespace, or "" if every value is empty. Used to give one env var
// priority over a legacy fallback name; trimming keeps a stray space in an
// env var (e.g. NEXT_PUBLIC_BASE_URL=" ") from silently becoming the base
// origin instead of falling through to the next candidate.
func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if trimmed := strings.TrimSpace(v); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func getDuration(key string, fallback time.Duration) time.Duration {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	seconds, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return time.Duration(seconds) * time.Second
}

func splitCSV(v string) []string {
	parts := strings.Split(v, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}
