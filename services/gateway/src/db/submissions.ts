import { pool } from './pool.js';
import type { Language, Submission, SubmissionStatus } from '../domain.js';

interface SubmissionRow {
  id: string;
  session_id: string;
  user_id: string;
  language: Language;
  code: string;
  status: SubmissionStatus;
  output: string | null;
  exit_code: number | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

function mapSubmission(row: SubmissionRow): Submission {
  return {
    id: row.id,
    sessionId: row.session_id,
    userId: row.user_id,
    language: row.language,
    code: row.code,
    status: row.status,
    output: row.output,
    exitCode: row.exit_code,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/**
 * Records the submission as QUEUED before anything is published.
 *
 * Order matters: the row is the durable record, and publishing first would allow a
 * consumer to receive an id that does not exist yet. The reverse ordering — row, then
 * publish — can instead strand a QUEUED row if the produce fails, which the caller
 * surfaces as an error and which Phase D's reconciliation can sweep up. Given a choice
 * between a dangling row and a dangling message, the row is the recoverable one.
 */
export async function createSubmission(params: {
  sessionId: string;
  userId: string;
  language: Language;
  code: string;
}): Promise<Submission> {
  const { rows } = await pool.query<SubmissionRow>(
    `INSERT INTO submissions (session_id, user_id, language, code)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [params.sessionId, params.userId, params.language, params.code],
  );
  return mapSubmission(rows[0]!);
}

export async function findSubmissionById(id: string): Promise<Submission | null> {
  const { rows } = await pool.query<SubmissionRow>(`SELECT * FROM submissions WHERE id = $1`, [id]);
  return rows[0] ? mapSubmission(rows[0]) : null;
}

export async function listSubmissionsForSession(
  sessionId: string,
  limit = 20,
): Promise<Submission[]> {
  const { rows } = await pool.query<SubmissionRow>(
    `SELECT * FROM submissions
      WHERE session_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [sessionId, limit],
  );
  return rows.map(mapSubmission);
}

export async function countSubmissionsForSession(sessionId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM submissions WHERE session_id = $1`,
    [sessionId],
  );
  return Number(rows[0]?.count ?? 0);
}
