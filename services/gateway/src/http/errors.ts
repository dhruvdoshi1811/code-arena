import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../errors.js';
import { config } from '../config.js';

/** Every failure leaves the service in the same shape: `{ error: { code, message } }`. */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }

  if (err instanceof ZodError) {
    const detail = err.issues
      .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      .join('; ');
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: detail } });
    return;
  }

  // Anything reaching here is a bug.
  if (!config.isTest) console.error('[http] unhandled error', err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
};

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'ROUTE_NOT_FOUND', message: 'No such endpoint' } });
};
