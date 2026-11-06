import { Router } from 'express';
import type { Request, Response } from 'express';
import { getAuthLapse } from '../orchestration/authAdmission';
import { getAuthLapseProbe } from '../orchestration/AuthLapseProbe';

export function createAuthLapseRouter(): Router {
  const router = Router();

  // GET /api/auth-lapse — reconciliation surface for AuthLapsedBanner.
  router.get('/auth-lapse', (_req: Request, res: Response) => {
    res.json(getAuthLapse());
  });

  // POST /api/auth-lapse/recheck — runs the probe early; never clears the
  // state itself (only a probe success does).
  router.post('/auth-lapse/recheck', async (_req: Request, res: Response) => {
    const probe = getAuthLapseProbe();
    if (!probe) {
      res.status(503).json({ error: 'auth probe unavailable' });
      return;
    }
    const outcome = await probe.probeNow();
    res.json({ outcome, ...getAuthLapse() });
  });

  return router;
}
