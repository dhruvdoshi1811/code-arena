import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { z, ZodError } from 'zod';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import type { PublicUser } from '../domain.js';
import { authenticateToken, resolveJoinableSession } from './auth.js';
import { broadcastPresence, roomKey, type Participant } from './presence.js';
import { adapterPub, adapterSub } from './redis.js';

export const SOCKET_IO_PATH = '/socket.io/';

export interface AckError {
  ok: false;
  error: { code: string; message: string };
}
export type Ack<T> = ({ ok: true } & T) | AckError;

interface ServerToClientEvents {
  'presence:update': (payload: { sessionId: string; participants: Participant[] }) => void;
}

interface ClientToServerEvents {
  'session:join': (payload: unknown, ack?: (res: Ack<{ participants: Participant[] }>) => void) => void;
  'session:leave': (payload: unknown, ack?: (res: Ack<object>) => void) => void;
}

interface SocketData {
  user: PublicUser;
  sessionId?: string;
}

export type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, object, SocketData>;
export type AppIoServer = Server<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

const JoinSchema = z.object({ sessionId: z.string().uuid('Not a valid session id') });

/** Mirrors the HTTP error envelope so a client sees the same `code` for the same
 *  failure whether it arrived over REST or over a socket. */
function toAckError(err: unknown): AckError {
  if (err instanceof AppError) {
    return { ok: false, error: { code: err.code, message: err.message } };
  }
  if (err instanceof ZodError) {
    const message = err.issues
      .map((issue) => `${issue.path.join('.') || 'payload'}: ${issue.message}`)
      .join('; ');
    return { ok: false, error: { code: 'VALIDATION_ERROR', message } };
  }
  if (!config.isTest) console.error('[socket] unhandled error', err);
  return { ok: false, error: { code: 'INTERNAL', message: 'Internal server error' } };
}

/**
 * Socket.io carries the *application's* realtime events — presence now, and from
 * Phase E submission status and streamed execution output. It deliberately does not
 * carry CRDT document updates; those get their own binary transport on `/yjs`.
 */
export function attachSocketIo(httpServer: HttpServer): AppIoServer {
  const io: AppIoServer = new Server(httpServer, {
    path: SOCKET_IO_PATH,
    cors: { origin: config.corsOrigins, credentials: true },
    // The `/yjs` upgrade handler owns every non-Socket.io upgrade. Left at its default,
    // engine.io would try to tear down sockets it does not recognise on a 1s timer,
    // which turns transport routing into a race against our own auth lookup.
    destroyUpgrade: false,
  });

  // Rooms, broadcasts, and `fetchSockets()` now span every gateway instance. This one
  // line is what turns presence from a per-process fiction into a cluster-wide fact.
  io.adapter(createAdapter(adapterPub, adapterSub));

  // Authenticate during the handshake: an unauthenticated socket never reaches
  // `connection`, so no handler downstream has to re-check identity.
  io.use((socket, next) => {
    authenticateToken(socket.handshake.auth?.token)
      .then((user) => {
        socket.data.user = user;
        next();
      })
      .catch((err: unknown) => {
        const { error } = toAckError(err);
        const wrapped = new Error(error.message);
        // socket.io surfaces `data` to the client's `connect_error` handler.
        Object.assign(wrapped, { data: error });
        next(wrapped);
      });
  });

  io.on('connection', (socket) => {
    socket.on('session:join', async (payload, ack) => {
      try {
        const { sessionId } = JoinSchema.parse(payload);
        const user = socket.data.user;

        const session = await resolveJoinableSession(sessionId, user);

        await socket.join(roomKey(session.id));
        socket.data.sessionId = session.id;

        const participants = await broadcastPresence(io, session.id);
        ack?.({ ok: true, participants });
      } catch (err) {
        ack?.(toAckError(err));
      }
    });

    socket.on('session:leave', async (_payload, ack) => {
      try {
        await leaveCurrentRoom(io, socket);
        ack?.({ ok: true });
      } catch (err) {
        ack?.(toAckError(err));
      }
    });

    socket.on('disconnect', () => {
      void leaveCurrentRoom(io, socket);
    });
  });

  return io;
}

async function leaveCurrentRoom(io: AppIoServer, socket: AppSocket): Promise<void> {
  const sessionId = socket.data.sessionId;
  if (!sessionId) return;

  socket.data.sessionId = undefined;
  await socket.leave(roomKey(sessionId));

  // Recomputed from the adapter after the socket has left, so the departing tab is
  // already excluded from the list the remaining participants receive.
  await broadcastPresence(io, sessionId);
}
