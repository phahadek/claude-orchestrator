import { Router } from 'express';
import type { Request, Response } from 'express';
import { listEntriesForMilestone } from '../ops/opsJournal';

/**
 * Read-only surface for the Ops(N) staged-intent view: exposes per-task
 * ops_journal rows for a milestone so the frontend can render them in the
 * shared StagedIntentPanel. Disposition stays human-gated — this route never
 * writes.
 */
export function createOpsJournalRouter(): Router {
  const router = Router();

  // GET /api/ops-journal?milestone=M12
  router.get('/ops-journal', (req: Request, res: Response) => {
    const milestone =
      typeof req.query.milestone === 'string' ? req.query.milestone : null;
    if (!milestone) {
      res.status(400).json({ error: 'milestone is required' });
      return;
    }
    const entries = listEntriesForMilestone(milestone);
    res.json({ entries });
  });

  return router;
}
