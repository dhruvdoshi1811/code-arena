import { Router } from 'express';
import { z } from 'zod';
import { claimGuestSeat, createSession, endSession, findSessionById } from '../db/sessions.js';
import { isParticipant, LANGUAGES } from '../domain.js';
import { conflict, forbidden, notFound } from '../errors.js';
import { currentUser, requireAuth } from '../auth/middleware.js';
import { submissionRoutes } from './submissionRoutes.js';

const CreateSchema = z.object({ language: z.enum(LANGUAGES) });
const IdParam = z.object({ id: z.uuid('Not a valid session id') });

export const sessionRoutes = Router();

sessionRoutes.use(requireAuth);

// Submissions are scoped to a session and re-derive the participant checks themselves,
// so they mount as a child router rather than reaching across from a sibling.
sessionRoutes.use('/:id/submissions', submissionRoutes);

sessionRoutes.post('/', async (req, res) => {
  const { language } = CreateSchema.parse(req.body);
  const session = await createSession(currentUser(req).id, language);
  res.status(201).json({ session });
});

sessionRoutes.get('/:id', async (req, res) => {
  const { id } = IdParam.parse(req.params);
  const user = currentUser(req);

  const session = await findSessionById(id);
  if (!session) throw notFound('SESSION_NOT_FOUND', 'No such session');
  // Knowing the id is enough to *join*; it is not enough to *read*. Only the two
  // seated participants can see a session's state.
  if (!isParticipant(session, user.id)) {
    throw forbidden('NOT_A_PARTICIPANT', 'You are not a participant in this session');
  }

  res.json({ session });
});

sessionRoutes.post('/:id/join', async (req, res) => {
  const { id } = IdParam.parse(req.params);
  const user = currentUser(req);

  const claimed = await claimGuestSeat(id, user.id);
  if (claimed) {
    res.json({ session: claimed });
    return;
  }

  // The claim did not apply. Read the current row to say why — this is diagnosis
  // after the fact, never a precondition check before the write.
  const session = await findSessionById(id);
  if (!session) throw notFound('SESSION_NOT_FOUND', 'No such session');
  if (session.guestId === user.id) {
    res.json({ session }); // Already seated — re-joining is idempotent.
    return;
  }
  if (session.hostId === user.id) {
    throw conflict('ALREADY_HOST', 'You are the host of this session');
  }
  if (session.status === 'ENDED') {
    throw conflict('SESSION_ENDED', 'This session has ended');
  }
  throw conflict('SESSION_FULL', 'This session already has two participants');
});

sessionRoutes.post('/:id/end', async (req, res) => {
  const { id } = IdParam.parse(req.params);
  const user = currentUser(req);

  const ended = await endSession(id, user.id);
  if (ended) {
    res.json({ session: ended });
    return;
  }

  const session = await findSessionById(id);
  if (!session) throw notFound('SESSION_NOT_FOUND', 'No such session');
  if (session.hostId !== user.id) {
    throw forbidden('NOT_THE_HOST', 'Only the host can end a session');
  }
  res.json({ session }); // Already ENDED — ending again is idempotent.
});
