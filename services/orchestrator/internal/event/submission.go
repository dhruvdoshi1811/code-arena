// Package event holds the wire contract between the Node gateway and this service.
//
// These field tags are the interface. Their counterpart is `SubmissionEvent` in the
// gateway's src/domain.ts — the two are matched by JSON field name and nothing else,
// so changing one without the other breaks the pipeline silently rather than loudly.
package event

import "time"

// Language is the execution runtime a submission targets. Phase D maps each of these
// to a container image; until then it is carried through and logged.
type Language string

const (
	LanguagePython     Language = "python"
	LanguageJavaScript Language = "javascript"
)

// SubmissionEvent is one "run this code" request, as published to Kafka.
type SubmissionEvent struct {
	SubmissionID string    `json:"submissionId"`
	SessionID    string    `json:"sessionId"`
	UserID       string    `json:"userId"`
	Language     Language  `json:"language"`
	Code         string    `json:"code"`
	CreatedAt    time.Time `json:"createdAt"`
}
