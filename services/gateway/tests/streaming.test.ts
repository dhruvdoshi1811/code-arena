import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { closePool } from '../src/db/pool.js';
import { connectKafka, disconnectKafka } from '../src/kafka/producer.js';
import { executionChannelFor } from '../src/realtime/execution.js';
import { closeRedis, connectRedis, publishText } from '../src/realtime/redis.js';
import { createGateway, type Gateway } from '../src/server.js';
import { authed, nextEvent, registerUser, resetDb, type RegisteredUser } from './helpers.js';

/** Phase E relay. */

let gateway: Gateway;
let port: number;
let host: RegisteredUser;
let guest: RegisteredUser;
let bystander: RegisteredUser;
let sessionId: string;
let otherSessionId: string;

const openSockets: ClientSocket[] = [];

function connect(token: string): ClientSocket {
  const socket = ioClient(`http://localhost:${port}`, {
    transports: ['websocket'],
    auth: { token },
    reconnection: false,
  });
  openSockets.push(socket);
  return socket;
}

async function joinedSocket(token: string, room: string): Promise<ClientSocket> {
  const socket = connect(token);
  await nextEvent(socket, 'connect');
  await socket.emitWithAck('session:join', { sessionId: room });
  return socket;
}

// Real UUIDs: the relay validates ids and drops anything malformed.
const statusEvent = (status: string, exitCode: number | null = null) =>
  JSON.stringify({ type: 'status', submissionId: randomUUID(), sessionId, status, exitCode });

const outputEvent = (lines: string[]) =>
  JSON.stringify({ type: 'output', submissionId: randomUUID(), sessionId, lines });

beforeAll(async () => {
  await connectRedis();
  await connectKafka();
  gateway = createGateway();
  port = await gateway.listen(0);
  // The relay subscribes asynchronously at construction; give it a beat to land.
  await new Promise((resolve) => setTimeout(resolve, 300));
}, 60_000);

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

  const other = await authed(gateway.app, bystander.token)
    .post('/api/sessions')
    .send({ language: 'python' });
  otherSessionId = other.body.session.id;
});

afterEach(() => {
  while (openSockets.length > 0) openSockets.pop()?.disconnect();
});

afterAll(async () => {
  await gateway.close();
  await Promise.all([closePool(), closeRedis(), disconnectKafka()]);
}, 30_000);

describe('execution event relay', () => {
  it('delivers status transitions to a participant', async () => {
    const socket = await joinedSocket(host.token, sessionId);
    const received = nextEvent<{ submissionId: string; status: string; exitCode: number | null }>(
      socket,
      'submission:status',
    );

    const payload = statusEvent('RUNNING');
    await publishText(executionChannelFor(sessionId), payload);

    const event = await received;
    expect(event.status).toBe('RUNNING');
    expect(event.submissionId).toBe(JSON.parse(payload).submissionId);
  });

  it('delivers output lines to a participant', async () => {
    const socket = await joinedSocket(host.token, sessionId);
    const received = nextEvent<{ lines: string[] }>(socket, 'submission:output');

    await publishText(executionChannelFor(sessionId), outputEvent(['line one', 'line two']));

    expect((await received).lines).toEqual(['line one', 'line two']);
  });

  it('delivers to both participants of the same session', async () => {
    const hostSocket = await joinedSocket(host.token, sessionId);
    const guestSocket = await joinedSocket(guest.token, sessionId);

    const both = Promise.all([
      nextEvent<{ lines: string[] }>(hostSocket, 'submission:output'),
      nextEvent<{ lines: string[] }>(guestSocket, 'submission:output'),
    ]);

    await publishText(executionChannelFor(sessionId), outputEvent(['shared']));

    const [forHost, forGuest] = await both;
    expect(forHost.lines).toEqual(['shared']);
    expect(forGuest.lines).toEqual(['shared']);
  });

  // The assertion that matters most in this file: output from someone else's session is other.
  it('does not leak events to a socket in a different session', async () => {
    const insider = await joinedSocket(host.token, sessionId);
    const outsider = await joinedSocket(bystander.token, otherSessionId);

    let leaked = false;
    outsider.on('submission:output', () => {
      leaked = true;
    });
    outsider.on('submission:status', () => {
      leaked = true;
    });

    const delivered = nextEvent(insider, 'submission:output');
    await publishText(executionChannelFor(sessionId), outputEvent(['secret']));
    await delivered;

    // Give any errant delivery the same window the legitimate one already had.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(leaked).toBe(false);
  });

  it('does not deliver to an authenticated socket that never joined the room', async () => {
    const idle = connect(guest.token);
    await nextEvent(idle, 'connect');

    let received = false;
    idle.on('submission:output', () => {
      received = true;
    });

    const joined = await joinedSocket(host.token, sessionId);
    const delivered = nextEvent(joined, 'submission:output');
    await publishText(executionChannelFor(sessionId), outputEvent(['members only']));
    await delivered;

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(received).toBe(false);
  });

  it('ignores a malformed event without disturbing the socket', async () => {
    const socket = await joinedSocket(host.token, sessionId);

    await publishText(executionChannelFor(sessionId), 'not json at all');
    await publishText(executionChannelFor(sessionId), JSON.stringify({ type: 'nonsense' }));

    // The relay survived, so a well-formed event still arrives.
    const received = nextEvent<{ lines: string[] }>(socket, 'submission:output');
    await publishText(executionChannelFor(sessionId), outputEvent(['still here']));
    expect((await received).lines).toEqual(['still here']);
  });

  it('emits one socket message per published batch, not one per line', async () => {
    const socket = await joinedSocket(host.token, sessionId);

    let messages = 0;
    let lines = 0;
    socket.on('submission:output', (payload: { lines: string[] }) => {
      messages += 1;
      lines += payload.lines.length;
    });

    // The orchestrator batches upstream; the relay must not un-batch it on the way out.
    await publishText(
      executionChannelFor(sessionId),
      outputEvent(Array.from({ length: 64 }, (_, i) => `line ${i}`)),
    );
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(lines).toBe(64);
    expect(messages).toBe(1);
  });

  // Guards the duplicate-emit trap: `io.local` means this instance serves its own sockets exactly.
  it('delivers exactly one copy of each event', async () => {
    const socket = await joinedSocket(host.token, sessionId);

    let count = 0;
    socket.on('submission:status', () => {
      count += 1;
    });

    await publishText(executionChannelFor(sessionId), statusEvent('COMPLETED', 0));
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(count).toBe(1);
  });
});
