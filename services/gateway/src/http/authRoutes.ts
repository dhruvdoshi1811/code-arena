import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { createUser, findUserByEmail } from '../db/users.js';
import { toPublicUser } from '../domain.js';
import { unauthorized } from '../errors.js';
import { signAccessToken } from '../auth/jwt.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { currentUser, requireAuth } from '../auth/middleware.js';

// Normalise first, then validate: `z.email()` checks the raw input, so trimming and
// lowercasing have to happen upstream of it rather than chained after.
const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const password = z.string().min(8, 'Password must be at least 8 characters').max(200);

const RegisterSchema = z.object({
  email,
  displayName: z.string().trim().min(1).max(64),
  password,
});

const LoginSchema = z.object({ email, password });

/** A throwaway hash, computed once at boot, used to keep the "no such account" branch
 *  as expensive as the "wrong password" branch. Otherwise login response time is an
 *  oracle for which email addresses are registered. */
const dummyHash = hashPassword(randomUUID());

export const authRoutes = Router();

authRoutes.post('/register', async (req, res) => {
  const body = RegisterSchema.parse(req.body);
  const user = await createUser({
    email: body.email,
    displayName: body.displayName,
    passwordHash: await hashPassword(body.password),
  });

  res.status(201).json({ token: signAccessToken(user), user: toPublicUser(user) });
});

authRoutes.post('/login', async (req, res) => {
  const body = LoginSchema.parse(req.body);
  const user = await findUserByEmail(body.email);
  const passwordMatches = await verifyPassword(user?.passwordHash ?? (await dummyHash), body.password);

  // One error for both failure modes — never reveal which half was wrong.
  if (!user || !passwordMatches) {
    throw unauthorized('INVALID_CREDENTIALS', 'Email or password is incorrect');
  }

  res.json({ token: signAccessToken(user), user: toPublicUser(user) });
});

authRoutes.get('/me', requireAuth, (req, res) => {
  res.json({ user: currentUser(req) });
});
