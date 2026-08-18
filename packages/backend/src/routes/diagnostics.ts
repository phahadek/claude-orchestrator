import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Scheduler } from '../orchestration/Scheduler';
import type { AutoLauncher } from '../orchestration/AutoLauncher';
import { getSchedulerAuditStats } from '../db/queries';

let _scheduler: Scheduler | null = null;
let _autoLauncher: AutoLauncher | null = null;

export function setScheduler(s: Scheduler): void {
  _scheduler = s;
}

export function setAutoLauncher(a: AutoLauncher): void {
  _autoLauncher = a;
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
    const stats = getSchedulerAuditStats();
    const statsMap = new Map(stats.map((s) => [s.job, s]));
    const augmented = statuses.map((job) => {
      const s = statsMap.get(job.name);
      return {
        ...job,
        lastDurationMs: s?.lastDurationMs ?? null,
        runCount24h: s?.runCount24h ?? 0,
        errorCount24h: s?.errorCount24h ?? 0,
        maxEventLoopBlockedMs24h: s?.maxEventLoopBlockedMs24h ?? null,
        meanEventLoopBlockedMs24h: s?.meanEventLoopBlockedMs24h ?? null,
      };
    });
    res.json(augmented);
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

  // GET /api/diagnostics/admission-stall
  // Read-only reconciliation surface for AdmissionStallBanner: a client that
  // loads or reconnects mid-stall needs this to reflect the block
  // immediately, since the WS admission_stalled/admission_stall_cleared pair
  // only fires on the transition, not on every tick.
  router.get('/admission-stall', (_req: Request, res: Response) => {
    const state = _autoLauncher?.getAdmissionStallState() ?? null;
    res.json(state ? { stalled: true, ...state } : { stalled: false });
  });

  return router;
}
