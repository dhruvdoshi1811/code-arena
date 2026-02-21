// Command orchestrator consumes code submissions from Kafka and executes each one
// inside an isolated, resource-limited Kubernetes Job.
//
// This service — not the Node gateway — owns both Kafka consumption and the cluster
// interaction. client-go is the first-class, watch-aware Kubernetes client, and a
// public-facing WebSocket server has no business holding credentials that can create
// workloads in a cluster.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"sync"
	"syscall"

	"github.com/dhruvdoshi1811/code-arena/services/orchestrator/internal/config"
	"github.com/dhruvdoshi1811/code-arena/services/orchestrator/internal/consumer"
	"github.com/dhruvdoshi1811/code-arena/services/orchestrator/internal/event"
	"github.com/dhruvdoshi1811/code-arena/services/orchestrator/internal/executor"
	"github.com/dhruvdoshi1811/code-arena/services/orchestrator/internal/k8s"
	"github.com/dhruvdoshi1811/code-arena/services/orchestrator/internal/store"
	"github.com/dhruvdoshi1811/code-arena/services/orchestrator/internal/stream"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		slog.Error("invalid configuration", "error", err)
		os.Exit(1)
	}

	log := newLogger(cfg.LogLevel)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	clientset, err := k8s.NewClientset(cfg.Kubeconfig)
	if err != nil {
		log.Error("could not reach kubernetes", "error", err)
		os.Exit(1)
	}

	st, err := store.New(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Error("could not reach postgres", "error", err)
		os.Exit(1)
	}
	defer st.Close()

	publisher, err := stream.New(cfg.RedisURL, log)
	if err != nil {
		log.Error("could not create the event publisher", "error", err)
		os.Exit(1)
	}
	if err := publisher.Ping(ctx); err != nil {
		log.Error("could not reach redis", "error", err)
		os.Exit(1)
	}
	defer func() { _ = publisher.Close() }()

	limits := k8s.Limits{
		CPU:             cfg.ExecutionCPU,
		Memory:          cfg.ExecutionMemory,
		DeadlineSeconds: cfg.ExecutionDeadlineSeconds,
		TTLSeconds:      cfg.ExecutionTTLSeconds,
	}
	exec := executor.New(clientset, st, publisher, log, cfg.ExecutionNamespace, limits)

	log.Info("orchestrator starting",
		"brokers", cfg.Brokers,
		"topic", cfg.SubmissionsTopic,
		"group", cfg.ConsumerGroup,
		"execNamespace", cfg.ExecutionNamespace,
		"deadlineSeconds", cfg.ExecutionDeadlineSeconds,
		"maxConcurrent", cfg.MaxConcurrent,
	)

	c, err := consumer.New(cfg, log)
	if err != nil {
		log.Error("could not create consumer", "error", err)
		os.Exit(1)
	}
	defer c.Close()

	// A bounded pool, not unbounded goroutines. Concurrency is required — "the infinite
	// loop was killed without affecting other jobs" cannot be shown by a serial
	// consumer — but unbounded concurrency would just move the resource exhaustion from
	// the cluster into this process. The namespace ResourceQuota bounds the other side.
	slots := make(chan struct{}, cfg.MaxConcurrent)
	var inFlight sync.WaitGroup

	handler := func(ctx context.Context, sub event.SubmissionEvent) error {
		select {
		case slots <- struct{}{}:
		case <-ctx.Done():
			return ctx.Err()
		}

		inFlight.Add(1)
		go func() {
			defer inFlight.Done()
			defer func() { <-slots }()

			if err := exec.Execute(ctx, sub); err != nil {
				log.Error("execution failed",
					"submissionId", sub.SubmissionID,
					"error", err,
				)
			}
		}()
		return nil
	}

	runErr := c.Run(ctx, handler)

	// Let in-flight executions finish and record their results before the process goes.
	inFlight.Wait()

	if runErr != nil {
		log.Error("consumer stopped", "error", runErr)
		os.Exit(1)
	}
	log.Info("orchestrator stopped")
}

func newLogger(level string) *slog.Logger {
	var lvl slog.Level
	if err := lvl.UnmarshalText([]byte(level)); err != nil {
		lvl = slog.LevelInfo
	}
	return slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: lvl}))
}
