import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// An idle client erroring out (server restart, network blip) is emitted on the pool.
// Without a listener this is an unhandled 'error' event and takes the process down.
pool.on('error', (err) => {
  console.error('[db] idle client error', err);
});

export async function pingDatabase(): Promise<void> {
  await pool.query('SELECT 1');
}

export async function closePool(): Promise<void> {
  await pool.end();
}
