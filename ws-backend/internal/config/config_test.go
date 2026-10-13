package config

import (
	"testing"
)

func TestFirstNonEmpty(t *testing.T) {
	tests := []struct {
		name string
		vals []string
		want string
	}{
		{name: "first value wins", vals: []string{"a", "b"}, want: "a"},
		{name: "skips empty prefix", vals: []string{"", "b"}, want: "b"},
		{name: "skips whitespace-only values entirely", vals: []string{"", " "}, want: ""},
		{name: "trims surrounding whitespace from the chosen value", vals: []string{"", " b "}, want: "b"},
		{name: "all empty yields empty", vals: []string{"", ""}, want: ""},
		{name: "no values yields empty", vals: nil, want: ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := firstNonEmpty(tc.vals...); got != tc.want {
				t.Errorf("firstNonEmpty(%v) = %q, want %q", tc.vals, got, tc.want)
			}
		})
	}
}

// AppBaseURL must read the TS-side NEXT_PUBLIC_BASE_URL first, falling back
// to the legacy APP_BASE_URL name and finally to the localhost dev default —
// a changed name on one side must not silently change which origin the Go
// verifier hashes tokens against.
func TestLoad_AppBaseURLPrecedence(t *testing.T) {
	t.Run("prefers NEXT_PUBLIC_BASE_URL over APP_BASE_URL", func(t *testing.T) {
		t.Setenv("NEXT_PUBLIC_BASE_URL", "https://exam.example.com")
		t.Setenv("APP_BASE_URL", "https://legacy.example.com")
		t.Setenv("DATABASE_URL", "postgresql://ci:ci@localhost:5432/ci")
		t.Setenv("BETTER_AUTH_SECRET", "test-secret")

		cfg, err := Load()
		if err != nil {
			t.Fatalf("Load() error: %v", err)
		}
		if cfg.AppBaseURL != "https://exam.example.com" {
			t.Errorf("AppBaseURL = %q, want %q", cfg.AppBaseURL, "https://exam.example.com")
		}
	})

	t.Run("falls back to legacy APP_BASE_URL", func(t *testing.T) {
		t.Setenv("NEXT_PUBLIC_BASE_URL", "")
		t.Setenv("APP_BASE_URL", "https://legacy.example.com")
		t.Setenv("DATABASE_URL", "postgresql://ci:ci@localhost:5432/ci")
		t.Setenv("BETTER_AUTH_SECRET", "test-secret")

		cfg, err := Load()
		if err != nil {
			t.Fatalf("Load() error: %v", err)
		}
		if cfg.AppBaseURL != "https://legacy.example.com" {
			t.Errorf("AppBaseURL = %q, want %q", cfg.AppBaseURL, "https://legacy.example.com")
		}
	})

	t.Run("defaults to localhost when both are unset", func(t *testing.T) {
		t.Setenv("NEXT_PUBLIC_BASE_URL", "")
		t.Setenv("APP_BASE_URL", "")
		t.Setenv("DATABASE_URL", "postgresql://ci:ci@localhost:5432/ci")
		t.Setenv("BETTER_AUTH_SECRET", "test-secret")

		cfg, err := Load()
		if err != nil {
			t.Fatalf("Load() error: %v", err)
		}
		if cfg.AppBaseURL != "http://localhost:3000" {
			t.Errorf("AppBaseURL = %q, want %q", cfg.AppBaseURL, "http://localhost:3000")
		}
	})
}
