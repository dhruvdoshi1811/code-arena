import type { RequestHandler } from 'express';
import { findUserById } from '../db/users.js';
import { toPublicUser, type PublicUser } from '../domain.js';
import { unauthorized } from '../errors.js';
import { verifyAccessToken } from './jwt.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: PublicUser;
    }
  }
}

/** Reads the bearer token, resolves it to a live user, and attaches it to the request. */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) {
    next(unauthorized('UNAUTHENTICATED', 'Authorization header with a bearer token is required'));
    return;
  }

  const payload = verifyAccessToken(header.slice('Bearer '.length).trim());
  const user = await findUserById(payload.sub);
  if (!user) {
    next(unauthorized('INVALID_TOKEN', 'Missing or invalid authentication token'));
    return;
  }

  req.user = toPublicUser(user);
  next();
};

/** Narrowing helper — `requireAuth` guarantees this, TypeScript does not know it. */
export function currentUser(req: { user?: PublicUser }): PublicUser {
  if (!req.user) {
    throw unauthorized('UNAUTHENTICATED', 'Authentication required');
  }
  return req.user;
}
