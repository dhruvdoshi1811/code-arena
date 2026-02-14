// Package config reads and validates the orchestrator's environment.
package config

import (
	"fmt"
	"os"
	"strconv"
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

	DatabaseURL string
	// Empty means in-cluster config, then ~/.kube/config.
	Kubeconfig string

	ExecutionNamespace       string
	ExecutionCPU             string
	ExecutionMemory          string
	ExecutionDeadlineSeconds int64
	ExecutionTTLSeconds      int32
	// How many submissions may execute at once. Bounds this process; the namespace
	// ResourceQuota bounds the cluster.
	MaxConcurrent int
}

// Load reads the environment, applying local-development defaults.
func Load() (Config, error) {
	cfg := Config{
		Brokers:          splitAndTrim(env("KAFKA_BROKERS", "localhost:19092")),
		SubmissionsTopic: env("KAFKA_SUBMISSIONS_TOPIC", "code-submissions"),
		ConsumerGroup:    env("KAFKA_GROUP_ID", "codearena-orchestrator"),
		LogLevel:         env("LOG_LEVEL", "info"),

		DatabaseURL: env("DATABASE_URL", "postgres://codearena:codearena@localhost:5432/codearena"),
		Kubeconfig:  env("KUBECONFIG_PATH", ""),

		ExecutionNamespace:       env("EXECUTION_NAMESPACE", "codearena-exec"),
		ExecutionCPU:             env("EXECUTION_CPU", "500m"),
		ExecutionMemory:          env("EXECUTION_MEMORY", "256Mi"),
		ExecutionDeadlineSeconds: envInt("EXECUTION_DEADLINE_SECONDS", 10),
		ExecutionTTLSeconds:      int32(envInt("EXECUTION_TTL_SECONDS", 300)),
		MaxConcurrent:            int(envInt("MAX_CONCURRENT_EXECUTIONS", 4)),
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
	if cfg.DatabaseURL == "" {
		return Config{}, fmt.Errorf("DATABASE_URL must not be empty")
	}
	// A zero or negative deadline would mean "no timeout", which is the one thing this
	// service must never allow for untrusted code.
	if cfg.ExecutionDeadlineSeconds <= 0 {
		return Config{}, fmt.Errorf("EXECUTION_DEADLINE_SECONDS must be positive, got %d", cfg.ExecutionDeadlineSeconds)
	}
	if cfg.MaxConcurrent <= 0 {
		return Config{}, fmt.Errorf("MAX_CONCURRENT_EXECUTIONS must be positive, got %d", cfg.MaxConcurrent)
	}

	return cfg, nil
}

func envInt(key string, fallback int64) int64 {
	raw, ok := os.LookupEnv(key)
	if !ok || raw == "" {
		return fallback
	}
	parsed, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil {
		return fallback
	}
	return parsed
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
