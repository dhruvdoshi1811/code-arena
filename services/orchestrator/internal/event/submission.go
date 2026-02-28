// Package event holds the wire contract between the Node gateway and this service.
package event

import "time"

// Language is the execution runtime a submission targets.
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
