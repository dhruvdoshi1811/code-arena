import { verifyAccessToken } from '../auth/jwt.js';
import { findSessionById } from '../db/sessions.js';
import { findUserById } from '../db/users.js';
import { isParticipant, toPublicUser, type PublicUser, type Session } from '../domain.js';
import { conflict, forbidden, notFound, unauthorized } from '../errors.js';

/** Shared by both WebSocket transports so a token means exactly the same thing on
 *  `/socket.io` as it does on `/yjs`, and as it does on the REST API. */
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

/**
 * Resolve the room a socket is asking to enter.
 *
 * Membership is re-checked against Postgres rather than trusted from the client. The
 * session id travels over the wire from the browser, so treating it as proof of
 * membership would let anyone who guessed or was told an id stream another pair's
 * keystrokes. The REST join endpoint is the only thing that can seat a participant;
 * this only reads back what it decided.
 */
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
