import express, { type Express } from 'express';
import cors from 'cors';
import { config } from './config.js';
import { pingDatabase } from './db/pool.js';
import { authRoutes } from './http/authRoutes.js';
import { sessionRoutes } from './http/sessionRoutes.js';
import { errorHandler, notFoundHandler } from './http/errors.js';

/** The HTTP surface, separated from `listen()` so tests can drive it in-process. */
export function createApp(): Express {
  const app = express();

  app.set('trust proxy', true);
  app.use(cors({ origin: config.corsOrigins, credentials: true }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/healthz', async (_req, res) => {
    try {
      await pingDatabase();
      res.json({ status: 'ok' });
    } catch {
      res
        .status(503)
        .json({ status: 'degraded', error: { code: 'DB_UNAVAILABLE', message: 'Database unreachable' } });
    }
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/sessions', sessionRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
