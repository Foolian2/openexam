package hub

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
)

func TestValidAnswerContent(t *testing.T) {
	tests := []struct {
		name     string
		content  string
		expected string
		valid    bool
	}{
		{"accepts matching type", `{"type":"FREE_TEXT","text":"answer"}`, "FREE_TEXT", true},
		{"rejects mismatched type", `{"type":"CODE","code":"x","language":"go"}`, "FREE_TEXT", false},
		{"rejects malformed payload", `{`, "FREE_TEXT", false},
		{"rejects null free text", `{"type":"FREE_TEXT","text":null}`, "FREE_TEXT", false},
		{"rejects null boolean", `{"type":"TRUE_FALSE","selected":null}`, "TRUE_FALSE", false},
		{"rejects null selection list", `{"type":"MULTIPLE_CHOICE","selectedOptionIds":null}`, "MULTIPLE_CHOICE", false},
		{"rejects null object list", `{"type":"MATCHING","matches":null}`, "MATCHING", false},
		{"rejects oversized code", `{"type":"CODE","code":"` + strings.Repeat("x", 50001) + `","language":"go"}`, "CODE", false},
		{
			"accepts a file key for this session and question",
			`{"type":"FILE_UPLOAD","fileKey":"sessions/sess1/q1/` + testUUID + `.pdf","fileName":"a.pdf"}`,
			"FILE_UPLOAD", true,
		},
		{
			"rejects a file key belonging to another session",
			`{"type":"FILE_UPLOAD","fileKey":"sessions/other/q1/` + testUUID + `.pdf","fileName":"a.pdf"}`,
			"FILE_UPLOAD", false,
		},
		{
			"rejects a file key belonging to another question",
			`{"type":"FILE_UPLOAD","fileKey":"sessions/sess1/q2/` + testUUID + `.pdf","fileName":"a.pdf"}`,
			"FILE_UPLOAD", false,
		},
		{
			"rejects a traversal file key",
			`{"type":"FILE_UPLOAD","fileKey":"sessions/sess1/q1/../../../etc/passwd","fileName":"a.pdf"}`,
			"FILE_UPLOAD", false,
		},
		{
			"rejects a file key with a non-UUID filename",
			`{"type":"FILE_UPLOAD","fileKey":"sessions/sess1/q1/backup.pdf","fileName":"a.pdf"}`,
			"FILE_UPLOAD", false,
		},
		// These four mirror the "boundary cases kept out of the fixture" block in
		// __tests__/answer-contract-vectors.test.ts: the shared fixture is static
		// JSON and deliberately excludes count/length limits, so each side pins
		// its own boundaries here to keep the 200-item and 30000-char caps in
		// answerContentSchema (lib/validators/answer.ts) and validAnswerContent in
		// sync.
		{
			"rejects a MULTIPLE_CHOICE with more than 200 option ids",
			multipleChoiceContent(201), "MULTIPLE_CHOICE", false,
		},
		{
			"accepts a MULTIPLE_CHOICE with exactly 200 option ids",
			multipleChoiceContent(200), "MULTIPLE_CHOICE", true,
		},
		{
			"rejects FREE_TEXT longer than 30000 characters",
			freeTextContent(30001), "FREE_TEXT", false,
		},
		{
			"accepts FREE_TEXT of exactly 30000 characters",
			freeTextContent(30000), "FREE_TEXT", true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := validAnswerContent(json.RawMessage(tt.content), tt.expected, "sess1", "q1"); got != tt.valid {
				t.Fatalf("validAnswerContent() = %v, want %v", got, tt.valid)
			}
		})
	}
}

// multipleChoiceContent builds a MULTIPLE_CHOICE answer content payload with n
// selected option ids.
func multipleChoiceContent(n int) string {
	ids := make([]string, n)
	for i := range ids {
		ids[i] = fmt.Sprintf(`"id-%d"`, i)
	}
	return `{"type":"MULTIPLE_CHOICE","selectedOptionIds":[` + strings.Join(ids, ",") + `]}`
}

// freeTextContent builds a FREE_TEXT answer content payload with an n-character text.
func freeTextContent(n int) string {
	return `{"type":"FREE_TEXT","text":"` + strings.Repeat("x", n) + `"}`
}

// testUUID is a well-formed v4 UUID, the filename shape the upload route mints.
const testUUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"

type answerVector struct {
	Name           string          `json:"name"`
	Type           string          `json:"type"`
	Content        json.RawMessage `json:"content"`
	SessionID      string          `json:"sessionId"`
	QuestionID     string          `json:"questionId"`
	SchemaValid    bool            `json:"schemaValid"`
	OwnershipValid bool            `json:"ownershipValid"`
}

type answerVectorFixture struct {
	FileNamePattern string         `json:"fileNamePattern"`
	Vectors         []answerVector `json:"vectors"`
}

// TestAnswerContractVectors is the other half of
// __tests__/answer-contract-vectors.test.ts. Both read
// ../../../testdata/answer-vectors.json, so the Go validator and the TS zod
// schema cannot drift apart without one of these two suites going red. It also
// pins fileNameRe to the fixture's literal, which is what both fileKeyBelongsTo
// implementations derive their filename check from.
func TestAnswerContractVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../testdata/answer-vectors.json")
	if err != nil {
		t.Fatalf("read shared fixture: %v", err)
	}
	var fixture answerVectorFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("unmarshal shared fixture: %v", err)
	}

	if got := fileNameRe.String(); got != fixture.FileNamePattern {
		t.Fatalf("fileNameRe.String() = %q, want fixture pattern %q", got, fixture.FileNamePattern)
	}

	for _, v := range fixture.Vectors {
		t.Run(v.Name, func(t *testing.T) {
			want := v.SchemaValid && v.OwnershipValid
			if got := validAnswerContent(v.Content, v.Type, v.SessionID, v.QuestionID); got != want {
				t.Fatalf(
					"validAnswerContent() = %v, want %v (schemaValid=%v ownershipValid=%v)",
					got, want, v.SchemaValid, v.OwnershipValid,
				)
			}
		})
	}
}
