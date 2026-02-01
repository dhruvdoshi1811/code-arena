import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import { readSyncMessage, writeSyncStep1, writeUpdate } from 'y-protocols/sync';
import type { WebSocket } from 'ws';
import { config } from '../config.js';
import { instanceId, publishBinary, subscribeBinary, unsubscribeBinary } from './redis.js';

/** The shared text field inside every session document. The frontend binds Monaco to
 *  the same key — a mismatch here is a silent "everyone edits their own document". */
export const CODE_TEXT_KEY = 'code';

/** y-websocket wire protocol message types. The client provider speaks these; the
 *  numbers are the protocol, not an internal choice we are free to change. */
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

/** Envelope kinds for the cross-instance bridge — ours, not part of any wire spec. */
const BRIDGE_DOC = 0;
const BRIDGE_AWARENESS = 1;

/**
 * Marks changes that arrived from another gateway instance.
 *
 * Both update handlers below broadcast to local sockets unconditionally, but publish
 * to Redis only when the origin is *not* this sentinel. Without it two instances would
 * bounce a single keystroke between them forever.
 */
const REMOTE_ORIGIN = Symbol('codearena.remote');

const channelFor = (sessionId: string) => `codearena:yjs:${sessionId}`;

/** A failed bridge publish costs the other instances one update; it must never become
 *  an unhandled rejection that ends the process. */
function reportBridge(err: unknown): void {
  if (!config.isTest) console.error('[ydoc] bridge publish failed', err);
}

interface DocRoom {
  doc: Y.Doc;
  awareness: Awareness;
  /** Which awareness client ids each socket owns, so a disconnect can retract exactly
   *  that socket's cursor and nobody else's. */
  socketClients: Map<WebSocket, Set<number>>;
  /** Resolves once this room is subscribed to its Redis channel. */
  ready: Promise<void>;
}

const rooms = new Map<string, DocRoom>();

function send(socket: WebSocket, payload: Uint8Array): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(payload, (err) => {
    if (err) socket.close();
  });
}

function broadcast(room: DocRoom, payload: Uint8Array): void {
  for (const socket of room.socketClients.keys()) send(socket, payload);
}

function envelope(kind: number, payload: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, instanceId);
  encoding.writeVarUint(encoder, kind);
  encoding.writeVarUint8Array(encoder, payload);
  return encoding.toUint8Array(encoder);
}

/**
 * The server keeps its own Y.Doc per session rather than blindly relaying bytes
 * between peers. Three things depend on it: a late joiner can be caught up from one
 * authoritative state instead of begging a peer, updates can be re-encoded for the
 * Redis bridge, and from Phase D the code that gets executed is read from here rather
 * than trusted from whichever client clicked Run.
 */
function getOrCreateRoom(sessionId: string): DocRoom {
  const existing = rooms.get(sessionId);
  if (existing) return existing;

  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  // The gateway is a relay, not a participant, so it publishes no cursor of its own.
  awareness.setLocalState(null);

  const room: DocRoom = { doc, awareness, socketClients: new Map(), ready: Promise.resolve() };

  doc.on('update', (update: Uint8Array, origin: unknown) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    writeUpdate(encoder, update);
    broadcast(room, encoding.toUint8Array(encoder));

    if (origin !== REMOTE_ORIGIN) {
      void publishBinary(channelFor(sessionId), envelope(BRIDGE_DOC, update)).catch(reportBridge);
    }
  });

  awareness.on(
    'update',
    (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      // Attribute client ids to the socket that announced them, so `leaveDocRoom` can
      // retract them later.
      const owner = room.socketClients.get(origin as WebSocket);
      if (owner) {
        for (const id of added) owner.add(id);
        for (const id of removed) owner.delete(id);
      }

      const changed = [...added, ...updated, ...removed];
      // Removals are encoded here too — `encodeAwarenessUpdate` writes a null state for
      // a client whose entry is gone. Skipping them would strand ghost cursors on every
      // *other* instance, which never sees the disconnect that caused the removal.
      const update = encodeAwarenessUpdate(awareness, changed);

      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(encoder, update);
      broadcast(room, encoding.toUint8Array(encoder));

      if (origin !== REMOTE_ORIGIN) {
        void publishBinary(channelFor(sessionId), envelope(BRIDGE_AWARENESS, update)).catch(
          reportBridge,
        );
      }
    },
  );

  room.ready = subscribeBinary(channelFor(sessionId), (payload) => {
    const decoder = decoding.createDecoder(payload);
    // Redis delivers a publish back to its own publisher; drop our own echo.
    if (decoding.readVarString(decoder) === instanceId) return;

    const kind = decoding.readVarUint(decoder);
    const update = decoding.readVarUint8Array(decoder);
    if (kind === BRIDGE_DOC) {
      Y.applyUpdate(room.doc, update, REMOTE_ORIGIN);
    } else if (kind === BRIDGE_AWARENESS) {
      applyAwarenessUpdate(room.awareness, update, REMOTE_ORIGIN);
    }
  }).catch((err: unknown) => {
    if (!config.isTest) console.error(`[ydoc] failed to subscribe ${sessionId}`, err);
  });

  rooms.set(sessionId, room);
  return room;
}

/** Attach a socket and hand it the current state: sync step 1, then live cursors. */
export async function joinDocRoom(sessionId: string, socket: WebSocket): Promise<void> {
  const room = getOrCreateRoom(sessionId);
  room.socketClients.set(socket, new Set());
  await room.ready;

  const syncEncoder = encoding.createEncoder();
  encoding.writeVarUint(syncEncoder, MESSAGE_SYNC);
  writeSyncStep1(syncEncoder, room.doc);
  send(socket, encoding.toUint8Array(syncEncoder));

  const states = room.awareness.getStates();
  if (states.size > 0) {
    const awarenessEncoder = encoding.createEncoder();
    encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      awarenessEncoder,
      encodeAwarenessUpdate(room.awareness, [...states.keys()]),
    );
    send(socket, encoding.toUint8Array(awarenessEncoder));
  }
}

/**
 * Dispatch one client frame.
 *
 * `readSyncMessage` writes its reply into `encoder`; a length of 1 means it wrote only
 * the leading message type and there is nothing to say back.
 */
export function handleDocMessage(sessionId: string, socket: WebSocket, data: Uint8Array): void {
  const room = rooms.get(sessionId);
  if (!room) return;

  try {
    const decoder = decoding.createDecoder(data);
    switch (decoding.readVarUint(decoder)) {
      case MESSAGE_SYNC: {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        readSyncMessage(decoder, encoder, room.doc, socket);
        if (encoding.length(encoder) > 1) send(socket, encoding.toUint8Array(encoder));
        break;
      }
      case MESSAGE_AWARENESS: {
        applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), socket);
        break;
      }
      default:
        break;
    }
  } catch (err) {
    // A malformed frame is one bad client, not a reason to take the room down.
    if (!config.isTest) console.error(`[ydoc] bad frame in ${sessionId}`, err);
  }
}

export async function leaveDocRoom(sessionId: string, socket: WebSocket): Promise<void> {
  const room = rooms.get(sessionId);
  if (!room) return;

  const controlled = room.socketClients.get(socket);
  room.socketClients.delete(socket);

  if (controlled && controlled.size > 0) {
    // Fires the awareness handler with a non-remote origin, so the retraction both
    // broadcasts locally and publishes to the other instances.
    removeAwarenessStates(room.awareness, [...controlled], null);
  }

  if (room.socketClients.size === 0) {
    await unsubscribeBinary(channelFor(sessionId));
    room.awareness.destroy();
    room.doc.destroy();
    rooms.delete(sessionId);
  }
}

/** The document as text. Phase D reads submissions from here rather than from the
 *  client, so what executes is exactly what the participants were looking at. */
export function readDocumentText(sessionId: string): string | null {
  return rooms.get(sessionId)?.doc.getText(CODE_TEXT_KEY).toString() ?? null;
}

export function activeDocRoomCount(): number {
  return rooms.size;
}
