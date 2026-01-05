/** Shared domain types. Rows come out of Postgres snake_case; everything above the
 *  db layer speaks camelCase, and the mapping happens once, in `src/db/`. */

export const LANGUAGES = ['python', 'javascript'] as const;
export type Language = (typeof LANGUAGES)[number];

export type SessionStatus = 'ACTIVE' | 'ENDED';

export interface User {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  createdAt: Date;
}

/** A user as it is safe to put on the wire — no password hash, ever. */
export type PublicUser = Omit<User, 'passwordHash'>;

export function toPublicUser(user: User): PublicUser {
  const { passwordHash: _passwordHash, ...rest } = user;
  return rest;
}

export interface Session {
  id: string;
  hostId: string;
  guestId: string | null;
  language: Language;
  status: SessionStatus;
  createdAt: Date;
  endedAt: Date | null;
}

export function isParticipant(session: Session, userId: string): boolean {
  return session.hostId === userId || session.guestId === userId;
}
