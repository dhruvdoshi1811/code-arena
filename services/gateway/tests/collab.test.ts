import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { closePool } from '../src/db/pool.js';
import { closeRedis, connectRedis } from '../src/realtime/redis.js';
import { CODE_TEXT_KEY, readDocumentText } from '../src/realtime/ydoc.js';
import { createGateway, type Gateway } from '../src/server.js';
import { authed, registerUser, resetDb, waitFor, type RegisteredUser } from './helpers.js';

let gateway: Gateway;
let port: number;
let host: RegisteredUser;
let guest: RegisteredUser;
let sessionId: string;

const providers: WebsocketProvider[] = [];

interface Client {
  doc: Y.Doc;
  text: Y.Text;
  provider: WebsocketProvider;
}

function connectDoc(token: string, id = sessionId): Client {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`ws://localhost:${port}/yjs`, id, doc, {
    params: { token },
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    // Critical for these tests to mean anything. y-websocket also syncs peers in the
    // same JS context over a BroadcastChannel; left enabled, two providers here would
    // reach each other without the server being involved at all and the suite would
    // pass against a gateway that does nothing.
    disableBc: true,
  });
  providers.push(provider);
  return { doc, provider, text: doc.getText(CODE_TEXT_KEY) };
}

const whenSynced = (client: Client) =>
  client.provider.synced
    ? Promise.resolve()
    : new Promise<void>((resolve) => client.provider.once('sync', () => resolve()));

beforeAll(async () => {
  await connectRedis();
  gateway = createGateway();
  port = await gateway.listen(0);
});

beforeEach(async () => {
  await resetDb();
  host = await registerUser(gateway.app, 'host');
  guest = await registerUser(gateway.app, 'guest');

  const created = await authed(gateway.app, host.token)
    .post('/api/sessions')
    .send({ language: 'python' });
  sessionId = created.body.session.id;
  await authed(gateway.app, guest.token).post(`/api/sessions/${sessionId}/join`);
});

afterEach(async () => {
  while (providers.length > 0) providers.pop()?.destroy();
  // Let the server observe the closes so each test starts with a fresh room.
  await waitFor(() => gateway.yjs.activeRooms() === 0, 5_000).catch(() => undefined);
});

afterAll(async () => {
  await gateway.close();
  await Promise.all([closePool(), closeRedis()]);
});

describe('collaborative editing', () => {
  it('converges when both participants type in the same tick', async () => {
    const a = connectDoc(host.token);
    const b = connectDoc(guest.token);
    await Promise.all([whenSynced(a), whenSynced(b)]);

    // No await between these two — the inserts are issued against both documents
    // before either has heard about the other. Sequential edits would prove nothing.
    a.text.insert(0, 'A'.repeat(40));
    b.text.insert(0, 'B'.repeat(40));

    await waitFor(() => a.text.toString() === b.text.toString() && a.text.length === 80);

    const converged = a.text.toString();
    expect(b.text.toString()).toBe(converged);
    // Nothing was dropped and nothing was invented by the merge.
    expect(converged.split('').filter((c) => c === 'A')).toHaveLength(40);
    expect(converged.split('').filter((c) => c === 'B')).toHaveLength(40);
  });

  it('loses no characters under sustained interleaved editing', async () => {
    const a = connectDoc(host.token);
    const b = connectDoc(guest.token);
    await Promise.all([whenSynced(a), whenSynced(b)]);

    for (let i = 0; i < 50; i += 1) {
      a.text.insert(a.text.length, `a${i} `);
      b.text.insert(0, `b${i} `);
    }

    await waitFor(() => a.text.toString() === b.text.toString());

    const converged = a.text.toString();
    for (let i = 0; i < 50; i += 1) {
      expect(converged).toContain(`a${i} `);
      expect(converged).toContain(`b${i} `);
    }
  });

  // A naive frame relay would pass every test above and fail this one.
  it('catches a late joiner up from the server document', async () => {
    const a = connectDoc(host.token);
    await whenSynced(a);
    a.text.insert(0, 'written before the second tab existed');
    await waitFor(() => readDocumentText(sessionId) === a.text.toString());

    const late = connectDoc(guest.token);
    await whenSynced(late);

    await waitFor(() => late.text.toString() === a.text.toString());
    expect(late.text.toString()).toBe('written before the second tab existed');
  });

  it('keeps a server-side copy of the document', async () => {
    const a = connectDoc(host.token);
    await whenSynced(a);
    a.text.insert(0, 'print("hello")');

    // Phase D reads submissions from here rather than trusting the client.
    await waitFor(() => readDocumentText(sessionId) === 'print("hello")');
    expect(readDocumentText(sessionId)).toBe('print("hello")');
  });

  it('propagates cursor awareness between participants', async () => {
    const a = connectDoc(host.token);
    const b = connectDoc(guest.token);
    await Promise.all([whenSynced(a), whenSynced(b)]);

    a.provider.awareness.setLocalStateField('user', { name: 'host', color: '#ff8800' });

    await waitFor(() =>
      [...b.provider.awareness.getStates().values()].some(
        (state) => (state as { user?: { name?: string } }).user?.name === 'host',
      ),
    );
  });

  it('retracts a cursor when its tab disconnects', async () => {
    const a = connectDoc(host.token);
    const b = connectDoc(guest.token);
    await Promise.all([whenSynced(a), whenSynced(b)]);

    a.provider.awareness.setLocalStateField('user', { name: 'host', color: '#ff8800' });
    await waitFor(() => b.provider.awareness.getStates().size >= 2);

    a.provider.destroy();

    await waitFor(
      () =>
        ![...b.provider.awareness.getStates().values()].some(
          (state) => (state as { user?: { name?: string } }).user?.name === 'host',
        ),
    );
  });

  it('tears the room down once the last participant leaves', async () => {
    const a = connectDoc(host.token);
    await whenSynced(a);
    expect(gateway.yjs.activeRooms()).toBe(1);

    a.provider.destroy();
    await waitFor(() => gateway.yjs.activeRooms() === 0);
  });
});
