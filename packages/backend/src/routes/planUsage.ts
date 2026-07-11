import { Router } from 'express';
import type { Request, Response } from 'express';
import type { PlanUsagePoller } from '../orchestration/PlanUsagePoller';

let _poller: PlanUsagePoller | null = null;

export function setPlanUsagePoller(poller: PlanUsagePoller): void {
  _poller = poller;
}

export function createPlanUsageRouter(): Router {
  const router = Router();

  // GET /api/plan-usage
  router.get('/plan-usage', (_req: Request, res: Response) => {
    res.json(_poller?.getCache() ?? { available: false });
  });

  return router;
}
