/**
 * Phase E proof.
 *
 * The host presses Run; the *guest* watches. Every event the guest receives is printed
 * with the time it arrived, so the claim being demonstrated is visible in the timings
 * rather than asserted: lines show up spread across the run, not in one lump at the end.
 *
 * Usage:  npm run dev                        (terminal 1)
 *         go run ./cmd/orchestrator          (terminal 2, from services/orchestrator)
 *         npm run proof:stream               (terminal 3)
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';

const BASE = process.env.GATEWAY_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
const PASSWORD = 'correct-horse-battery-staple';
const CODE_TEXT_KEY = 'code';

interface Arrival {
  atMs: number;
  kind: 'status' | 'output';
  detail: string;
}

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
  api<{ token: string; user: { id: string } }>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: `${name}-${randomUUID().slice(0, 8)}@example.com`,
      displayName: name,
      password: PASSWORD,
    }),
  });

async function runScenario(
  label: string,
  code: string,
  hostToken: string,
  guestToken: string,
  expectStatus: string,
): Promise<boolean> {
  console.log(`\n  --- ${label} ---`);

  const { session } = await api<{ session: { id: string } }>('/api/sessions', {
    method: 'POST',
    token: hostToken,
    body: JSON.stringify({ language: 'python' }),
  });
  await api(`/api/sessions/${session.id}/join`, { method: 'POST', token: guestToken });

  // Host writes the code into the shared document.
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`${BASE.replace(/^http/, 'ws')}/yjs`, session.id, doc, {
    params: { token: hostToken },
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    disableBc: true,
  });
  await new Promise<void>((resolve) =>
    provider.synced ? resolve() : provider.once('sync', () => resolve()),
  );
  doc.getText(CODE_TEXT_KEY).insert(0, code);
  await sleep(200);

  // The guest connects and joins the room — a different person, a different socket.
  const guest: ClientSocket = ioClient(BASE, {
    transports: ['websocket'],
    auth: { token: guestToken },
    reconnection: false,
  });
  await new Promise<void>((resolve) => guest.once('connect', () => resolve()));
  await guest.emitWithAck('session:join', { sessionId: session.id });

  const arrivals: Arrival[] = [];
  let terminal: string | null = null;
  const startedAt = Date.now();

  guest.on('submission:status', (p: { status: string; exitCode: number | null }) => {
    arrivals.push({
      atMs: Date.now() - startedAt,
      kind: 'status',
      detail: p.status + (p.exitCode !== null ? ` (exit ${p.exitCode})` : ''),
    });
    if (['COMPLETED', 'FAILED', 'TIMEOUT'].includes(p.status)) terminal = p.status;
  });
  guest.on('submission:output', (p: { lines: string[] }) => {
    for (const line of p.lines) {
      arrivals.push({ atMs: Date.now() - startedAt, kind: 'output', detail: line });
    }
  });

  await api(`/api/sessions/${session.id}/submissions`, { method: 'POST', token: hostToken });

  const deadline = Date.now() + 90_000;
  while (!terminal && Date.now() < deadline) await sleep(100);

  await sleep(400);
  guest.disconnect();
  provider.awareness.destroy();
  provider.destroy();
  doc.destroy();

  for (const a of arrivals) {
    const stamp = `+${(a.atMs / 1000).toFixed(2)}s`.padStart(8);
    console.log(
      a.kind === 'status'
        ? `  ${stamp}  [status]  ${a.detail}`
        : `  ${stamp}  [output]  ${a.detail}`,
    );
  }

  const outputs = arrivals.filter((a) => a.kind === 'output');
  const spreadMs =
    outputs.length > 1 ? outputs[outputs.length - 1]!.atMs - outputs[0]!.atMs : 0;

  const checks: [string, boolean][] = [
    [`guest saw the run reach ${expectStatus}`, terminal === expectStatus],
    ['guest received output it did not submit', outputs.length > 0],
    // The heart of it: if output only appeared at the end, everything would land within
    // a few milliseconds of the terminal status.
    ['output arrived progressively, not in one lump', spreadMs > 500],
  ];

  let ok = true;
  for (const [name, passed] of checks) {
    console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}`);
    ok &&= passed;
  }
  console.log(`        output spread over ${(spreadMs / 1000).toFixed(2)}s`);
  return ok;
}

async function main(): Promise<void> {
  console.log(`\nCodeArena Phase E proof against ${BASE}`);
  console.log('the host runs the code; every line below is what the GUEST received\n');

  const host = await register('Ada');
  const guest = await register('Grace');

  const results: boolean[] = [];

  results.push(
    await runScenario(
      'a program that prints slowly',
      [
        'import time',
        'for i in range(1, 7):',
        '    print(f"tick {i}", flush=True)',
        '    time.sleep(0.4)',
        'print("done")',
      ].join('\n'),
      host.token,
      guest.token,
      'COMPLETED',
    ),
  );

  results.push(
    await runScenario(
      'an infinite loop: partial output, then killed',
      [
        'import time',
        'i = 0',
        'while True:',
        '    i += 1',
        '    print(f"still going {i}", flush=True)',
        '    time.sleep(0.5)',
      ].join('\n'),
      host.token,
      guest.token,
      'TIMEOUT',
    ),
  );

  const failed = results.filter((ok) => !ok).length;
  console.log(
    failed === 0
      ? `\nBoth scenarios streamed live to a participant who did not submit them.\n`
      : `\n${failed}/${results.length} scenarios FAILED.\n`,
  );
  if (failed > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error('\nProof failed:', err);
  process.exit(1);
});
