import type { AppIoServer } from './socket.js';

export interface Participant {
  userId: string;
  displayName: string;
  /** How many live sockets this user has in the room — one per open tab. */
  connections: number;
}

export const roomKey = (sessionId: string) => `session:${sessionId}`;

/**
 * Who is currently in a session, derived from the Socket.io adapter rather than
 * tracked beside it.
 *
 * Phase A kept a process-local `Map` here, which was correct for exactly one gateway
 * instance and wrong for two — each would have broadcast a participant list missing
 * everyone connected to the other. With the Redis adapter attached, `fetchSockets()`
 * asks every instance and returns the union, so the adapter *is* the source of truth
 * and there is no second copy of the answer to drift out of sync with it.
 *
 * Connections are counted per user rather than deduplicated to a set of ids, so closing
 * one of a user's two tabs does not evict them from the room.
 */
export async function listParticipants(
  io: AppIoServer,
  sessionId: string,
): Promise<Participant[]> {
  const sockets = await io.in(roomKey(sessionId)).fetchSockets();

  const byUser = new Map<string, Participant>();
  for (const socket of sockets) {
    const user = socket.data.user;
    if (!user) continue;

    const existing = byUser.get(user.id);
    if (existing) {
      existing.connections += 1;
    } else {
      byUser.set(user.id, { userId: user.id, displayName: user.displayName, connections: 1 });
    }
  }

  return [...byUser.values()];
}

/** Recompute and fan out to everyone in the room, on every instance. */
export async function broadcastPresence(
  io: AppIoServer,
  sessionId: string,
): Promise<Participant[]> {
  const participants = await listParticipants(io, sessionId);
  io.to(roomKey(sessionId)).emit('presence:update', { sessionId, participants });
  return participants;
}
