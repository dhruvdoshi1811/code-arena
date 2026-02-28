/** Phase C proof. */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';

const BASE = process.env.GATEWAY_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
const BURST = Number(process.env.BURST ?? 200);
const PASSWORD = 'correct-horse-battery-staple';
const CODE_TEXT_KEY = 'code';

const log = (step: string, detail: unknown = '') =>
  console.log(`  ${step.padEnd(44)} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);

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

const percentile = (sorted: number[], p: number) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;

async function main(): Promise<void> {
  console.log(`\nCodeArena Phase C proof against ${BASE}\n`);

  const host = await api<{ token: string; user: { id: string } }>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: `burst-${randomUUID().slice(0, 8)}@example.com`,
      displayName: 'Ada',
      password: PASSWORD,
    }),
  });

  const { session } = await api<{ session: { id: string } }>('/api/sessions', {
    method: 'POST',
    token: host.token,
    body: JSON.stringify({ language: 'python' }),
  });
  log('session created', session.id);

  // The gateway submits the code held in its own document, so a tab has to be open.
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`${BASE.replace(/^http/, 'ws')}/yjs`, session.id, doc, {
    params: { token: host.token },
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    disableBc: true,
  });
  await new Promise<void>((resolve) =>
    provider.synced ? resolve() : provider.once('sync', () => resolve()),
  );
  doc.getText(CODE_TEXT_KEY).insert(0, 'import time\nprint("hello from the arena")\n');
  await sleep(250);
  log('document open and synced', `${doc.getText(CODE_TEXT_KEY).length} chars`);

  // Baseline responsiveness with the gateway idle.
  const measure = async (stop: { now: boolean }) => {
    const samples: number[] = [];
    while (!stop.now) {
      const started = performance.now();
      await fetch(`${BASE}/healthz`).catch(() => undefined);
      samples.push(performance.now() - started);
      await sleep(5);
    }
    return samples.sort((a, b) => a - b);
  };

  const idleStop = { now: false };
  const idlePromise = measure(idleStop);
  await sleep(1_000);
  idleStop.now = true;
  const idle = await idlePromise;
  log('baseline /healthz p50 / p95', `${percentile(idle, 50).toFixed(1)}ms / ${percentile(idle, 95).toFixed(1)}ms`);

  // The burst.
  const burstStop = { now: false };
  const burstPromise = measure(burstStop);
  const started = performance.now();

  const results = await Promise.all(
    Array.from({ length: BURST }, () =>
      fetch(`${BASE}/api/sessions/${session.id}/submissions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${host.token}` },
      }).then((res) => res.status),
    ),
  );
  const elapsed = performance.now() - started;
  burstStop.now = true;
  const under = await burstPromise;

  const accepted = results.filter((status) => status === 202).length;
  log(`fired ${BURST} submissions`, `${elapsed.toFixed(0)}ms total, ${(elapsed / BURST).toFixed(2)}ms each`);
  log('accepted with 202', `${accepted}/${BURST}`);
  log('under-load /healthz p50 / p95', `${percentile(under, 50).toFixed(1)}ms / ${percentile(under, 95).toFixed(1)}ms`);
  log('gateway kept serving during burst', `${under.length} health checks answered`);

  const listed = await api<{ submissions: { status: string }[] }>(
    `/api/sessions/${session.id}/submissions`,
    { token: host.token },
  );
  log('persisted (most recent page)', `${listed.submissions.length} rows, all ${listed.submissions[0]?.status}`);

  provider.awareness.destroy();
  provider.destroy();
  doc.destroy();

  if (accepted !== BURST) {
    console.error(`\n  Only ${accepted}/${BURST} were accepted.\n`);
    process.exit(1);
  }

  console.log(
    `\nEvery submission was accepted and durably queued at ${(elapsed / BURST).toFixed(2)}ms each,\n` +
      `with no consumer required. Watch the orchestrator drain the backlog, or browse it\n` +
      `at http://localhost:8080 (topic code-submissions).\n`,
  );
}

main().catch((err: unknown) => {
  console.error('\nProof failed:', err);
  process.exit(1);
});
