import type { PublicUser } from './api';

const TOKEN_KEY = 'codearena.token';
const USER_KEY = 'codearena.user';

/**
 * Session storage for the access token.
 *
 * `localStorage` is readable by any script that runs on this origin, so an XSS bug
 * becomes token theft — an httpOnly cookie would not have that property. It is chosen
 * anyway because the token has to be handed to two WebSocket transports (Socket.io's
 * handshake auth and the `?token=` query on `/yjs`), and a cookie the JS cannot read
 * cannot be placed into either. Worth being able to name the trade-off out loud.
 */
export const authStore = {
  read(): { token: string; user: PublicUser } | null {
    const token = localStorage.getItem(TOKEN_KEY);
    const rawUser = localStorage.getItem(USER_KEY);
    if (!token || !rawUser) return null;
    try {
      return { token, user: JSON.parse(rawUser) as PublicUser };
    } catch {
      return null;
    }
  },

  write(token: string, user: PublicUser): void {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  },

  clear(): void {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  },
};

const PALETTE = [
  '#f97316',
  '#22d3ee',
  '#a78bfa',
  '#4ade80',
  '#f472b6',
  '#facc15',
  '#60a5fa',
  '#fb7185',
];

/** A stable colour per user, so the same person is the same colour in both tabs and
 *  across reloads. Derived from the id rather than assigned on arrival. */
export function colorForUser(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i += 1) {
    hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length]!;
}
