import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { config } from '../config.js';

/**
 * Identifies this gateway process for the lifetime of the process.
 *
 * Redis pub/sub delivers a published message to every subscriber including the
 * publisher, so each envelope carries the id of the instance that sent it and every
 * instance drops its own echo. Without this, a local document update would be applied
 * to the very Y.Doc that produced it, re-fire `doc.on('update')`, and publish again.
 */
export const instanceId = randomUUID();

const clients: Redis[] = [];

function createClient(label: string): Redis {
  // Deliberately not `lazyConnect`: with it, the first command opens the connection
  // implicitly, and a later explicit `connect()` throws "already connecting". Eager
  // construction plus a readiness probe keeps startup ordering unambiguous.
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

// Four connections, two owners. The Socket.io adapter drives its pair itself and
// psubscribes to its own key prefix; giving the document bridge separate clients keeps
// the two from ever contending over subscriber-mode state on one connection.
export const adapterPub = createClient('adapter-pub');
export const adapterSub = createClient('adapter-sub');
const docPub = createClient('doc-pub');
const docSub = createClient('doc-sub');

type BinaryHandler = (payload: Buffer) => void;
const handlers = new Map<string, BinaryHandler>();

// `messageBuffer` rather than `message`: Yjs updates are binary and would be mangled
// by ioredis' default UTF-8 decoding of the payload.
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

/** Waits until every client can serve commands. Call before the Socket.io adapter is
 *  created, while no client has entered subscriber mode yet. */
export async function connectRedis(): Promise<void> {
  await Promise.all(clients.map((client) => client.ping()));
}

export async function closeRedis(): Promise<void> {
  await Promise.all(clients.map((client) => client.quit()));
}
