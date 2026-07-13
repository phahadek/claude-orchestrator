import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Scheduler } from '../orchestration/Scheduler';
import { reportProjectDeploy } from '../deploy/deployService';

const GATE_RECONCILER_JOB = 'gate_verification_reconciler';

let _scheduler: Scheduler | null = null;

export function setDeployScheduler(s: Scheduler): void {
  _scheduler = s;
}

/**
 * The uniform report-in surface every project's deploy flow calls (skill→
 * orchestrator direction) — including claude-orchestrator itself, no
 * self-hosted carve-out. Fires the gate-verification reconciler on report,
 * event-driven rather than polled.
 */
export function createDeployRouter(): Router {
  const router = Router();

  // POST /api/deploy/report-in  { projectId, sha }
  router.post('/deploy/report-in', (req: Request, res: Response) => {
    const body = req.body as { projectId?: unknown; sha?: unknown };
    const projectId =
      typeof body.projectId === 'string' ? body.projectId : null;
    const sha = typeof body.sha === 'string' ? body.sha : null;
    if (!projectId || !sha) {
      res.status(400).json({ error: 'projectId and sha are required' });
      return;
    }

    reportProjectDeploy(projectId, sha);

    if (_scheduler) {
      void _scheduler.triggerNow(GATE_RECONCILER_JOB).catch(() => {
        /* errors are logged inside triggerNow */
      });
    }

    res.status(202).json({ projectId, sha });
  });

  return router;
}
