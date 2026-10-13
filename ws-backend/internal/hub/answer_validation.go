package hub

import (
	"encoding/json"
	"regexp"
	"strings"
)

// fileNameRe matches the random per-upload filename minted by
// app/api/sessions/[id]/upload: a v4 UUID plus a lowercase extension.
var fileNameRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,16}$`)

// fileKeyBelongsTo mirrors lib/answer-file-key.ts. A FILE_UPLOAD answer's key
// is dereferenced by the REST download route to serve that file, so the WS
// write path must not let a student store a key naming a file that is not
// their own upload for this very question.
func fileKeyBelongsTo(fileKey, sessionID, questionID string) bool {
	parts := strings.Split(fileKey, "/")
	if len(parts) != 4 {
		return false
	}
	return parts[0] == "sessions" &&
		parts[1] == sessionID &&
		parts[2] == questionID &&
		fileNameRe.MatchString(parts[3])
}

// validAnswerContent mirrors the REST answer payload limits. It intentionally
// accepts additional object keys like Zod's default object parsing does, while
// enforcing the type and every persisted field's shape and size. The raw cap
// (64 KiB) leaves headroom for JSON escaping of the largest rich-text answers.
func validAnswerContent(raw json.RawMessage, expectedType, sessionID, questionID string) bool {
	if len(raw) == 0 || len(raw) > 64*1024 {
		return false
	}
	var value map[string]json.RawMessage
	if json.Unmarshal(raw, &value) != nil {
		return false
	}
	typeName, ok := stringField(value, "type", 32)
	if !ok || typeName != expectedType {
		return false
	}

	switch expectedType {
	case "MULTIPLE_CHOICE":
		return stringSlice(value["selectedOptionIds"], 200, 128)
	case "FREE_TEXT":
		return hasStringField(value, "text", 30000)
	case "FILL_IN_THE_BLANK":
		return objectsWithStrings(value["blanks"], 200, map[string]int{"id": 128, "value": 2000})
	case "FILE_UPLOAD":
		fileKey, ok := stringField(value, "fileKey", 512)
		if !ok || !fileKeyBelongsTo(fileKey, sessionID, questionID) {
			return false
		}
		return hasStringField(value, "fileName", 255)
	case "MATCHING":
		return objectsWithStrings(value["matches"], 200, map[string]int{"leftId": 128, "rightId": 128})
	case "CODE":
		return hasStringField(value, "code", 50000) && hasStringField(value, "language", 50)
	case "TRUE_FALSE":
		var selected *bool
		return json.Unmarshal(value["selected"], &selected) == nil && selected != nil
	case "SHORT_ANSWER":
		return hasStringField(value, "text", 1000)
	case "ORDERING":
		return stringSlice(value["orderedIds"], 200, 128)
	default:
		return false
	}
}

// stringField decodes into a *string, not string, because encoding/json
// silently accepts JSON null for a non-pointer string (leaving it "" with no
// error) — which would let {"text": null} pass as an empty-but-present field.
func stringField(value map[string]json.RawMessage, key string, max int) (string, bool) {
	var field *string
	if json.Unmarshal(value[key], &field) != nil || field == nil || len(*field) > max {
		return "", false
	}
	return *field, true
}

func hasStringField(value map[string]json.RawMessage, key string, max int) bool {
	_, ok := stringField(value, key, max)
	return ok
}

func stringSlice(raw json.RawMessage, maxItems, maxItemLength int) bool {
	var values *[]string
	if json.Unmarshal(raw, &values) != nil || values == nil || len(*values) > maxItems {
		return false
	}
	for _, value := range *values {
		if len(value) > maxItemLength {
			return false
		}
	}
	return true
}

func objectsWithStrings(raw json.RawMessage, maxItems int, fields map[string]int) bool {
	var values *[]map[string]json.RawMessage
	if json.Unmarshal(raw, &values) != nil || values == nil || len(*values) > maxItems {
		return false
	}
	for _, value := range *values {
		for field, max := range fields {
			if !hasStringField(value, field, max) {
				return false
			}
		}
	}
	return true
}
