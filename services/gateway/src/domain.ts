/** Shared domain types. */

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

export type SubmissionStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'TIMEOUT';

export interface Submission {
  id: string;
  sessionId: string;
  userId: string;
  language: Language;
  code: string;
  status: SubmissionStatus;
  output: string | null;
  exitCode: number | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/** The Kafka message body, and the contract between two services in two languages. */
export interface SubmissionEvent {
  submissionId: string;
  sessionId: string;
  userId: string;
  language: Language;
  code: string;
  createdAt: string;
}

