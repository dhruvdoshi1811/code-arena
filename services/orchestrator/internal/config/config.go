// Package config reads and validates the orchestrator's environment.
package config

import (
	"fmt"
	"os"
	"strings"
)

// Config is the fully validated environment. Mirrors the gateway's fail-fast rule:
// a process that starts with a missing broker list and only discovers it on the first
// message is strictly worse than one that never starts.
type Config struct {
	Brokers          []string
	SubmissionsTopic string
	ConsumerGroup    string
	LogLevel         string
}

// Load reads the environment, applying local-development defaults.
func Load() (Config, error) {
	cfg := Config{
		Brokers:          splitAndTrim(env("KAFKA_BROKERS", "localhost:19092")),
		SubmissionsTopic: env("KAFKA_SUBMISSIONS_TOPIC", "code-submissions"),
		ConsumerGroup:    env("KAFKA_GROUP_ID", "codearena-orchestrator"),
		LogLevel:         env("LOG_LEVEL", "info"),
	}

	if len(cfg.Brokers) == 0 {
		return Config{}, fmt.Errorf("KAFKA_BROKERS must list at least one broker")
	}
	if cfg.SubmissionsTopic == "" {
		return Config{}, fmt.Errorf("KAFKA_SUBMISSIONS_TOPIC must not be empty")
	}
	if cfg.ConsumerGroup == "" {
		return Config{}, fmt.Errorf("KAFKA_GROUP_ID must not be empty")
	}

	return cfg, nil
}

func env(key, fallback string) string {
	if value, ok := os.LookupEnv(key); ok && value != "" {
		return value
	}
	return fallback
}

func splitAndTrim(value string) []string {
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}
