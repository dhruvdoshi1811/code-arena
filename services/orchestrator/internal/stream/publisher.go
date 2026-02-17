// Package stream publishes live execution events for the gateway to relay.
//
// This is a view of the execution, not the record of it. Every publish here is
// best-effort: Postgres is the source of truth, and a browser that misses an event
// still converges on the persisted result. Nothing in this package may fail a run.
package stream

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	// flushInterval bounds how often a running submission can produce a message.
	//
	// The submitted program decides how fast it prints, and it is untrusted. Publishing
	// per line would hand it control of our message rate — a `while True: print(x)`
	// becomes tens of thousands of Redis publishes, socket frames, and DOM updates per
	// second, against our own gateway and both participants' browsers. Batching on a
	// clock we own makes the rate ours regardless of what the program does.
	flushInterval = 100 * time.Millisecond
	// maxBatchLines flushes early when a batch fills, so bursts stay responsive rather
	// than waiting out the full interval.
	maxBatchLines = 64
)

// EventType discriminates the JSON payloads on the wire.
type EventType string

const (
	EventStatus EventType = "status"
	EventOutput EventType = "output"
)

// Event is what the gateway parses and re-emits. JSON rather than the compact binary
// envelope the Yjs bridge uses: these are small and low-rate, and being able to read
// them with `redis-cli SUBSCRIBE` during a demo is worth more than the bytes saved.
type Event struct {
	Type         EventType `json:"type"`
	SubmissionID string    `json:"submissionId"`
	SessionID    string    `json:"sessionId"`
	// Status events only.
	Status   string `json:"status,omitempty"`
	ExitCode *int32 `json:"exitCode,omitempty"`
	// Output events only.
	Lines []string `json:"lines,omitempty"`
}

// ChannelFor is the per-session channel. Sessions map one-to-one onto Socket.io rooms,
// so the gateway can route an event without consulting the database.
func ChannelFor(sessionID string) string {
	return "codearena:exec:" + sessionID
}

// Publisher owns the Redis connection.
type Publisher struct {
	client *redis.Client
	log    *slog.Logger
}

func New(redisURL string, log *slog.Logger) (*Publisher, error) {
	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, err
	}
	return &Publisher{client: redis.NewClient(opts), log: log}, nil
}

func (p *Publisher) Ping(ctx context.Context) error {
	return p.client.Ping(ctx).Err()
}

func (p *Publisher) Close() error { return p.client.Close() }

// PublishStatus emits a status transition immediately — these are rare and each one
// matters to the UI, so they are never batched behind a timer.
func (p *Publisher) PublishStatus(ctx context.Context, sessionID, submissionID, status string, exitCode *int32) {
	p.publish(ctx, sessionID, Event{
		Type:         EventStatus,
		SubmissionID: submissionID,
		SessionID:    sessionID,
		Status:       status,
		ExitCode:     exitCode,
	})
}

func (p *Publisher) publish(ctx context.Context, sessionID string, ev Event) {
	payload, err := json.Marshal(ev)
	if err != nil {
		p.log.Warn("could not encode execution event", "error", err)
		return
	}
	// Deliberately swallowed: a stream that cannot publish must not fail an execution
	// whose result is already being written to Postgres.
	if err := p.client.Publish(ctx, ChannelFor(sessionID), payload).Err(); err != nil {
		p.log.Warn("could not publish execution event", "error", err, "type", ev.Type)
	}
}

// Batcher accumulates output lines for one submission and flushes them on a timer.
//
// Created per execution and closed when it ends; Close performs a final flush so the
// last few lines are never stranded waiting for a tick that will not come.
type Batcher struct {
	publisher    *Publisher
	sessionID    string
	submissionID string

	mu      sync.Mutex
	pending []string

	stop     chan struct{}
	stopOnce sync.Once
	done     chan struct{}
}

// NewBatcher starts the flush loop.
func (p *Publisher) NewBatcher(ctx context.Context, sessionID, submissionID string) *Batcher {
	b := &Batcher{
		publisher:    p,
		sessionID:    sessionID,
		submissionID: submissionID,
		stop:         make(chan struct{}),
		done:         make(chan struct{}),
	}

	go func() {
		defer close(b.done)
		ticker := time.NewTicker(flushInterval)
		defer ticker.Stop()

		for {
			select {
			case <-ticker.C:
				b.flush(ctx)
			case <-b.stop:
				b.flush(ctx)
				return
			case <-ctx.Done():
				return
			}
		}
	}()

	return b
}

// Add queues a line. Safe to call from the log-following goroutine.
func (b *Batcher) Add(ctx context.Context, line string) {
	b.mu.Lock()
	b.pending = append(b.pending, line)
	full := len(b.pending) >= maxBatchLines
	b.mu.Unlock()

	// Flush early on a full batch so a fast producer stays responsive instead of
	// accumulating an unbounded slice between ticks.
	if full {
		b.flush(ctx)
	}
}

func (b *Batcher) flush(ctx context.Context) {
	b.mu.Lock()
	if len(b.pending) == 0 {
		b.mu.Unlock()
		return
	}
	lines := b.pending
	b.pending = nil
	b.mu.Unlock()

	b.publisher.publish(ctx, b.sessionID, Event{
		Type:         EventOutput,
		SubmissionID: b.submissionID,
		SessionID:    b.sessionID,
		Lines:        lines,
	})
}

// Close stops the loop after one final flush.
func (b *Batcher) Close() {
	b.stopOnce.Do(func() { close(b.stop) })
	<-b.done
}
