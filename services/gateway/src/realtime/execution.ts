import { z } from 'zod';
import { config } from '../config.js';
import { publishText, subscribePattern } from './redis.js';
import { roomKey } from './presence.js';
import type { AppIoServer } from './socket.js';

/** Mirrors `Event` in the orchestrator's internal/stream/publisher.go. The JSON field
 *  names are the contract between the two services. */
const ExecutionEventSchema = z.object({
  type: z.enum(['status', 'output']),
  submissionId: z.uuid(),
  sessionId: z.uuid(),
  status: z.string().optional(),
  exitCode: z.number().nullable().optional(),
  lines: z.array(z.string()).optional(),
});

export type ExecutionEvent = z.infer<typeof ExecutionEventSchema>;

const CHANNEL_PATTERN = 'codearena:exec:*';

export const executionChannelFor = (sessionId: string) => `codearena:exec:${sessionId}`;

/**
 * Relay execution events from the orchestrator into the session's Socket.io room.
 *
 * The emit is deliberately `io.local`, and that is the whole subtlety of this file.
 *
 * Every gateway instance subscribes to this pattern, so every instance receives every
 * event. The Socket.io Redis adapter added in Phase B makes `io.to(room)` fan out to
 * *all* instances — so a plain `io.to(...)` here would have each instance broadcast the
 * same event cluster-wide, and a browser would receive one copy per running gateway.
 *
 * `io.local` restricts delivery to the sockets this instance actually holds. Each
 * instance serves its own clients, every client is served exactly once, and no
 * coordination protocol is needed to decide which instance is responsible.
 *
 * This is the inverse of the presence path, where one instance originates an event and
 * genuinely wants the adapter to fan it out to everyone.
 */
export function attachExecutionRelay(io: AppIoServer): Promise<void> {
  return subscribePattern(CHANNEL_PATTERN, (_channel, message) => {
    let parsed: ExecutionEvent;
    try {
      parsed = ExecutionEventSchema.parse(JSON.parse(message));
    } catch (err) {
      if (!config.isTest) console.error('[execution] undecodable event', err);
      return;
    }

    const room = io.local.to(roomKey(parsed.sessionId));

    if (parsed.type === 'status') {
      room.emit('submission:status', {
        submissionId: parsed.submissionId,
        sessionId: parsed.sessionId,
        status: parsed.status ?? 'QUEUED',
        exitCode: parsed.exitCode ?? null,
      });
      return;
    }

    if (parsed.lines && parsed.lines.length > 0) {
      room.emit('submission:output', {
        submissionId: parsed.submissionId,
        sessionId: parsed.sessionId,
        lines: parsed.lines,
      });
    }
  });
}

/**
 * Announce a newly queued submission.
 *
 * Published rather than emitted directly so it travels the same path as every other
 * execution event — the submitting client already learns of it from the 202 response,
 * but the *other* participant would otherwise see nothing until first output.
 */
export async function publishQueued(sessionId: string, submissionId: string): Promise<void> {
  await publishText(
    executionChannelFor(sessionId),
    JSON.stringify({ type: 'status', submissionId, sessionId, status: 'QUEUED' }),
  );
}
