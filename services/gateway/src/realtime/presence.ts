import type { PublicUser } from '../domain.js';

export interface Participant {
  userId: string;
  displayName: string;
  /** How many live sockets this user has in the room — one per open tab. */
  connections: number;
}

/**
 * Who is currently connected to which session.
 *
 * Phase A keeps this in process memory, which is correct for exactly one gateway
 * instance and wrong for two: a second instance would have its own map, and each
 * would broadcast a participant list missing everyone connected to the other.
 * Phase B moves this onto Redis pub/sub, which is what makes the gateway horizontally
 * scalable — the map here is the thing Redis replaces.
 *
 * Connections are counted rather than stored as a set of user ids so that closing one
 * of a user's two tabs does not evict them from the room.
 */
class PresenceRegistry {
  private readonly rooms = new Map<string, Map<string, Participant>>();

  join(sessionId: string, user: PublicUser): Participant[] {
    let room = this.rooms.get(sessionId);
    if (!room) {
      room = new Map();
      this.rooms.set(sessionId, room);
    }

    const existing = room.get(user.id);
    if (existing) {
      existing.connections += 1;
    } else {
      room.set(user.id, { userId: user.id, displayName: user.displayName, connections: 1 });
    }

    return this.list(sessionId);
  }

  leave(sessionId: string, userId: string): Participant[] {
    const room = this.rooms.get(sessionId);
    if (!room) return [];

    const existing = room.get(userId);
    if (existing) {
      existing.connections -= 1;
      if (existing.connections <= 0) room.delete(userId);
    }

    if (room.size === 0) this.rooms.delete(sessionId);
    return this.list(sessionId);
  }

  list(sessionId: string): Participant[] {
    return [...(this.rooms.get(sessionId)?.values() ?? [])];
  }

  /** Test helper — presence is process state, so suites must be able to reset it. */
  clear(): void {
    this.rooms.clear();
  }
}

export const presence = new PresenceRegistry();
