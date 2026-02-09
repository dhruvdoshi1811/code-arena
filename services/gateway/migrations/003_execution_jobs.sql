-- Phase D schema: the Kubernetes Job backing a submission.
--
-- Written exclusively by the Go orchestrator. It lives in the gateway's migration
-- directory because there is one database with one schema history, not because the
-- gateway owns it — this table is the clearest case yet for why the schema was kept in
-- language-neutral SQL rather than inside either service's ORM.

-- Up Migration

CREATE TABLE execution_jobs (
    id            UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
    -- One Job per submission. The unique constraint is load-bearing: Kafka delivery is
    -- at-least-once, so a redelivered record must not be able to record a second Job.
    submission_id UUID              NOT NULL UNIQUE REFERENCES submissions (id) ON DELETE CASCADE,
    k8s_job_name  TEXT              NOT NULL,
    k8s_namespace TEXT              NOT NULL,
    -- Deliberately mirrors submission_status rather than inventing a parallel
    -- vocabulary; the two move together and a second enum would drift.
    status        submission_status NOT NULL DEFAULT 'QUEUED',
    created_at    TIMESTAMPTZ       NOT NULL DEFAULT now(),
    started_at    TIMESTAMPTZ,
    finished_at   TIMESTAMPTZ
);

CREATE INDEX execution_jobs_status_idx ON execution_jobs (status);

-- Down Migration

DROP TABLE IF EXISTS execution_jobs;
