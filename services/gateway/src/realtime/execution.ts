import { z } from 'zod';
import { config } from '../config.js';
import { publishText, subscribePattern } from './redis.js';
import { roomKey } from './presence.js';
import type { AppIoServer } from './socket.js';

/** Mirrors `Event` in the orchestrator's internal/stream/publisher.go. */
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

/** Relay execution events from the orchestrator into the session's Socket.io room. */
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

/** Announce a newly queued submission. */
export async function publishQueued(sessionId: string, submissionId: string): Promise<void> {
  await publishText(
    executionChannelFor(sessionId),
    JSON.stringify({ type: 'status', submissionId, sessionId, status: 'QUEUED' }),
  );
}
