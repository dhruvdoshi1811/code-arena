import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { closePool } from '../src/db/pool.js';
import { authed, registerUser, resetDb, type RegisteredUser } from './helpers.js';

const app = createApp();

let host: RegisteredUser;
let guest: RegisteredUser;
let bystander: RegisteredUser;

beforeEach(async () => {
  await resetDb();
  host = await registerUser(app, 'host');
  guest = await registerUser(app, 'guest');
  bystander = await registerUser(app, 'bystander');
});

afterAll(closePool);

async function createSession(owner: RegisteredUser = host) {
  const res = await authed(app, owner.token).post('/api/sessions').send({ language: 'python' });
  expect(res.status).toBe(201);
  return res.body.session as { id: string; hostId: string; guestId: string | null; status: string };
}

describe('POST /api/sessions', () => {
  it('seats the creator as host with an empty guest seat', async () => {
    const session = await createSession();
    expect(session).toMatchObject({ hostId: host.user.id, guestId: null, status: 'ACTIVE' });
  });

  it('rejects an unsupported language', async () => {
    const res = await authed(app, host.token).post('/api/sessions').send({ language: 'malbolge' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('requires authentication', async () => {
    const res = await request(app).post('/api/sessions').send({ language: 'python' });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/sessions/:id/join', () => {
  it('seats the second participant as guest', async () => {
    const session = await createSession();

    const res = await authed(app, guest.token).post(`/api/sessions/${session.id}/join`);
    expect(res.status).toBe(200);
    expect(res.body.session.guestId).toBe(guest.user.id);
  });

  it('refuses a third participant', async () => {
    const session = await createSession();
    await authed(app, guest.token).post(`/api/sessions/${session.id}/join`);

    const res = await authed(app, bystander.token).post(`/api/sessions/${session.id}/join`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SESSION_FULL');
  });

  it('refuses the host taking the guest seat', async () => {
    const session = await createSession();

    const res = await authed(app, host.token).post(`/api/sessions/${session.id}/join`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_HOST');
  });

  it('is idempotent for the seated guest', async () => {
    const session = await createSession();
    await authed(app, guest.token).post(`/api/sessions/${session.id}/join`);

    const res = await authed(app, guest.token).post(`/api/sessions/${session.id}/join`);
    expect(res.status).toBe(200);
    expect(res.body.session.guestId).toBe(guest.user.id);
  });

  it('refuses joining an ended session', async () => {
    const session = await createSession();
    await authed(app, host.token).post(`/api/sessions/${session.id}/end`);

    const res = await authed(app, guest.token).post(`/api/sessions/${session.id}/join`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SESSION_ENDED');
  });

  it('404s on an unknown session', async () => {
    const res = await authed(app, guest.token).post(
      '/api/sessions/00000000-0000-4000-8000-000000000000/join',
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SESSION_NOT_FOUND');
  });

  // The reason the join is a conditional UPDATE rather than SELECT-then-UPDATE.
  it('lets exactly one of two simultaneous joiners win the seat', async () => {
    const session = await createSession();

    const [a, b] = await Promise.all([
      authed(app, guest.token).post(`/api/sessions/${session.id}/join`),
      authed(app, bystander.token).post(`/api/sessions/${session.id}/join`),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;
    expect(loser.body.error.code).toBe('SESSION_FULL');

    // And the database agrees with whoever the API told they had won.
    const readBack = await authed(app, host.token).get(`/api/sessions/${session.id}`);
    expect(readBack.body.session.guestId).toBe(winner.body.session.guestId);
  });
});

describe('GET /api/sessions/:id', () => {
  it('is readable by both participants', async () => {
    const session = await createSession();
    await authed(app, guest.token).post(`/api/sessions/${session.id}/join`);

    for (const participant of [host, guest]) {
      const res = await authed(app, participant.token).get(`/api/sessions/${session.id}`);
      expect(res.status).toBe(200);
      expect(res.body.session.id).toBe(session.id);
    }
  });

  it('is not readable by a non-participant', async () => {
    const session = await createSession();

    const res = await authed(app, bystander.token).get(`/api/sessions/${session.id}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_A_PARTICIPANT');
  });

  it('rejects a malformed id with 400', async () => {
    const res = await authed(app, host.token).get('/api/sessions/not-a-uuid');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/sessions/:id/end', () => {
  it('lets the host end the session', async () => {
    const session = await createSession();

    const res = await authed(app, host.token).post(`/api/sessions/${session.id}/end`);
    expect(res.status).toBe(200);
    expect(res.body.session.status).toBe('ENDED');
    expect(res.body.session.endedAt).not.toBeNull();
  });

  it('refuses a guest ending the session', async () => {
    const session = await createSession();
    await authed(app, guest.token).post(`/api/sessions/${session.id}/join`);

    const res = await authed(app, guest.token).post(`/api/sessions/${session.id}/end`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_THE_HOST');
  });
});
