import type { Express } from 'express';
import request from 'supertest';
import { WebSocket } from 'ws';
import type { Socket as ClientSocket } from 'socket.io-client';
import { pool } from '../src/db/pool.js';
import type { PublicUser } from '../src/domain.js';

export const PASSWORD = 'correct-horse-battery-staple';

export interface RegisteredUser {
  token: string;
  user: PublicUser;
}

/** Sessions first — it carries the foreign keys into users. */
export async function resetDb(): Promise<void> {
  await pool.query('TRUNCATE sessions, users RESTART IDENTITY CASCADE');
}

export async function registerUser(app: Express, name: string): Promise<RegisteredUser> {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email: `${name}@example.com`, displayName: name, password: PASSWORD });

  if (res.status !== 201) {
    throw new Error(`registerUser(${name}) failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body as RegisteredUser;
}

export function authed(app: Express, token: string) {
  return {
    post: (path: string) => request(app).post(path).set('Authorization', `Bearer ${token}`),
    get: (path: string) => request(app).get(path).set('Authorization', `Bearer ${token}`),
  };
}

/** Resolve on the next occurrence of `event`, or reject if it does not arrive. */
export function nextEvent<T = unknown>(
  socket: ClientSocket,
  event: string,
  timeoutMs = 5_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timed out waiting for "${event}"`));
    }, timeoutMs);

    const handler = (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    };
    socket.once(event, handler);
  });
}

export interface YjsConnectResult {
  ok: boolean;
  status?: number;
}

/** Attempt a raw WebSocket upgrade against the Yjs transport and report the outcome. */
export function connectYjs(url: string): Promise<YjsConnectResult> {
  return new Promise<YjsConnectResult>((resolve) => {
    const ws = new WebSocket(url);

    ws.on('open', () => {
      ws.close();
      resolve({ ok: true });
    });
    // Listening for this suppresses the generic 'error' for handshake rejections,
    // which is how we recover the HTTP status the server refused with.
    ws.on('unexpected-response', (_req, res) => {
      ws.terminate();
      resolve({ ok: false, status: res.statusCode });
    });
    ws.on('error', () => {
      resolve({ ok: false });
    });
  });
}
