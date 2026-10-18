package seb

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// This fixture is shared with lib/seb-key.ts's configKeyTokenForUrl (see
// the matching case in __tests__/seb.test.ts). The two implementations
// must agree byte-for-byte on this value — that's the whole point of
// keeping the Config Key algorithm itself in exactly one place
// (TypeScript) while Go only verifies a token against it.
const (
	fixtureTakeURL   = "http://localhost:3000/exam/exam1/take"
	fixtureConfigKey = "fixture-config-key-123"
	fixtureToken     = "31dbc8371cd20d4a0606f137a0027bcc797574e2b4ed79462b1d74e44b47fab5"
)

func TestExpectedToken_MatchesTypeScriptFixture(t *testing.T) {
	got := ExpectedToken(fixtureTakeURL, fixtureConfigKey)
	if got != fixtureToken {
		t.Fatalf("ExpectedToken() = %q, want %q (must match lib/seb-key.ts's configKeyTokenForUrl)", got, fixtureToken)
	}
}

func TestExpectedToken_StripsFragment(t *testing.T) {
	withFragment := ExpectedToken(fixtureTakeURL+"#section", fixtureConfigKey)
	if withFragment != fixtureToken {
		t.Fatalf("ExpectedToken() with fragment = %q, want %q", withFragment, fixtureToken)
	}
}

func TestExpectedToken_DifferentURLDifferentToken(t *testing.T) {
	other := ExpectedToken("http://localhost:3000/exam/exam2/take", fixtureConfigKey)
	if other == fixtureToken {
		t.Fatal("expected a different token for a different URL")
	}
}

func TestTokensEqual(t *testing.T) {
	if !TokensEqual(fixtureToken, fixtureToken) {
		t.Fatal("expected equal tokens to compare equal")
	}
	if TokensEqual(fixtureToken, "not-the-token") {
		t.Fatal("expected different tokens to compare unequal")
	}
	if TokensEqual(fixtureToken, "") {
		t.Fatal("expected empty token to compare unequal")
	}
}

// TestSharedTokenVectors pins ExpectedToken to the same table
// __tests__/seb-token-vectors.test.ts checks configKeyTokenForUrl against. The
// Config Key token and the BEK RequestHash are the same construction, and the
// two implementations live in different languages on different sides of the
// wire — a shared fixture is what stops them drifting apart silently.
func TestSharedTokenVectors(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "testdata", "seb-token-vectors.json"))
	if err != nil {
		t.Fatalf("read shared vectors: %v", err)
	}
	var fixture struct {
		Vectors []struct {
			Name     string `json:"name"`
			URL      string `json:"url"`
			Key      string `json:"key"`
			Expected string `json:"expected"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("parse shared vectors: %v", err)
	}
	if len(fixture.Vectors) == 0 {
		t.Fatal("shared vector file is empty")
	}
	for _, v := range fixture.Vectors {
		t.Run(v.Name, func(t *testing.T) {
			if got := ExpectedToken(v.URL, v.Key); got != v.Expected {
				t.Fatalf("ExpectedToken(%q, %q) = %q, want %q", v.URL, v.Key, got, v.Expected)
			}
		})
	}
}
