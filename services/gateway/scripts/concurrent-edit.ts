/**
 * Phase B proof.
 *
 * Two participants edit one document with genuinely simultaneous writes — no awaiting
 * between them, so neither has heard about the other when it types — and the result
 * must converge with every character intact. Optionally runs the two participants
 * against two different gateway instances, which forces every change through Redis.
 *
 * Usage:  npm run dev                                   (terminal 1)
 *         PORT=4001 npm run dev                         (terminal 2, optional)
 *         npm run proof:collab                          (single instance)
 *         GATEWAY_B=http://localhost:4001 npm run proof:collab   (two instances)
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';

const GATEWAY_A = process.env.GATEWAY_A ?? `http://localhost:${process.env.PORT ?? 4000}`;
const GATEWAY_B = process.env.GATEWAY_B ?? GATEWAY_A;
const PASSWORD = 'correct-horse-battery-staple';
const CODE_TEXT_KEY = 'code';
const ROUNDS = 150;

const log = (step: string, detail: unknown = '') =>
  console.log(`  ${step.padEnd(44)} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);

async function api<T>(base: string, path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const { token, ...rest } = init;
  const res = await fetch(`${base}${path}`, {
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
  api<{ token: string; user: { id: string; displayName: string } }>(GATEWAY_A, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: `${name}-${randomUUID().slice(0, 8)}@example.com`,
      displayName: name,
      password: PASSWORD,
    }),
  });

function connect(base: string, sessionId: string, token: string) {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`${base.replace(/^http/, 'ws')}/yjs`, sessionId, doc, {
    params: { token },
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    // Otherwise these two providers would find each other over a BroadcastChannel
    // inside this one process and "converge" without the gateway doing anything.
    disableBc: true,
  });
  return { doc, provider, text: doc.getText(CODE_TEXT_KEY) };
}

/** `WebsocketProvider.destroy()` does not destroy the Awareness it created, and
 *  Awareness holds a recurring timer for pruning outdated states — enough on its own to
 *  keep a Node process alive forever after the work is done. */
function closeClient(client: { doc: Y.Doc; provider: WebsocketProvider }): void {
  client.provider.awareness.destroy();
  client.provider.destroy();
  client.doc.destroy();
}

const whenSynced = (provider: WebsocketProvider) =>
  provider.synced
    ? Promise.resolve()
    : new Promise<void>((resolve) => provider.once('sync', () => resolve()));

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for convergence');
    await sleep(25);
  }
}

async function main(): Promise<void> {
  const twoInstances = GATEWAY_A !== GATEWAY_B;
  console.log(`\nCodeArena Phase B proof`);
  console.log(`  participant A -> ${GATEWAY_A}`);
  console.log(`  participant B -> ${GATEWAY_B}${twoInstances ? '  (cross-instance, via Redis)' : ''}\n`);

  const host = await register('Ada');
  const guest = await register('Grace');
  const { session } = await api<{ session: { id: string } }>(GATEWAY_A, '/api/sessions', {
    method: 'POST',
    token: host.token,
    body: JSON.stringify({ language: 'python' }),
  });
  await api(GATEWAY_A, `/api/sessions/${session.id}/join`, { method: 'POST', token: guest.token });
  log('session created and joined', session.id);

  const a = connect(GATEWAY_A, session.id, host.token);
  const b = connect(GATEWAY_B, session.id, guest.token);
  await Promise.all([whenSynced(a.provider), whenSynced(b.provider)]);
  log('both documents synced', 'ok');

  a.provider.awareness.setLocalStateField('user', { name: 'Ada', color: '#f97316' });
  b.provider.awareness.setLocalStateField('user', { name: 'Grace', color: '#22d3ee' });
  await waitFor(() => b.provider.awareness.getStates().size >= 2);
  log('cursors visible to each other', `${b.provider.awareness.getStates().size} awareness states`);

  // The actual test: interleaved writes with no await between them.
  for (let i = 0; i < ROUNDS; i += 1) {
    a.text.insert(a.text.length, `A${i} `);
    b.text.insert(0, `B${i} `);
  }
  log('issued simultaneous inserts', `${ROUNDS} from each participant`);

  await waitFor(() => a.text.toString() === b.text.toString());

  const converged = a.text.toString();
  const missing: string[] = [];
  for (let i = 0; i < ROUNDS; i += 1) {
    if (!converged.includes(`A${i} `)) missing.push(`A${i}`);
    if (!converged.includes(`B${i} `)) missing.push(`B${i}`);
  }

  log('documents identical', a.text.toString() === b.text.toString());
  log('characters', `${converged.length} (${ROUNDS * 2} inserts, none lost)`);

  if (missing.length > 0) {
    console.error(`\n  LOST ${missing.length} inserts: ${missing.slice(0, 10).join(', ')}…\n`);
    process.exit(1);
  }

  // Departure retracts the cursor rather than leaving a ghost behind. Note this relies
  // on the *server* noticing the socket close and publishing the removal — Ada's tab
  // does not get to announce it politely.
  closeClient(a);
  await waitFor(
    () =>
      ![...b.provider.awareness.getStates().values()].some(
        (state) => (state as { user?: { name?: string } }).user?.name === 'Ada',
      ),
  );
  log("Ada's cursor retracted on disconnect", 'ok');

  closeClient(b);
  console.log(
    `\nConverged with zero lost edits${twoInstances ? ' across two gateway instances.' : '.'}\n`,
  );
}

main().catch((err: unknown) => {
  console.error('\nProof failed:', err);
  process.exit(1);
});
