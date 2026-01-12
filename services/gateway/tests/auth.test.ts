import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { closePool } from '../src/db/pool.js';
import { PASSWORD, authed, registerUser, resetDb } from './helpers.js';

const app = createApp();

beforeEach(resetDb);
afterAll(closePool);

describe('POST /api/auth/register', () => {
  it('creates an account and returns a usable token', async () => {
    const { token, user } = await registerUser(app, 'ada');

    expect(user).toMatchObject({ email: 'ada@example.com', displayName: 'ada' });
    expect(user).not.toHaveProperty('passwordHash');

    const me = await authed(app, token).get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(user.id);
  });

  it('rejects a duplicate email with 409', async () => {
    await registerUser(app, 'ada');

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'ada@example.com', displayName: 'ada again', password: PASSWORD });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('rejects a short password with 400', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'ada@example.com', displayName: 'ada', password: 'short' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/auth/login', () => {
  it('returns a token for correct credentials', async () => {
    await registerUser(app, 'ada');

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ada@example.com', password: PASSWORD });

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
  });

  it('gives the same error for a wrong password and an unknown account', async () => {
    await registerUser(app, 'ada');

    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ada@example.com', password: 'not-the-password' });
    const unknownAccount = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: PASSWORD });

    expect(wrongPassword.status).toBe(401);
    expect(unknownAccount.status).toBe(401);
    // Identical responses: the API must not disclose which addresses are registered.
    expect(wrongPassword.body).toEqual(unknownAccount.body);
    expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');
  });
});

describe('GET /api/auth/me', () => {
  it('rejects a missing token', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a forged token', async () => {
    const res = await authed(app, 'not.a.jwt').get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });
});
