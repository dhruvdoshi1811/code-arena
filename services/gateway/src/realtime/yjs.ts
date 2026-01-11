import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { authenticateToken, resolveJoinableSession } from './auth.js';
import { SOCKET_IO_PATH } from './socket.js';

/** y-websocket connects to `<baseUrl>/<roomName>`, so the session id is the last path
 *  segment: `ws://host/yjs/<sessionId>?token=...`. */
export const YJS_PATH_PREFIX = '/yjs/';

const SessionIdSchema = z.string().uuid('Not a valid session id');

interface YjsSocket extends WebSocket {
  isAlive?: boolean;
  sessionId?: string;
  userId?: string;
}

export interface YjsTransport {
  /** Live document sockets per session. Phase B hands these to y-websocket's
   *  `setupWSConnection`; Phase A only needs to know they connect and clean up. */
  readonly rooms: ReadonlyMap<string, ReadonlySet<WebSocket>>;
  close(): Promise<void>;
}

/**
 * The CRDT transport.
 *
 * Yjs' canonical provider speaks a compact binary protocol over a plain WebSocket, so
 * it gets a plain WebSocket rather than being tunnelled through Socket.io's event
 * layer — every keystroke would otherwise pay for a JSON envelope it does not need.
 *
 * Phase A wires the *connection lifecycle* only: authenticate, authorise against the
 * session, accept, track, clean up. Document sync itself is Phase B, where the message
 * handler below becomes `setupWSConnection`.
 */
export function attachYjsWebSocket(httpServer: HttpServer): YjsTransport {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const rooms = new Map<string, Set<WebSocket>>();

  httpServer.on('upgrade', (req, socket, head) => {
    void routeUpgrade(req, socket, head);
  });

  async function routeUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      reject(socket, 400, 'Bad Request');
      return;
    }

    // Socket.io registered its own upgrade listener; leave its traffic alone.
    if (url.pathname.startsWith(SOCKET_IO_PATH)) return;

    if (!url.pathname.startsWith(YJS_PATH_PREFIX)) {
      // Every upgrade path is now explicitly accounted for. Deciding this here, rather
      // than letting engine.io's destroy-on-a-timer heuristic decide it, is what keeps
      // two WebSocket libraries on one port deterministic.
      reject(socket, 404, 'Not Found');
      return;
    }

    try {
      const sessionId = SessionIdSchema.parse(url.pathname.slice(YJS_PATH_PREFIX.length));

      // A browser cannot set headers on a WebSocket handshake, so the token rides in
      // the query string. It is the same token and the same verification as the
      // Authorization header on REST — only the carrier differs.
      const user = await authenticateToken(url.searchParams.get('token'));
      const session = await resolveJoinableSession(sessionId, user);

      wss.handleUpgrade(req, socket, head, (ws) => {
        const client = ws as YjsSocket;
        client.isAlive = true;
        client.sessionId = session.id;
        client.userId = user.id;

        let room = rooms.get(session.id);
        if (!room) {
          room = new Set();
          rooms.set(session.id, room);
        }
        room.add(client);

        client.on('pong', () => {
          client.isAlive = true;
        });

        client.on('message', () => {
          // Phase B: replace with y-websocket's `setupWSConnection`, which owns the
          // server-side Y.Doc, awareness state, and sync-protocol framing. Dropping
          // frames here is intentional — a naive rebroadcast would look like it works
          // for two peers and then lose state on the first late joiner.
        });

        client.on('close', () => {
          const current = rooms.get(session.id);
          if (!current) return;
          current.delete(client);
          if (current.size === 0) rooms.delete(session.id);
        });

        client.on('error', (err) => {
          if (!config.isTest) console.error('[yjs] socket error', err);
        });

        wss.emit('connection', client, req);
      });
    } catch (err) {
      const status = err instanceof AppError ? err.status : 500;
      const message = err instanceof AppError ? err.message : 'Internal Server Error';
      reject(socket, status, message);
    }
  }

  // Without this, a client that vanishes without a close frame (laptop lid, dead NAT
  // entry) leaves a socket that looks open forever.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const client = ws as YjsSocket;
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }, 30_000);
  heartbeat.unref();

  return {
    rooms,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => resolve());
      }),
  };
}

function reject(socket: Duplex, status: number, message: string): void {
  if (socket.writable) {
    socket.write(
      `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  }
  socket.destroy();
}
