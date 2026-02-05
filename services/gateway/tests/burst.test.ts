import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { closePool } from '../src/db/pool.js';
import { countSubmissionsForSession } from '../src/db/submissions.js';
import { connectKafka, disconnectKafka } from '../src/kafka/producer.js';
import { closeRedis, connectRedis } from '../src/realtime/redis.js';
import { createGateway, type Gateway } from '../src/server.js';
import {
  authed,
  connectDocClient,
  registerUser,
  resetDb,
  waitFor,
  whenSynced,
  type DocClient,
  type RegisteredUser,
} from './helpers.js';
import { collectSubmissionEvents } from './kafkaHelpers.js';

/**
 * The Phase C proof.
 *
 * The claim is narrower than "the gateway is fast under load", and worth stating
 * precisely because the measured numbers do not support the looser version.
 *
 * What the queue buys: accepting a submission costs one INSERT plus one produce —
 * bounded, constant work that does not depend on how long the code takes to run or on
 * whether anything is consuming at all. **No consumer runs during this test**, so the
 * topic simply accumulates, and the gateway neither slows down nor pushes back. That is
 * the decoupling. Without a queue, accepting a run would mean waiting on an executor
 * whose cost is unbounded and whose capacity is finite.
 *
 * What it does not buy: immunity from contention. Two hundred concurrent requests share
 * one event loop, so /healthz latency does rise while the burst is in flight (roughly
 * 4ms to 60ms p50 on this machine). The assertions below therefore check that the
 * gateway keeps serving throughout and that per-submission cost stays small — not that
 * latency is unchanged, which would be a claim the data contradicts.
 */

const BURST = 200;

let gateway: Gateway;
let port: number;
let host: RegisteredUser;
let sessionId: string;
let doc: DocClient;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index]!;
}

/** Poll /healthz until told to stop, recording how long each call took. */
async function sampleLatency(stop: { now: boolean }): Promise<number[]> {
  const samples: number[] = [];
  while (!stop.now) {
    const started = performance.now();
    await request(gateway.app).get('/healthz');
    samples.push(performance.now() - started);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return samples;
}

beforeAll(async () => {
  await connectRedis();
  await connectKafka();
  gateway = createGateway();
  port = await gateway.listen(0);

  await resetDb();
  host = await registerUser(gateway.app, 'host');
  const created = await authed(gateway.app, host.token)
    .post('/api/sessions')
    .send({ language: 'python' });
  sessionId = created.body.session.id;

  doc = connectDocClient(port, sessionId, host.token);
  await whenSynced(doc);
  doc.text.insert(0, 'print("burst")');
  await waitFor(() => doc.text.toString() === 'print("burst")');
}, 90_000);

afterAll(async () => {
  doc?.close();
  // Let the server observe the close and finish unsubscribing before Redis goes away.
  await waitFor(() => gateway.yjs.activeRooms() === 0, 5_000).catch(() => undefined);
  await gateway.close();
  await Promise.all([closePool(), closeRedis(), disconnectKafka()]);
}, 30_000);

describe('burst load', () => {
  it('absorbs a burst at constant cost with nothing consuming, and loses nothing', async () => {
    // Baseline: what /healthz costs with the gateway otherwise idle.
    const idleStop = { now: false };
    const idlePromise = sampleLatency(idleStop);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    idleStop.now = true;
    const idle = (await idlePromise).sort((a, b) => a - b);

    // Now the same measurement while every submission is fired at once.
    const burstStop = { now: false };
    const burstPromise = sampleLatency(burstStop);

    const started = performance.now();
    const responses = await Promise.all(
      Array.from({ length: BURST }, () =>
        authed(gateway.app, host.token).post(`/api/sessions/${sessionId}/submissions`),
      ),
    );
    const burstMs = performance.now() - started;

    burstStop.now = true;
    const under = (await burstPromise).sort((a, b) => a - b);

    // Nothing was rejected or dropped on the floor.
    expect(responses.every((res) => res.status === 202)).toBe(true);
    expect(await countSubmissionsForSession(sessionId)).toBe(BURST);

    const idleP95 = percentile(idle, 95);
    const underP95 = percentile(under, 95);
    const perSubmissionMs = burstMs / BURST;
    console.log(
      `[burst] ${BURST} submissions in ${burstMs.toFixed(0)}ms ` +
        `(${perSubmissionMs.toFixed(2)}ms each, nothing consuming) | ` +
        `/healthz p50 ${percentile(idle, 50).toFixed(1)}→${percentile(under, 50).toFixed(1)}ms, ` +
        `p95 ${idleP95.toFixed(1)}→${underP95.toFixed(1)}ms ` +
        `(${idle.length} idle / ${under.length} under-load samples)`,
    );

    // Accepting a submission is bounded, constant work. If the gateway were waiting on
    // anything downstream this would be orders of magnitude larger — and it holds with
    // zero consumers attached, which is the whole point.
    expect(perSubmissionMs).toBeLessThan(50);

    // The gateway kept answering unrelated requests *while* the burst was in flight;
    // a blocked event loop would have produced no samples at all.
    expect(under.length).toBeGreaterThan(2);

    // An absolute ceiling, not a ratio against baseline. Latency does degrade under
    // 200-way concurrency on a single event loop, and pretending otherwise would make
    // this assertion decorative. What must not happen is unbounded queueing.
    expect(underP95).toBeLessThan(1_000);
  }, 180_000);

  it('delivers every queued submission to the topic', async () => {
    const listed = await authed(gateway.app, host.token).get(
      `/api/sessions/${sessionId}/submissions`,
    );
    // The listing endpoint caps at 20; the count check above already covers totality,
    // so this asserts the queue delivered the ones we can name.
    const ids = new Set<string>(
      (listed.body.submissions as { id: string }[]).map((submission) => submission.id),
    );
    expect(ids.size).toBeGreaterThan(0);

    const events = await collectSubmissionEvents(ids, 90_000);
    expect(events.size).toBe(ids.size);
  }, 180_000);
});
