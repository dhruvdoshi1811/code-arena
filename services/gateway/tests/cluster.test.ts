import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { closePool } from '../src/db/pool.js';
import { closeRedis, connectRedis, instanceId } from '../src/realtime/redis.js';
import { CODE_TEXT_KEY } from '../src/realtime/ydoc.js';
import { createGateway, type Gateway } from '../src/server.js';
import {
  authed,
  nextEvent,
  registerUser,
  resetDb,
  waitFor,
  type RegisteredUser,
} from './helpers.js';

/**
 * The Redis proof.
 *
 * Gateway A runs in this process; gateway B is spawned as a real child process. That
 * separation is the whole point — two gateways constructed in one process would share
 * every module-level singleton (the instance id, the Redis clients, and the document
 * room registry itself), so they would "agree" without a single byte crossing Redis.
 * Only distinct processes can demonstrate that the bridge is what carries the change.
 */

let gatewayA: Gateway;
let portA: number;
let portB: number;
let child: ChildProcess;
let childOutput = '';

let host: RegisteredUser;
let guest: RegisteredUser;
let sessionId: string;

const providers: WebsocketProvider[] = [];
const sockets: ClientSocket[] = [];

function connectDoc(port: number, token: string): { doc: Y.Doc; text: Y.Text; provider: WebsocketProvider } {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`ws://localhost:${port}/yjs`, sessionId, doc, {
    params: { token },
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    // Without this the two providers would gossip over a BroadcastChannel inside this
    // process and converge with both gateways switched off.
    disableBc: true,
  });
  providers.push(provider);
  return { doc, provider, text: doc.getText(CODE_TEXT_KEY) };
}

const whenSynced = (provider: WebsocketProvider) =>
  provider.synced
    ? Promise.resolve()
    : new Promise<void>((resolve) => provider.once('sync', () => resolve()));

function connectSocket(port: number, token: string): ClientSocket {
  const socket = ioClient(`http://localhost:${port}`, {
    transports: ['websocket'],
    auth: { token },
    reconnection: false,
  });
  sockets.push(socket);
  return socket;
}

/** Bind to an ephemeral port, note it, release it, and hand it to the child. */
function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port: number, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://localhost:${port}/healthz`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      throw new Error(`second gateway never became healthy. Output:\n${childOutput}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

beforeAll(async () => {
  await connectRedis();
  gatewayA = createGateway();
  portA = await gatewayA.listen(0);

  portB = await reservePort();
  // `--import tsx` rather than the tsx shim, which is a .cmd on Windows and would need
  // a shell. The child inherits the test environment, so it shares the same database,
  // the same Redis, and critically the same JWT secret.
  child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: { ...process.env, PORT: String(portB), NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => (childOutput += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (childOutput += chunk.toString()));

  await waitForHealth(portB);
}, 90_000);

beforeAll(async () => {
  await resetDb();
  host = await registerUser(gatewayA.app, 'host');
  guest = await registerUser(gatewayA.app, 'guest');

  const created = await authed(gatewayA.app, host.token)
    .post('/api/sessions')
    .send({ language: 'python' });
  sessionId = created.body.session.id;
  await authed(gatewayA.app, guest.token).post(`/api/sessions/${sessionId}/join`);
});

afterAll(async () => {
  while (providers.length > 0) providers.pop()?.destroy();
  while (sockets.length > 0) sockets.pop()?.disconnect();

  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (child.exitCode === null) child.kill('SIGKILL');

  await gatewayA.close();
  await Promise.all([closePool(), closeRedis()]);
}, 30_000);

describe('two gateway instances over Redis', () => {
  // Guards the premise of every test below: if the child ever failed to start, or
  // somehow shared this process's state, the rest of this file would prove nothing.
  it('really is a second process with its own instance id', () => {
    expect(child.pid).toBeGreaterThan(0);
    expect(child.exitCode).toBeNull();

    const reported = /instance\s+([0-9a-f-]{36})/.exec(childOutput)?.[1];
    expect(reported, `child output was:\n${childOutput}`).toBeDefined();
    expect(reported).not.toBe(instanceId);
  });

  it('converges a document edited on both instances at once', async () => {
    const a = connectDoc(portA, host.token);
    const b = connectDoc(portB, guest.token);
    await Promise.all([whenSynced(a.provider), whenSynced(b.provider)]);

    // Same tick, different processes.
    a.text.insert(0, 'A'.repeat(30));
    b.text.insert(0, 'B'.repeat(30));

    await waitFor(() => a.text.toString() === b.text.toString() && a.text.length === 60);

    const converged = a.text.toString();
    expect(b.text.toString()).toBe(converged);
    expect(converged.split('').filter((c) => c === 'A')).toHaveLength(30);
    expect(converged.split('').filter((c) => c === 'B')).toHaveLength(30);
  }, 30_000);

  it('carries cursor awareness across instances', async () => {
    const a = connectDoc(portA, host.token);
    const b = connectDoc(portB, guest.token);
    await Promise.all([whenSynced(a.provider), whenSynced(b.provider)]);

    a.provider.awareness.setLocalStateField('user', { name: 'on-instance-a', color: '#00aaff' });

    await waitFor(() =>
      [...b.provider.awareness.getStates().values()].some(
        (state) => (state as { user?: { name?: string } }).user?.name === 'on-instance-a',
      ),
    );
  }, 30_000);

  // The failure this guards against: instance B never sees A's socket close, so without
  // publishing awareness removals it would keep rendering a cursor for a departed tab.
  it('retracts a cursor across instances when its tab disconnects', async () => {
    const a = connectDoc(portA, host.token);
    const b = connectDoc(portB, guest.token);
    await Promise.all([whenSynced(a.provider), whenSynced(b.provider)]);

    a.provider.awareness.setLocalStateField('user', { name: 'departing', color: '#ff0055' });
    await waitFor(() =>
      [...b.provider.awareness.getStates().values()].some(
        (state) => (state as { user?: { name?: string } }).user?.name === 'departing',
      ),
    );

    a.provider.destroy();

    await waitFor(
      () =>
        ![...b.provider.awareness.getStates().values()].some(
          (state) => (state as { user?: { name?: string } }).user?.name === 'departing',
        ),
    );
  }, 30_000);

  // Phase A's in-memory presence map could not have passed this.
  it('lists participants connected to the other instance', async () => {
    const socketA = connectSocket(portA, host.token);
    await nextEvent(socketA, 'connect');
    await socketA.emitWithAck('session:join', { sessionId });

    const socketB = connectSocket(portB, guest.token);
    await nextEvent(socketB, 'connect');
    const joinB = (await socketB.emitWithAck('session:join', { sessionId })) as {
      ok: true;
      participants: { userId: string }[];
    };

    expect(joinB.participants.map((p) => p.userId).sort()).toEqual(
      [host.user.id, guest.user.id].sort(),
    );
  }, 30_000);
});
