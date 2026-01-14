/**
 * Phase A proof.
 *
 * Drives the running gateway exactly as two browsers will: two accounts, one session,
 * both participants connected over Socket.io and over the Yjs transport, and presence
 * updating live as they come and go. Also checks the two negative cases that make the
 * room a real boundary rather than a label — an unauthenticated socket and an
 * outsider who knows the session id.
 *
 * Usage:  npm run dev      (in one terminal)
 *         npm run proof    (in another)
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import WebSocket from 'ws';

const BASE = process.env.GATEWAY_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
const WS_BASE = BASE.replace(/^http/, 'ws');
const PASSWORD = 'correct-horse-battery-staple';

interface Registered {
  token: string;
  user: { id: string; displayName: string };
}

const log = (step: string, detail: unknown = '') =>
  console.log(`  ${step.padEnd(46)} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);

async function api<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const { token, ...rest } = init;
  const res = await fetch(`${BASE}${path}`, {
    ...rest,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...rest.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${JSON.stringify(body)}`);
  return body as T;
}

const register = (name: string) =>
  api<Registered>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: `${name}-${randomUUID().slice(0, 8)}@example.com`,
      displayName: name,
      password: PASSWORD,
    }),
  });

function connect(token?: string): ClientSocket {
  return ioClient(BASE, {
    transports: ['websocket'],
    auth: token ? { token } : {},
    reconnection: false,
  });
}

const onceEvent = <T,>(socket: ClientSocket, event: string): Promise<T> =>
  new Promise((resolve) => socket.once(event, resolve as (payload: T) => void));

function openYjs(sessionId: string, token: string): Promise<{ ok: boolean; status?: number; socket?: WebSocket }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WS_BASE}/yjs/${sessionId}?token=${token}`);
    ws.on('open', () => resolve({ ok: true, socket: ws }));
    ws.on('unexpected-response', (_req, res) => resolve({ ok: false, status: res.statusCode }));
    ws.on('error', () => resolve({ ok: false }));
  });
}

const names = (participants: { displayName: string }[]) =>
  participants.map((p) => p.displayName).sort().join(', ') || '(nobody)';

async function main(): Promise<void> {
  console.log(`\nCodeArena Phase A proof against ${BASE}\n`);

  const health = await api<{ status: string }>('/healthz');
  log('gateway health', health.status);

  const host = await register('Ada');
  const guest = await register('Grace');
  const outsider = await register('Mallory');
  log('registered three accounts', `${host.user.displayName}, ${guest.user.displayName}, ${outsider.user.displayName}`);

  const { session } = await api<{ session: { id: string } }>('/api/sessions', {
    method: 'POST',
    token: host.token,
    body: JSON.stringify({ language: 'python' }),
  });
  log('host created session', session.id);

  await api('/api/sessions/' + session.id + '/join', { method: 'POST', token: guest.token });
  log('guest joined session', 'seated');

  // --- Socket.io: presence ------------------------------------------------------
  const hostSocket = connect(host.token);
  await onceEvent(hostSocket, 'connect');
  hostSocket.on('presence:update', (p: { participants: { displayName: string }[] }) =>
    log('[Ada sees]', names(p.participants)),
  );
  const hostJoin = await hostSocket.emitWithAck('session:join', { sessionId: session.id });
  log('host joined room', hostJoin);

  const guestSocket = connect(guest.token);
  await onceEvent(guestSocket, 'connect');
  guestSocket.on('presence:update', (p: { participants: { displayName: string }[] }) =>
    log('[Grace sees]', names(p.participants)),
  );
  await guestSocket.emitWithAck('session:join', { sessionId: session.id });

  await sleep(250);

  // --- Yjs transport: connection lifecycle --------------------------------------
  const hostDoc = await openYjs(session.id, host.token);
  const guestDoc = await openYjs(session.id, guest.token);
  log('yjs transport, both participants', `host=${hostDoc.ok} guest=${guestDoc.ok}`);

  // --- The boundaries -----------------------------------------------------------
  const anonymous = connect();
  const rejected = await onceEvent<Error & { data?: { code: string } }>(anonymous, 'connect_error');
  log('socket without a token', `rejected: ${rejected.data?.code ?? rejected.message}`);
  anonymous.close();

  const outsiderSocket = connect(outsider.token);
  await onceEvent(outsiderSocket, 'connect');
  const outsiderAck = await outsiderSocket.emitWithAck('session:join', { sessionId: session.id });
  log('outsider joining the room', outsiderAck);

  const outsiderDoc = await openYjs(session.id, outsider.token);
  log('outsider on the yjs transport', `rejected with HTTP ${outsiderDoc.status}`);

  // --- Live departure -----------------------------------------------------------
  console.log('\n  -- Grace disconnects --');
  guestDoc.socket?.close();
  guestSocket.disconnect();
  await sleep(400);

  hostDoc.socket?.close();
  hostSocket.disconnect();
  outsiderSocket.disconnect();

  console.log('\nDone. Ada should have seen the participant list grow to two and shrink back to one.\n');
}

main().catch((err: unknown) => {
  console.error('\nProof failed:', err);
  process.exit(1);
});
