import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { z } from 'zod';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { authenticateToken, resolveJoinableSession } from './auth.js';
import { SOCKET_IO_PATH } from './socket.js';
import { activeDocRoomCount, handleDocMessage, joinDocRoom, leaveDocRoom } from './ydoc.js';

/** y-websocket connects to `<baseUrl>/<roomName>`. */
export const YJS_PATH_PREFIX = '/yjs/';

const SessionIdSchema = z.uuid('Not a valid session id');

interface YjsSocket extends WebSocket {
  isAlive?: boolean;
  sessionId?: string;
  userId?: string;
}

export interface YjsTransport {
  /** How many sessions currently hold a live document. */
  activeRooms(): number;
  close(): Promise<void>;
}

/** `ws` hands a frame over as a Buffer, an ArrayBuffer. */
function toUint8Array(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (Buffer.isBuffer(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data);
}

/** The CRDT transport. */
export function attachYjsWebSocket(httpServer: HttpServer): YjsTransport {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

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
      // Every upgrade path is now explicitly accounted for.
      reject(socket, 404, 'Not Found');
      return;
    }

    try {
      const sessionId = SessionIdSchema.parse(url.pathname.slice(YJS_PATH_PREFIX.length));

      // A browser cannot set headers on a WebSocket handshake, so the token rides in the query string.
      const user = await authenticateToken(url.searchParams.get('token'));
      const session = await resolveJoinableSession(sessionId, user);

      wss.handleUpgrade(req, socket, head, (ws) => {
        const client = ws as YjsSocket;
        client.isAlive = true;
        client.sessionId = session.id;
        client.userId = user.id;

        client.on('pong', () => {
          client.isAlive = true;
        });

        client.on('message', (data: RawData, isBinary: boolean) => {
          // The Yjs protocol is binary.
          if (!isBinary) return;
          handleDocMessage(session.id, client, toUint8Array(data));
        });

        client.on('close', () => {
          // Cleanup unsubscribes from Redis.
          void leaveDocRoom(session.id, client).catch((err: unknown) => {
            if (!config.isTest) console.error('[yjs] cleanup failed', err);
          });
        });

        client.on('error', (err) => {
          if (!config.isTest) console.error('[yjs] socket error', err);
        });

        // Registers the socket and sends sync step 1 plus the current cursors.
        void joinDocRoom(session.id, client).catch((err: unknown) => {
          if (!config.isTest) console.error('[yjs] failed to join doc room', err);
          client.close();
        });

        wss.emit('connection', client, req);
      });
    } catch (err) {
      const status = err instanceof AppError ? err.status : 500;
      const message = err instanceof AppError ? err.message : 'Internal Server Error';
      reject(socket, status, message);
    }
  }

  // Without this, a client that vanishes without a close frame (laptop lid.
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
    activeRooms: activeDocRoomCount,
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
