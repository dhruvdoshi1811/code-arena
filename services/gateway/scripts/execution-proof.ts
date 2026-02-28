/** Phase D proof. */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';

const BASE = process.env.GATEWAY_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
const PASSWORD = 'correct-horse-battery-staple';
const CODE_TEXT_KEY = 'code';

type Language = 'python' | 'javascript';

interface Submission {
  id: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'TIMEOUT';
  output: string | null;
  exitCode: number | null;
}

let token = '';

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${JSON.stringify(body)}`);
  return body as T;
}

/** Create a session, open its document, and write the code the gateway will submit. */
async function stage(language: Language, code: string) {
  const { session } = await api<{ session: { id: string } }>('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ language }),
  });

  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`${BASE.replace(/^http/, 'ws')}/yjs`, session.id, doc, {
    params: { token },
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    disableBc: true,
  });
  await new Promise<void>((resolve) =>
    provider.synced ? resolve() : provider.once('sync', () => resolve()),
  );
  doc.getText(CODE_TEXT_KEY).insert(0, code);
  await sleep(200);

  return {
    sessionId: session.id,
    close() {
      provider.awareness.destroy();
      provider.destroy();
      doc.destroy();
    },
  };
}

async function submit(sessionId: string): Promise<string> {
  const { submission } = await api<{ submission: Submission }>(
    `/api/sessions/${sessionId}/submissions`,
    { method: 'POST' },
  );
  return submission.id;
}

async function awaitTerminal(sessionId: string, submissionId: string, timeoutMs = 90_000) {
  const started = Date.now();
  for (;;) {
    const { submissions } = await api<{ submissions: Submission[] }>(
      `/api/sessions/${sessionId}/submissions`,
    );
    const found = submissions.find((s) => s.id === submissionId);
    if (found && ['COMPLETED', 'FAILED', 'TIMEOUT'].includes(found.status)) {
      return { ...found, elapsedMs: Date.now() - started };
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`submission ${submissionId} never reached a terminal state`);
    }
    await sleep(250);
  }
}

function report(label: string, result: Submission & { elapsedMs: number }, expected: string) {
  const ok = result.status === expected;
  const firstLine = (result.output ?? '').split('\n').filter(Boolean)[0] ?? '(no output)';
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(30)} ` +
      `${result.status.padEnd(10)} exit=${String(result.exitCode ?? '-').padEnd(4)} ` +
      `${(result.elapsedMs / 1000).toFixed(1)}s  ${JSON.stringify(firstLine).slice(0, 60)}`,
  );
  return ok;
}

async function runCase(label: string, language: Language, code: string, expected: string) {
  const staged = await stage(language, code);
  const id = await submit(staged.sessionId);
  const result = await awaitTerminal(staged.sessionId, id);
  staged.close();
  return report(label, result, expected);
}

async function main(): Promise<void> {
  console.log(`\nCodeArena Phase D proof against ${BASE}\n`);

  const auth = await api<{ token: string }>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: `exec-${randomUUID().slice(0, 8)}@example.com`,
      displayName: 'Ada',
      password: PASSWORD,
    }),
  });
  token = auth.token;

  const results: boolean[] = [];

  console.log('  --- ordinary execution ---');
  results.push(await runCase('python hello', 'python', 'print("hello from the arena")', 'COMPLETED'));
  results.push(
    await runCase('javascript hello', 'javascript', 'console.log("hello from node")', 'COMPLETED'),
  );
  results.push(
    await runCase(
      'python runtime error',
      'python',
      'raise ValueError("boom")',
      'FAILED',
    ),
  );
  results.push(
    await runCase(
      'memory limit exceeded',
      'python',
      'x = bytearray(512 * 1024 * 1024)\nprint("allocated")',
      'FAILED',
    ),
  );

  // The sandbox reports on itself.
  console.log('\n  --- sandbox, as seen from inside the container ---');
  const introspect = await stage(
    'python',
    [
      'import os',
      'print("uid", os.geteuid())',
      'print("sa_token", os.path.exists("/var/run/secrets/kubernetes.io/serviceaccount/token"))',
      'try:',
      '    open("/probe", "w").close(); print("root_writable", True)',
      'except OSError:',
      '    print("root_writable", False)',
      'try:',
      '    open("/tmp/probe", "w").close(); print("tmp_writable", True)',
      'except OSError:',
      '    print("tmp_writable", False)',
    ].join('\n'),
  );
  const introspectId = await submit(introspect.sessionId);
  const introspection = await awaitTerminal(introspect.sessionId, introspectId);
  introspect.close();

  const lines = (introspection.output ?? '').split('\n');
  const readback = (key: string) => lines.find((l) => l.startsWith(key + ' '))?.split(' ')[1] ?? '?';

  const expectations: [string, string, string][] = [
    ['runs as non-root', readback('uid'), '65532'],
    ['no serviceaccount token', readback('sa_token'), 'False'],
    ['root filesystem read-only', readback('root_writable'), 'False'],
    ['/tmp writable for scratch', readback('tmp_writable'), 'True'],
  ];
  for (const [label, actual, expected] of expectations) {
    const ok = actual === expected;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(30)} got ${actual}, want ${expected}`);
    results.push(ok);
  }

  // --- the core proof -------------------------------------------------------------
  console.log('\n  --- the core proof: infinite loop, killed at the deadline ---');
  console.log('  submitting an infinite loop and a normal program at the same moment\n');

  const loop = await stage(
    'python',
    'import sys\nprint("starting an infinite loop", flush=True)\nwhile True:\n    pass\n',
  );
  const normal = await stage('python', 'print("i am a well-behaved neighbour")');

  const [loopId, normalId] = await Promise.all([submit(loop.sessionId), submit(normal.sessionId)]);

  const [loopResult, normalResult] = await Promise.all([
    awaitTerminal(loop.sessionId, loopId),
    awaitTerminal(normal.sessionId, normalId),
  ]);

  loop.close();
  normal.close();

  results.push(report('infinite loop', loopResult, 'TIMEOUT'));
  results.push(report('concurrent neighbour', normalResult, 'COMPLETED'));

  // Budget: 10s deadline + 5s termination grace + scheduling and queue overhead.
  const KILL_BUDGET_MS = 28_000;
  const killedPromptly = loopResult.elapsedMs < KILL_BUDGET_MS;
  console.log(
    `  ${killedPromptly ? 'PASS' : 'FAIL'}  ${'killed near its deadline'.padEnd(30)} ` +
      `${(loopResult.elapsedMs / 1000).toFixed(1)}s wall clock ` +
      `(10s deadline + 5s grace + overhead, budget ${KILL_BUDGET_MS / 1000}s)`,
  );
  results.push(killedPromptly);

  // Partial output survived even though the pod was deleted by the Job controller.
  const capturedPartial = (loopResult.output ?? '').includes('starting an infinite loop');
  console.log(
    `  ${capturedPartial ? 'PASS' : 'FAIL'}  ${'partial output captured'.padEnd(30)} ` +
      `output before the kill was retained`,
  );
  results.push(capturedPartial);

  const failed = results.filter((ok) => !ok).length;
  console.log(
    failed === 0
      ? `\nAll ${results.length} checks passed.\n`
      : `\n${failed}/${results.length} checks FAILED.\n`,
  );
  if (failed > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error('\nProof failed:', err);
  process.exit(1);
});
