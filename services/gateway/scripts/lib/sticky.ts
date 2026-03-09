/**
 * Session affinity for the proof scripts.
 *
 * Behind two gateway replicas, submissions only work if a client's document WebSocket
 * and its POST /submissions reach the same pod — the code is read from that pod's
 * in-memory Y.Doc. The ingress pins a client with a cookie, which a browser returns
 * automatically and Node's fetch and `ws` do not.
 *
 * These helpers keep a cookie jar and attach it to both, which is precisely the browser
 * behaviour the deployment assumes. Without them the scripts fail with an intermittent
 * 409 NO_DOCUMENT on roughly half of all runs.
 */
import WebSocket from 'ws';

const jar = new Map<string, string>();

function remember(response: Response): void {
  // Node exposes multiple Set-Cookie headers through getSetCookie().
  const cookies = response.headers.getSetCookie?.() ?? [];
  for (const raw of cookies) {
    const [pair] = raw.split(';');
    const index = pair?.indexOf('=') ?? -1;
    if (pair && index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1));
  }
}

export function cookieHeader(): string {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

/** fetch, with the affinity cookie carried in both directions. */
export async function stickyFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const cookie = cookieHeader();
  const response = await fetch(url, {
    ...init,
    headers: { ...init.headers, ...(cookie ? { cookie } : {}) },
  });
  remember(response);
  return response;
}

/**
 * A WebSocket class that sends the jar's cookies on the handshake.
 *
 * y-websocket constructs `new WebSocketPolyfill(url)` with no way to pass options, so
 * the header injection has to live in the class itself.
 */
export const StickyWebSocket = class extends WebSocket {
  constructor(address: string | URL, protocols?: string | string[]) {
    const cookie = cookieHeader();
    super(address, protocols, cookie ? { headers: { cookie } } : {});
  }
} as unknown as typeof globalThis.WebSocket;

/** Make one request first, so the jar holds an affinity cookie before anything else
 *  connects. Every later request and socket then lands on the same pod. */
export async function establishAffinity(baseUrl: string): Promise<void> {
  await stickyFetch(`${baseUrl}/healthz`);
}
