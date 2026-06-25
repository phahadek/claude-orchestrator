import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Scheduler } from '../orchestration/Scheduler';
import { getSchedulerAuditStats } from '../db/queries';

let _scheduler: Scheduler | null = null;

export function setScheduler(s: Scheduler): void {
  _scheduler = s;
}

export function createDiagnosticsRouter(): Router {
  const router = Router();

  // GET /api/diagnostics/scheduler
  router.get('/scheduler', (_req: Request, res: Response) => {
    if (!_scheduler) {
      res.status(503).json({ error: 'Scheduler not initialized' });
      return;
    }
    const statuses = _scheduler.status();
    const auditStats = getSchedulerAuditStats();
    res.json(
      statuses.map((s) => {
        const stats = auditStats.get(s.name);
        return {
          ...s,
          lastDurationMs: stats?.lastDurationMs ?? null,
          runCount24h: stats?.runCount24h ?? 0,
          errorCount24h: stats?.errorCount24h ?? 0,
        };
      }),
    );
  });

  // POST /api/diagnostics/scheduler/:name/trigger
  router.post('/scheduler/:name/trigger', (req: Request, res: Response) => {
    if (!_scheduler) {
      res.status(503).json({ error: 'Scheduler not initialized' });
      return;
    }
    const name = req.params['name'] as string;
    const triggeredAt = new Date().toISOString();
    void _scheduler.triggerNow(name).catch(() => {
      /* errors are logged inside triggerNow */
    });
    res.status(202).json({ job: name, triggered_at: triggeredAt });
  });

  return router;
}
