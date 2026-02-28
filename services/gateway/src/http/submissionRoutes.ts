import { Router } from 'express';
import { z } from 'zod';
import { createSubmission, listSubmissionsForSession } from '../db/submissions.js';
import type { SubmissionEvent } from '../domain.js';
import { AppError, badRequest, conflict } from '../errors.js';
import { currentUser, requireAuth } from '../auth/middleware.js';
import { resolveJoinableSession } from '../realtime/auth.js';
import { readDocumentText } from '../realtime/ydoc.js';
import { publishSubmission } from '../kafka/producer.js';
import { publishQueued } from '../realtime/execution.js';

const IdParam = z.object({ id: z.uuid('Not a valid session id') });

/** Mounted at /api/sessions/:id/submissions. */
export const submissionRoutes = Router({ mergeParams: true });

submissionRoutes.use(requireAuth);

/** Run. */
submissionRoutes.post('/', async (req, res) => {
  const { id: sessionId } = IdParam.parse(req.params);
  const user = currentUser(req);

  // Reuses the same participant + ACTIVE checks the realtime layer applies.
  const session = await resolveJoinableSession(sessionId, user);

  const code = readDocumentText(sessionId);
  if (code === null) {
    throw conflict(
      'NO_DOCUMENT',
      'No live document for this session on this gateway — open the editor and try again',
    );
  }
  if (code.trim().length === 0) {
    throw badRequest('EMPTY_SUBMISSION', 'There is no code to run');
  }

  // Row first, then publish.
  const submission = await createSubmission({
    sessionId: session.id,
    userId: user.id,
    language: session.language,
    code,
  });

  const event: SubmissionEvent = {
    submissionId: submission.id,
    sessionId: submission.sessionId,
    userId: submission.userId,
    language: submission.language,
    code: submission.code,
    createdAt: submission.createdAt.toISOString(),
  };

  try {
    await publishSubmission(event);
  } catch (err) {
    if (!process.env.VITEST) console.error('[submissions] failed to publish', err);
    throw new AppError(
      503,
      'QUEUE_UNAVAILABLE',
      'Could not queue the submission — the broker is unreachable',
    );
  }

  // Tell the room a run has started.
  publishQueued(session.id, submission.id).catch((publishErr: unknown) => {
    if (!process.env.VITEST) console.error('[submissions] failed to announce queued', publishErr);
  });

  // 202, not 200: the claim being made is "durably queued".
  res.status(202).json({ submission });
});

submissionRoutes.get('/', async (req, res) => {
  const { id: sessionId } = IdParam.parse(req.params);
  const user = currentUser(req);

  await resolveJoinableSession(sessionId, user);
  res.json({ submissions: await listSubmissionsForSession(sessionId) });
});
