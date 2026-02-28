import { pool } from './pool.js';
import type { User } from '../domain.js';
import { conflict, PG_UNIQUE_VIOLATION, pgErrorCode } from '../errors.js';

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  created_at: Date;
}

function mapUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
  };
}

export async function createUser(params: {
  email: string;
  displayName: string;
  passwordHash: string;
}): Promise<User> {
  try {
    const { rows } = await pool.query<UserRow>(
      `INSERT INTO users (email, display_name, password_hash)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [params.email, params.displayName, params.passwordHash],
    );
    return mapUser(rows[0]!);
  } catch (err) {
    // Let the unique index be the arbiter rather than a check-then-insert.
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
      throw conflict('EMAIL_TAKEN', 'An account with that email already exists');
    }
    throw err;
  }
}

export async function findUserByEmail(email: string): Promise<User | null> {
  const { rows } = await pool.query<UserRow>(`SELECT * FROM users WHERE email = $1`, [email]);
  return rows[0] ? mapUser(rows[0]) : null;
}

export async function findUserById(id: string): Promise<User | null> {
  const { rows } = await pool.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [id]);
  return rows[0] ? mapUser(rows[0]) : null;
}

/** Used by the presence layer to label participants without an N+1 lookup per socket. */
export async function findUsersByIds(ids: string[]): Promise<User[]> {
  if (ids.length === 0) return [];
  const { rows } = await pool.query<UserRow>(`SELECT * FROM users WHERE id = ANY($1::uuid[])`, [
    ids,
  ]);
  return rows.map(mapUser);
}
