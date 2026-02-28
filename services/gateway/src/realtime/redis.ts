import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { config } from '../config.js';

/** Identifies this gateway process for the lifetime of the process. */
export const instanceId = randomUUID();

const clients: Redis[] = [];

function createClient(label: string): Redis {
  // Deliberately not `lazyConnect`: with it, the first command opens the connection implicitly.
  const client = new Redis(config.redisUrl, {
    // A client in subscriber mode cannot answer the ping that request retries rely on.
    maxRetriesPerRequest: null,
  });
  client.on('error', (err) => {
    if (!config.isTest) console.error(`[redis:${label}] ${err.message}`);
  });
  clients.push(client);
  return client;
}

// Four connections, two owners.
export const adapterPub = createClient('adapter-pub');
export const adapterSub = createClient('adapter-sub');
const docPub = createClient('doc-pub');
const docSub = createClient('doc-sub');

type BinaryHandler = (payload: Buffer) => void;
const handlers = new Map<string, BinaryHandler>();

// `messageBuffer`, not `message`: Yjs updates are binary and would be corrupted by UTF-8 decoding.
docSub.on('messageBuffer', (channel: Buffer, payload: Buffer) => {
  handlers.get(channel.toString())?.(payload);
});

export async function subscribeBinary(channel: string, handler: BinaryHandler): Promise<void> {
  handlers.set(channel, handler);
  await docSub.subscribe(channel);
}

export async function unsubscribeBinary(channel: string): Promise<void> {
  handlers.delete(channel);
  await docSub.unsubscribe(channel);
}

export async function publishBinary(channel: string, payload: Uint8Array): Promise<void> {
  await docPub.publish(channel, Buffer.from(payload));
}

// Pattern subscriptions, used for execution events. Kept on its own client so
// subscriber-mode state never collides with the exact-channel document bridge.
const patternSub = createClient('pattern-sub');
const patternHandlers = new Map<string, (channel: string, message: string) => void>();

patternSub.on('pmessage', (pattern: string, channel: string, message: string) => {
  patternHandlers.get(pattern)?.(channel, message);
});

export async function subscribePattern(
  pattern: string,
  handler: (channel: string, message: string) => void,
): Promise<void> {
  patternHandlers.set(pattern, handler);
  await patternSub.psubscribe(pattern);
}

export async function publishText(channel: string, message: string): Promise<void> {
  await docPub.publish(channel, message);
}

/** Waits until every client can serve commands. */
export async function connectRedis(): Promise<void> {
  await Promise.all(clients.map((client) => client.ping()));
}

export async function closeRedis(): Promise<void> {
  await Promise.all(clients.map((client) => client.quit()));
}
