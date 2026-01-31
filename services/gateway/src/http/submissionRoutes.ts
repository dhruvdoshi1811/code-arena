import { Router } from 'express';
import { z } from 'zod';
import { createSubmission, listSubmissionsForSession } from '../db/submissions.js';
import type { SubmissionEvent } from '../domain.js';
import { AppError, badRequest, conflict } from '../errors.js';
import { currentUser, requireAuth } from '../auth/middleware.js';
import { resolveJoinableSession } from '../realtime/auth.js';
import { readDocumentText } from '../realtime/ydoc.js';
import { publishSubmission } from '../kafka/producer.js';

const IdParam = z.object({ id: z.uuid('Not a valid session id') });

/** Mounted at /api/sessions/:id/submissions. */
export const submissionRoutes = Router({ mergeParams: true });

submissionRoutes.use(requireAuth);

/**
 * Run.
 *
 * The code is read from the gateway's own Y.Doc rather than accepted from the client,
 * so what gets executed is exactly what both participants were looking at. A modified
 * client cannot smuggle in different code, and there is no untrusted payload to size-
 * limit or sanitise.
 *
 * The trade-off is an affinity requirement: this request has to reach an instance that
 * holds the document. In practice the browser talks to one gateway origin, and the
 * WebSocket transports already need sticky sessions at the load balancer, so this adds
 * no new constraint — but it is a real one, and Phase F must not forget it.
 */
submissionRoutes.post('/', async (req, res) => {
  const { id: sessionId } = IdParam.parse(req.params);
  const user = currentUser(req);

  // Reuses the same participant + ACTIVE checks the realtime layer applies, so a
  // session cannot be submitted to over REST that could not be joined over a socket.
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

  // Row first, then publish. A produce failure leaves a QUEUED row that can be
  // reconciled; publishing first could hand a consumer an id that does not exist.
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

  // 202, not 200: the claim being made is "durably queued", which is true only after
  // the broker acknowledged the record. It is emphatically not "this has run".
  res.status(202).json({ submission });
});

submissionRoutes.get('/', async (req, res) => {
  const { id: sessionId } = IdParam.parse(req.params);
  const user = currentUser(req);

  await resolveJoinableSession(sessionId, user);
  res.json({ submissions: await listSubmissionsForSession(sessionId) });
});
