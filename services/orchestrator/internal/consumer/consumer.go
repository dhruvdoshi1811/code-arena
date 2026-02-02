// Package consumer drains the submissions topic.
//
// Phase C scope, deliberately: decode and log. This service does not touch Postgres and
// does not know Kubernetes exists. Both arrive in Phase D, where there is real execution
// whose state is worth recording — recording it earlier would mean writing status
// transitions that describe nothing.
package consumer

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"

	"github.com/dhruvdoshi1811/code-arena/services/orchestrator/internal/config"
	"github.com/dhruvdoshi1811/code-arena/services/orchestrator/internal/event"
)

// Handler processes one decoded submission. Phase D swaps the logging implementation
// for one that creates a Kubernetes Job.
type Handler func(context.Context, event.SubmissionEvent) error

// Consumer wraps a franz-go consumer group client.
type Consumer struct {
	client *kgo.Client
	log    *slog.Logger
	topic  string
}

// New builds a consumer group client bound to the submissions topic.
func New(cfg config.Config, log *slog.Logger) (*Consumer, error) {
	client, err := kgo.NewClient(
		kgo.SeedBrokers(cfg.Brokers...),
		kgo.ConsumerGroup(cfg.ConsumerGroup),
		kgo.ConsumeTopics(cfg.SubmissionsTopic),
		// Start from the beginning of a partition the first time this group sees it, so
		// a consumer started after a burst still drains what is already queued rather
		// than silently skipping it.
		kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()),
		// Offsets are committed explicitly, after a record is handled. Automatic
		// interval commits would acknowledge records that were fetched but not yet
		// processed, so a crash mid-batch would lose submissions outright.
		kgo.DisableAutoCommit(),
	)
	if err != nil {
		return nil, err
	}

	return &Consumer{client: client, log: log, topic: cfg.SubmissionsTopic}, nil
}

// Run polls until the context is cancelled.
func (c *Consumer) Run(ctx context.Context, handle Handler) error {
	c.log.Info("consuming", "topic", c.topic)

	for {
		fetches := c.client.PollFetches(ctx)
		if fetches.IsClientClosed() {
			return nil
		}
		if err := ctx.Err(); err != nil {
			return nil
		}

		// Fetch errors are per-topic-partition and usually transient (a rebalance, a
		// broker blip). Log and keep polling rather than tearing the process down.
		fetches.EachError(func(topic string, partition int32, err error) {
			if errors.Is(err, context.Canceled) {
				return
			}
			c.log.Error("fetch failed", "topic", topic, "partition", partition, "error", err)
		})

		fetches.EachRecord(func(record *kgo.Record) {
			c.handleRecord(ctx, record, handle)
		})

		// Commit only what was just processed.
		if err := c.client.CommitUncommittedOffsets(ctx); err != nil && ctx.Err() == nil {
			c.log.Error("commit failed", "error", err)
		}
	}
}

func (c *Consumer) handleRecord(ctx context.Context, record *kgo.Record, handle Handler) {
	var submission event.SubmissionEvent
	if err := json.Unmarshal(record.Value, &submission); err != nil {
		// A record that cannot be decoded will never decode. Retrying it forever would
		// wedge the partition, so it is logged and stepped over; Phase D routes these
		// to a dead-letter topic once there is a consequence worth preserving.
		c.log.Error("undecodable record, skipping",
			"partition", record.Partition,
			"offset", record.Offset,
			"error", err,
		)
		return
	}

	if err := handle(ctx, submission); err != nil {
		c.log.Error("handler failed",
			"submissionId", submission.SubmissionID,
			"error", err,
		)
	}
}

// Close flushes and shuts down the client, releasing the group slot promptly instead of
// leaving the group to time the member out.
func (c *Consumer) Close() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := c.client.CommitUncommittedOffsets(ctx); err != nil {
		c.log.Warn("final commit failed", "error", err)
	}
	c.client.Close()
}
