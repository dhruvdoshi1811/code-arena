-- Phase A schema: identity and the two-participant pairing.
--
-- Plain SQL rather than an ORM schema definition on purpose: from Phase C the Go
-- orchestrator reads and writes this same database, so schema ownership has to live
-- somewhere language-neutral. `submissions` and `execution_jobs` arrive in a later
-- migration, when the service that needs them exists.
--
-- Postgres 13+ provides gen_random_uuid() natively, so no pgcrypto extension.

-- Up Migration

CREATE TABLE users (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT        NOT NULL UNIQUE,
    display_name  TEXT        NOT NULL,
    password_hash TEXT        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE session_status AS ENUM ('ACTIVE', 'ENDED');

-- "session" here means a live pairing between two people, not an auth session.
-- Auth is stateless JWT, so there is no other kind of session to confuse this with.
CREATE TABLE sessions (
    id         UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
    host_id    UUID           NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    guest_id   UUID           REFERENCES users (id) ON DELETE SET NULL,
    -- TEXT + CHECK rather than an enum: Phase D adds execution images per language,
    -- and widening a CHECK is a cheaper migration than altering an enum type.
    language   TEXT           NOT NULL CHECK (language IN ('python', 'javascript')),
    status     session_status NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ    NOT NULL DEFAULT now(),
    ended_at   TIMESTAMPTZ,

    -- The host cannot also occupy the guest seat.
    CONSTRAINT sessions_guest_is_not_host CHECK (guest_id IS NULL OR guest_id <> host_id),
    -- ENDED sessions carry a timestamp; ACTIVE ones do not.
    CONSTRAINT sessions_ended_at_matches_status CHECK (
        (status = 'ENDED' AND ended_at IS NOT NULL)
        OR (status = 'ACTIVE' AND ended_at IS NULL)
    )
);

CREATE INDEX sessions_host_id_idx ON sessions (host_id);
CREATE INDEX sessions_guest_id_idx ON sessions (guest_id);

-- Down Migration

DROP TABLE IF EXISTS sessions;
DROP TYPE IF EXISTS session_status;
DROP TABLE IF EXISTS users;
