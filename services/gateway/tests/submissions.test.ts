import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../src/db/pool.js';
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
import { collectSubmissionEvents, partitionCountForTopic } from './kafkaHelpers.js';

let gateway: Gateway;
let port: number;
let host: RegisteredUser;
let guest: RegisteredUser;
let bystander: RegisteredUser;
let sessionId: string;

const docs: DocClient[] = [];

async function openDocument(token: string, code: string): Promise<DocClient> {
  const client = connectDocClient(port, sessionId, token);
  docs.push(client);
  await whenSynced(client);
  client.text.insert(0, code);
  // The route reads the server's copy, so wait until the server has actually applied it.
  await waitFor(() => client.text.toString() === code);
  return client;
}

beforeAll(async () => {
  await connectRedis();
  await connectKafka();
  gateway = createGateway();
  port = await gateway.listen(0);
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
});

afterEach(async () => {
  while (docs.length > 0) docs.pop()?.close();
  await waitFor(() => gateway.yjs.activeRooms() === 0, 5_000).catch(() => undefined);
});

afterAll(async () => {
  await gateway.close();
  await Promise.all([closePool(), closeRedis(), disconnectKafka()]);
}, 30_000);

describe('POST /api/sessions/:id/submissions', () => {
  it('queues the code held in the server document', async () => {
    await openDocument(host.token, 'print("hello from the shared document")');

    const res = await authed(gateway.app, host.token).post(`/api/sessions/${sessionId}/submissions`);

    // 202: durably queued, not executed.
    expect(res.status).toBe(202);
    expect(res.body.submission).toMatchObject({
      sessionId,
      userId: host.user.id,
      language: 'python',
      status: 'QUEUED',
      output: null,
      exitCode: null,
    });
    // The code came from the server's Y.Doc, not from the request.
    expect(res.body.submission.code).toBe('print("hello from the shared document")');
  });

  it('publishes an event a consumer can actually read', async () => {
    await openDocument(host.token, 'print(1)');

    const res = await authed(gateway.app, host.token).post(`/api/sessions/${sessionId}/submissions`);
    const submissionId = res.body.submission.id as string;

    const events = await collectSubmissionEvents(new Set([submissionId]));
    const event = events.get(submissionId);

    expect(event).toBeDefined();
    expect(event).toMatchObject({
      submissionId,
      sessionId,
      userId: host.user.id,
      language: 'python',
      code: 'print(1)',
    });
  }, 60_000);

  it('lets either participant submit', async () => {
    await openDocument(host.token, 'print(2)');

    const res = await authed(gateway.app, guest.token).post(
      `/api/sessions/${sessionId}/submissions`,
    );
    expect(res.status).toBe(202);
    expect(res.body.submission.userId).toBe(guest.user.id);
  });

  it('refuses a non-participant', async () => {
    await openDocument(host.token, 'print(3)');

    const res = await authed(gateway.app, bystander.token).post(
      `/api/sessions/${sessionId}/submissions`,
    );
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_A_PARTICIPANT');
  });

  it('requires authentication', async () => {
    const res = await authed(gateway.app, 'not.a.jwt').post(
      `/api/sessions/${sessionId}/submissions`,
    );
    expect(res.status).toBe(401);
  });

  // The affinity requirement, stated as a test rather than only as a comment.
  it('409s when no document is open on this instance', async () => {
    const res = await authed(gateway.app, host.token).post(`/api/sessions/${sessionId}/submissions`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_DOCUMENT');
  });

  it('400s on an empty document', async () => {
    await openDocument(host.token, '   \n  ');

    const res = await authed(gateway.app, host.token).post(`/api/sessions/${sessionId}/submissions`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('EMPTY_SUBMISSION');
  });

  it('refuses an ended session', async () => {
    await openDocument(host.token, 'print(4)');
    await authed(gateway.app, host.token).post(`/api/sessions/${sessionId}/end`);

    const res = await authed(gateway.app, host.token).post(`/api/sessions/${sessionId}/submissions`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SESSION_ENDED');
  });

  it('snapshots the code, so later edits do not rewrite history', async () => {
    const doc = await openDocument(host.token, 'print("first")');
    const first = await authed(gateway.app, host.token).post(
      `/api/sessions/${sessionId}/submissions`,
    );

    doc.text.delete(0, doc.text.length);
    doc.text.insert(0, 'print("second")');
    await waitFor(() => doc.text.toString() === 'print("second")');

    const second = await authed(gateway.app, host.token).post(
      `/api/sessions/${sessionId}/submissions`,
    );

    expect(first.body.submission.code).toBe('print("first")');
    expect(second.body.submission.code).toBe('print("second")');
  });
});

describe('GET /api/sessions/:id/submissions', () => {
  it('lists a session submissions newest first', async () => {
    const doc = await openDocument(host.token, 'print("a")');
    await authed(gateway.app, host.token).post(`/api/sessions/${sessionId}/submissions`);

    doc.text.delete(0, doc.text.length);
    doc.text.insert(0, 'print("b")');
    await waitFor(() => doc.text.toString() === 'print("b")');
    await authed(gateway.app, host.token).post(`/api/sessions/${sessionId}/submissions`);

    const res = await authed(gateway.app, guest.token).get(`/api/sessions/${sessionId}/submissions`);
    expect(res.status).toBe(200);
    expect(res.body.submissions).toHaveLength(2);
    expect(res.body.submissions[0].code).toBe('print("b")');
  });

  it('refuses a non-participant', async () => {
    const res = await authed(gateway.app, bystander.token).get(
      `/api/sessions/${sessionId}/submissions`,
    );
    expect(res.status).toBe(403);
  });
});

describe('topic layout', () => {
  // Auto-created topics get one partition.
  it('has more than one partition', async () => {
    expect(await partitionCountForTopic()).toBeGreaterThan(1);
  }, 30_000);
});
