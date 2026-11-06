import express, { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import https from 'https';
import fs from 'fs';
import { requireRunnerAuth } from '../auth/DeviceAuth';
import { logger } from '../logger';
import {
  listClaimableJobs,
  claimRunnerJob,
  getRunnerJobSnapshot,
  submitRunnerResult,
  isRunnerJobClaimedBy,
} from '../orchestration/runnerJobQueue';
import {
  validateRunnerResultPackage,
  type RunnerResultPackage,
} from '../orchestration/runnerResultPackage';
import {
  RUNNER_TLS_CERT_PATH,
  RUNNER_TLS_KEY_PATH,
  RUNNER_LISTENER_PORT,
  RUNNER_LISTENER_HOST,
  isRemoteRunnerConfigured,
} from '../config';

const RESULT_BODY_LIMIT = '8mb';
const DEFAULT_BODY_LIMIT = '64kb';

function deviceIdOf(req: Request): string {
  return (req as Request & { device: { id: string } }).device.id;
}

/** Runner-only routes. The poll response carries admitted-work descriptors
 *  only — never project secrets (.env etc.). The large result body limit is
 *  scoped to the result route by registering it before the default parser,
 *  so the router's own matching decides which parser runs. */
function createRunnerRouter(): Router {
  const router = Router();
  router.post(
    '/jobs/:runId/result',
    (req: Request, res: Response, next: NextFunction) => {
      if (!isRunnerJobClaimedBy(String(req.params.runId), deviceIdOf(req))) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      next();
    },
    express.json({ limit: RESULT_BODY_LIMIT }),
    (req: Request, res: Response) => {
      const body: unknown = req.body ?? null;
      const errs = validateRunnerResultPackage(body);
      if (errs.length > 0) {
        res
          .status(400)
          .json({ error: 'invalid_result_package', problems: errs });
        return;
      }
      const ok = submitRunnerResult(
        String(req.params.runId),
        deviceIdOf(req),
        body as RunnerResultPackage,
      );
      if (!ok) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ ok: true });
    },
  );
  router.use(express.json({ limit: DEFAULT_BODY_LIMIT }));
  router.get('/poll', (_req: Request, res: Response) => {
    res.json({ work: listClaimableJobs() });
  });
  router.post('/jobs/:runId/claim', (req: Request, res: Response) => {
    const job = claimRunnerJob(String(req.params.runId), deviceIdOf(req));
    if (!job) {
      res.status(404).json({ error: 'not_claimable' });
      return;
    }
    res.json({ job });
  });
  router.get('/jobs/:runId/snapshot', (req: Request, res: Response) => {
    const archive = getRunnerJobSnapshot(
      String(req.params.runId),
      deviceIdOf(req),
    );
    if (!archive) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Length', String(archive.length));
    res.end(archive);
  });
  return router;
}

/** The app served by the dedicated runner listener: runner routes only. */
export function createRunnerApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
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
      `[runner-channel] https listener on ${RUNNER_LISTENER_HOST}:${RUNNER_LISTENER_PORT} (remote runner configured: ${isRemoteRunnerConfigured()})`,
    );
  });
  return server;
}
