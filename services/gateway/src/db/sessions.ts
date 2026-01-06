import { pool } from './pool.js';
import type { Language, Session, SessionStatus } from '../domain.js';

interface SessionRow {
  id: string;
  host_id: string;
  guest_id: string | null;
  language: Language;
  status: SessionStatus;
  created_at: Date;
  ended_at: Date | null;
}

function mapSession(row: SessionRow): Session {
  return {
    id: row.id,
    hostId: row.host_id,
    guestId: row.guest_id,
    language: row.language,
    status: row.status,
    createdAt: row.created_at,
    endedAt: row.ended_at,
  };
}

export async function createSession(hostId: string, language: Language): Promise<Session> {
  const { rows } = await pool.query<SessionRow>(
    `INSERT INTO sessions (host_id, language)
     VALUES ($1, $2)
     RETURNING *`,
    [hostId, language],
  );
  return mapSession(rows[0]!);
}

export async function findSessionById(id: string): Promise<Session | null> {
  const { rows } = await pool.query<SessionRow>(`SELECT * FROM sessions WHERE id = $1`, [id]);
  return rows[0] ? mapSession(rows[0]) : null;
}

/**
 * Atomically claim the single guest seat.
 *
 * This is a conditional UPDATE rather than a SELECT-then-UPDATE on purpose: the guest
 * seat is a contended resource, and read-then-write leaves a window where two joiners
 * both observe `guest_id IS NULL` and the second silently overwrites the first. Every
 * precondition — seat free, session still ACTIVE, joiner is not the host — lives in the
 * WHERE clause, so Postgres' row lock decides the winner and the loser gets zero rows.
 *
 * Returns null when the claim did not apply; the caller inspects the current row to
 * report *why*.
 */
export async function claimGuestSeat(sessionId: string, userId: string): Promise<Session | null> {
  const { rows } = await pool.query<SessionRow>(
    `UPDATE sessions
        SET guest_id = $2
      WHERE id = $1
        AND guest_id IS NULL
        AND status = 'ACTIVE'
        AND host_id <> $2
      RETURNING *`,
    [sessionId, userId],
  );
  return rows[0] ? mapSession(rows[0]) : null;
}

/** Only the host may end a session, and only one ACTIVE -> ENDED transition can win. */
export async function endSession(sessionId: string, hostId: string): Promise<Session | null> {
  const { rows } = await pool.query<SessionRow>(
    `UPDATE sessions
        SET status = 'ENDED', ended_at = now()
      WHERE id = $1
        AND host_id = $2
        AND status = 'ACTIVE'
      RETURNING *`,
    [sessionId, hostId],
  );
  return rows[0] ? mapSession(rows[0]) : null;
}
