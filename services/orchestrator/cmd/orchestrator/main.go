// Command orchestrator consumes code submissions from Kafka.
//
// Phase C: it logs what it receives and nothing more. Phase D replaces the handler with
// one that creates a resource-limited Kubernetes Job per submission via client-go.
//
// This service — not the Node gateway — owns Kafka consumption and, later, the cluster
// interaction. client-go is the first-class, watch-aware Kubernetes client, and a
// public-facing WebSocket server has no business holding credentials that can mutate a
// cluster's workloads.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/dhruvdoshi1811/code-arena/services/orchestrator/internal/config"
	"github.com/dhruvdoshi1811/code-arena/services/orchestrator/internal/consumer"
	"github.com/dhruvdoshi1811/code-arena/services/orchestrator/internal/event"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		slog.Error("invalid configuration", "error", err)
		os.Exit(1)
	}

	log := newLogger(cfg.LogLevel)
	log.Info("orchestrator starting",
		"brokers", cfg.Brokers,
		"topic", cfg.SubmissionsTopic,
		"group", cfg.ConsumerGroup,
	)

	c, err := consumer.New(cfg, log)
	if err != nil {
		log.Error("could not create consumer", "error", err)
		os.Exit(1)
	}
	defer c.Close()

	// Cancelled on SIGINT/SIGTERM so an in-flight poll unwinds and the group slot is
	// released, rather than the broker waiting out the session timeout.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := c.Run(ctx, logSubmission(log)); err != nil {
		log.Error("consumer stopped", "error", err)
		os.Exit(1)
	}

	log.Info("orchestrator stopped")
}

// logSubmission is the Phase C handler: observe the event, do nothing to the world.
func logSubmission(log *slog.Logger) consumer.Handler {
	return func(_ context.Context, submission event.SubmissionEvent) error {
		log.Info("submission received",
			"submissionId", submission.SubmissionID,
			"sessionId", submission.SessionID,
			"userId", submission.UserID,
			"language", submission.Language,
			"codeBytes", len(submission.Code),
			"createdAt", submission.CreatedAt,
		)
		return nil
	}
}

func newLogger(level string) *slog.Logger {
	var lvl slog.Level
	if err := lvl.UnmarshalText([]byte(level)); err != nil {
		lvl = slog.LevelInfo
	}
	return slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: lvl}))
}
