import { verifyAccessToken } from '../auth/jwt.js';
import { findSessionById } from '../db/sessions.js';
import { findUserById } from '../db/users.js';
import { isParticipant, toPublicUser, type PublicUser, type Session } from '../domain.js';
import { conflict, forbidden, notFound, unauthorized } from '../errors.js';

/** Shared by both WebSocket transports so a token means the same thing everywhere. */
export async function authenticateToken(token: unknown): Promise<PublicUser> {
  if (typeof token !== 'string' || token.length === 0) {
    throw unauthorized('UNAUTHENTICATED', 'An authentication token is required');
  }

  const payload = verifyAccessToken(token);
  const user = await findUserById(payload.sub);
  if (!user) {
    throw unauthorized('INVALID_TOKEN', 'Missing or invalid authentication token');
  }

  return toPublicUser(user);
}

/** Resolve the room a socket is asking to enter. */
export async function resolveJoinableSession(
  sessionId: string,
  user: PublicUser,
): Promise<Session> {
  const session = await findSessionById(sessionId);
  if (!session) throw notFound('SESSION_NOT_FOUND', 'No such session');
  if (!isParticipant(session, user.id)) {
    throw forbidden('NOT_A_PARTICIPANT', 'You are not a participant in this session');
  }
  if (session.status !== 'ACTIVE') {
    throw conflict('SESSION_ENDED', 'This session has ended');
  }
  return session;
}
