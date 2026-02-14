// Package store persists execution results.
//
// The Go service writes `submissions` and owns `execution_jobs` outright — the reason
// the schema was kept in language-neutral SQL migrations from Phase A rather than
// inside the Node gateway's type system.
package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Status mirrors the submission_status enum in Postgres.
type Status string

const (
	StatusQueued    Status = "QUEUED"
	StatusRunning   Status = "RUNNING"
	StatusCompleted Status = "COMPLETED"
	StatusFailed    Status = "FAILED"
	StatusTimeout   Status = "TIMEOUT"
)

// Store is a pgx pool wrapper.
type Store struct {
	pool *pgxpool.Pool
}

func New(ctx context.Context, databaseURL string) (*Store, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, fmt.Errorf("create pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return &Store{pool: pool}, nil
}

func (s *Store) Close() { s.pool.Close() }

// RecordJobCreated inserts the execution_jobs row.
//
// ON CONFLICT DO NOTHING rather than an error: Kafka is at-least-once, and the unique
// constraint on submission_id is what makes a redelivered record harmless here, exactly
// as the deterministic Job name does on the Kubernetes side.
func (s *Store) RecordJobCreated(ctx context.Context, submissionID, jobName, namespace string) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO execution_jobs (submission_id, k8s_job_name, k8s_namespace, status)
		 VALUES ($1, $2, $3, 'QUEUED')
		 ON CONFLICT (submission_id) DO NOTHING`,
		submissionID, jobName, namespace,
	)
	if err != nil {
		return fmt.Errorf("insert execution_job: %w", err)
	}
	return nil
}

// MarkRunning moves both rows to RUNNING and stamps started_at.
//
// The submissions CHECK constraint requires started_at to be non-null exactly when
// status is RUNNING, so these two must move together or Postgres rejects the write —
// a cross-service invariant enforced by the database rather than by convention.
func (s *Store) MarkRunning(ctx context.Context, submissionID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx,
		`UPDATE submissions
		    SET status = 'RUNNING', started_at = now()
		  WHERE id = $1 AND status = 'QUEUED'`,
		submissionID,
	); err != nil {
		return fmt.Errorf("update submission: %w", err)
	}

	if _, err := tx.Exec(ctx,
		`UPDATE execution_jobs
		    SET status = 'RUNNING', started_at = now()
		  WHERE submission_id = $1`,
		submissionID,
	); err != nil {
		return fmt.Errorf("update execution_job: %w", err)
	}

	return tx.Commit(ctx)
}

// Result is a terminal execution outcome.
type Result struct {
	Status   Status
	Output   string
	ExitCode *int32
}

// MarkFinished writes the terminal state to both tables in one transaction.
//
// `started_at` is coalesced because a submission can reach a terminal state without
// ever having been observed RUNNING — a pod that fails to schedule, or a Job whose
// deadline fires before the watch reports the pod started. The CHECK constraint demands
// a non-null started_at for any terminal status, so this must not depend on MarkRunning
// having happened.
func (s *Store) MarkFinished(ctx context.Context, submissionID string, result Result) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx,
		`UPDATE submissions
		    SET status      = $2,
		        output      = $3,
		        exit_code   = $4,
		        started_at  = COALESCE(started_at, now()),
		        finished_at = now()
		  WHERE id = $1`,
		submissionID, string(result.Status), result.Output, result.ExitCode,
	); err != nil {
		return fmt.Errorf("update submission: %w", err)
	}

	if _, err := tx.Exec(ctx,
		`UPDATE execution_jobs
		    SET status      = $2,
		        started_at  = COALESCE(started_at, now()),
		        finished_at = now()
		  WHERE submission_id = $1`,
		submissionID, string(result.Status),
	); err != nil {
		return fmt.Errorf("update execution_job: %w", err)
	}

	return tx.Commit(ctx)
}
