-- Phase C schema: one "run this code" request.
--
-- The row is written by the Node gateway and, from Phase D, updated by the Go
-- orchestrator as the Kubernetes Job it triggers progresses. That shared ownership is
-- exactly why the schema lives in plain SQL rather than inside either service's ORM.
--
-- `execution_jobs` is deliberately still absent. It arrives with Phase D, when the Go
-- service that owns Kubernetes actually needs somewhere to record a Job name.

-- Up Migration

CREATE TYPE submission_status AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'TIMEOUT');

CREATE TABLE submissions (
    id          UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id  UUID              NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    user_id     UUID              NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- Same CHECK as sessions.language, for the same reason: widening a CHECK when
    -- Phase D adds an execution image is cheaper than altering an enum type.
    language    TEXT              NOT NULL CHECK (language IN ('python', 'javascript')),
    -- A snapshot of the document at the moment Run was pressed. Stored rather than
    -- re-read later because the shared document keeps changing after submission, and
    -- what ran must stay reproducible.
    code        TEXT              NOT NULL,
    status      submission_status NOT NULL DEFAULT 'QUEUED',
    output      TEXT,
    exit_code   INTEGER,
    created_at  TIMESTAMPTZ       NOT NULL DEFAULT now(),
    started_at  TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,

    -- A terminal submission has both timestamps; a queued one has neither.
    CONSTRAINT submissions_timestamps_follow_status CHECK (
        (status = 'QUEUED'  AND started_at IS NULL AND finished_at IS NULL)
        OR (status = 'RUNNING' AND started_at IS NOT NULL AND finished_at IS NULL)
        OR (status IN ('COMPLETED', 'FAILED', 'TIMEOUT')
            AND started_at IS NOT NULL AND finished_at IS NOT NULL)
    )
);

-- The session view lists most-recent-first; this serves that directly.
CREATE INDEX submissions_session_id_created_at_idx
    ON submissions (session_id, created_at DESC);

-- Down Migration

DROP TABLE IF EXISTS submissions;
DROP TYPE IF EXISTS submission_status;
