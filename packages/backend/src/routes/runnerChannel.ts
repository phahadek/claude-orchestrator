import express, { Router } from 'express';
import type { Request, Response } from 'express';
import https from 'https';
import fs from 'fs';
import { requireRunnerAuth } from '../auth/DeviceAuth';
import { logger } from '../logger';
import {
  listClaimableJobs,
  claimRunnerJob,
  getRunnerJobSnapshot,
  submitRunnerResult,
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
} from '../config';

const RESULT_BODY_LIMIT = '8mb';
const RESULT_PATH_RE = /^\/api\/runner\/jobs\/[^/]+\/result\/?$/;

/** Runner-only routes. The poll response carries admitted-work descriptors
 *  only — never project secrets (.env etc.). Empty until the dispatch-payload
 *  and snapshot-transport siblings land. */
function deviceIdOf(req: Request): string {
  return (req as Request & { device: { id: string } }).device.id;
}

function createRunnerRouter(): Router {
  const router = Router();
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
  router.post(
    '/jobs/:runId/result',
    express.json({ limit: RESULT_BODY_LIMIT }),
    (req: Request, res: Response) => {
      const errs = validateRunnerResultPackage(req.body);
      if (errs.length > 0) {
        res
          .status(400)
          .json({ error: 'invalid_result_package', problems: errs });
        return;
      }
      const ok = submitRunnerResult(
        String(req.params.runId),
        deviceIdOf(req),
        req.body as RunnerResultPackage,
      );
      if (!ok) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ ok: true });
    },
  );
  return router;
}

/** The app served by the dedicated runner listener: runner routes only. */
export function createRunnerApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  const smallJson = express.json({ limit: '64kb' });
  app.use((req, res, next) =>
    RESULT_PATH_RE.test(req.path) ? next() : smallJson(req, res, next),
  );
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
