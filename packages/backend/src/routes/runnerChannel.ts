import express, { Router } from 'express';
import type { Request, Response } from 'express';
import https from 'https';
import fs from 'fs';
import { requireRunnerAuth } from '../auth/DeviceAuth';
import { logger } from '../logger';
import {
  RUNNER_TLS_CERT_PATH,
  RUNNER_TLS_KEY_PATH,
  RUNNER_LISTENER_PORT,
  RUNNER_LISTENER_HOST,
} from '../config';

/** Runner-only routes. The poll response carries admitted-work descriptors
 *  only — never project secrets (.env etc.). Empty until the dispatch-payload
 *  and snapshot-transport siblings land. */
export function createRunnerRouter(): Router {
  const router = Router();
  router.get('/poll', (_req: Request, res: Response) => {
    res.json({ work: [] });
  });
  return router;
}

/** The app served by the dedicated runner listener: runner routes only. */
export function createRunnerApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use('/api/runner', requireRunnerAuth, createRunnerRouter());
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });
  return app;
}

/** Start the TLS-only runner listener. Returns null (listener disabled) when
 *  no cert/key is configured — there is never a plaintext fallback. */
export function startRunnerListener(): https.Server | null {
  if (!RUNNER_TLS_CERT_PATH || !RUNNER_TLS_KEY_PATH) {
    logger.info(
      '[runner-channel] RUNNER_TLS_CERT_PATH/RUNNER_TLS_KEY_PATH not set — runner listener disabled',
    );
    return null;
  }
  const server = https.createServer(
    {
      cert: fs.readFileSync(RUNNER_TLS_CERT_PATH),
      key: fs.readFileSync(RUNNER_TLS_KEY_PATH),
      minVersion: 'TLSv1.2',
    },
    createRunnerApp(),
  );
  server.listen(RUNNER_LISTENER_PORT, RUNNER_LISTENER_HOST, () => {
    logger.info(
      `[runner-channel] https listener on ${RUNNER_LISTENER_HOST}:${RUNNER_LISTENER_PORT}`,
    );
  });
  return server;
}
