import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { closePool } from '../src/db/pool.js';
import type { Participant } from '../src/realtime/presence.js';
import { closeRedis, connectRedis } from '../src/realtime/redis.js';
import { createGateway, type Gateway } from '../src/server.js';
import { authed, connectYjs, nextEvent, registerUser, resetDb, type RegisteredUser } from './helpers.js';

let gateway: Gateway;
let port: number;
let host: RegisteredUser;
let guest: RegisteredUser;
let bystander: RegisteredUser;
let sessionId: string;

const openSockets: ClientSocket[] = [];

function connect(token?: string): ClientSocket {
  const socket = ioClient(`http://localhost:${port}`, {
    transports: ['websocket'],
    auth: token ? { token } : {},
    reconnection: false,
  });
  openSockets.push(socket);
  return socket;
}

const yjsUrl = (id: string, token: string) => `ws://localhost:${port}/yjs/${id}?token=${token}`;

beforeAll(async () => {
  await connectRedis();
  gateway = createGateway();
  port = await gateway.listen(0);
});

beforeEach(async () => {
  await resetDb();

  host = await registerUser(gateway.app, 'host');
  guest = await registerUser(gateway.app, 'guest');
  bystander = await registerUser(gateway.app, 'bystander');

  const created = await authed(gateway.app, host.token)
    .post('/api/sessions')
    .send({ language: 'python' });
  sessionId = created.body.session.id;
  await authed(gateway.app, guest.token).post(`/api/sessions/${sessionId}/join`);
});

afterEach(() => {
  while (openSockets.length > 0) openSockets.pop()?.disconnect();
});

afterAll(async () => {
  await gateway.close();
  await Promise.all([closePool(), closeRedis()]);
});

describe('socket.io handshake', () => {
  it('rejects a connection with no token', async () => {
    const err = await nextEvent<Error & { data?: { code: string } }>(connect(), 'connect_error');
    expect(err.data?.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a connection with a forged token', async () => {
    const err = await nextEvent<Error & { data?: { code: string } }>(
      connect('not.a.jwt'),
      'connect_error',
    );
    expect(err.data?.code).toBe('INVALID_TOKEN');
  });

  it('accepts a valid token', async () => {
    const socket = connect(host.token);
    await nextEvent(socket, 'connect');
    expect(socket.connected).toBe(true);
  });
});

describe('session rooms', () => {
  it('puts both participants in the room and tells each about the other', async () => {
    const hostSocket = connect(host.token);
    await nextEvent(hostSocket, 'connect');
    const hostJoin = await hostSocket.emitWithAck('session:join', { sessionId });
    expect(hostJoin).toMatchObject({ ok: true });

    // Arm the listener before the guest joins, so the broadcast cannot be missed.
    const hostSeesGuest = nextEvent<{ participants: Participant[] }>(hostSocket, 'presence:update');

    const guestSocket = connect(guest.token);
    await nextEvent(guestSocket, 'connect');
    const guestJoin = (await guestSocket.emitWithAck('session:join', { sessionId })) as {
      ok: true;
      participants: Participant[];
    };

    expect(guestJoin.participants.map((p) => p.userId).sort()).toEqual(
      [host.user.id, guest.user.id].sort(),
    );

    const broadcast = await hostSeesGuest;
    expect(broadcast.participants).toHaveLength(2);
  });

  it('broadcasts the shrunken list when a participant disconnects', async () => {
    const hostSocket = connect(host.token);
    await nextEvent(hostSocket, 'connect');
    await hostSocket.emitWithAck('session:join', { sessionId });

    const guestSocket = connect(guest.token);
    await nextEvent(guestSocket, 'connect');
    await guestSocket.emitWithAck('session:join', { sessionId });

    const hostSeesDeparture = nextEvent<{ participants: Participant[] }>(
      hostSocket,
      'presence:update',
    );
    guestSocket.disconnect();

    const broadcast = await hostSeesDeparture;
    expect(broadcast.participants.map((p) => p.userId)).toEqual([host.user.id]);
  });

  it('refuses a non-participant joining the room', async () => {
    const socket = connect(bystander.token);
    await nextEvent(socket, 'connect');

    const ack = (await socket.emitWithAck('session:join', { sessionId })) as {
      ok: false;
      error: { code: string };
    };
    expect(ack.ok).toBe(false);
    expect(ack.error.code).toBe('NOT_A_PARTICIPANT');
  });

  it('rejects a malformed session id', async () => {
    const socket = connect(host.token);
    await nextEvent(socket, 'connect');

    const ack = (await socket.emitWithAck('session:join', { sessionId: 'nope' })) as {
      ok: false;
      error: { code: string };
    };
    expect(ack.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('yjs transport', () => {
  it('accepts a participant with a valid token', async () => {
    await expect(connectYjs(yjsUrl(sessionId, host.token))).resolves.toEqual({ ok: true });
  });

  it('rejects a forged token with 401', async () => {
    await expect(connectYjs(yjsUrl(sessionId, 'not.a.jwt'))).resolves.toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it('rejects a non-participant with 403', async () => {
    await expect(connectYjs(yjsUrl(sessionId, bystander.token))).resolves.toMatchObject({
      ok: false,
      status: 403,
    });
  });

  // The two transports share one port.
  it('rejects an unrecognised upgrade path with 404', async () => {
    await expect(connectYjs(`ws://localhost:${port}/definitely-not-a-transport`)).resolves.toMatchObject(
      { ok: false, status: 404 },
    );
  });
});
