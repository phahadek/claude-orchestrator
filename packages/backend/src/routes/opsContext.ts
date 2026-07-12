import { Router } from 'express';
import type { Request, Response } from 'express';
import { loadOpsContext } from '../ops/opsLoad';

/**
 * Read-only surface for the /ops skill's loader: wraps loadOpsContext
 * (opsLoad.ts) so the panel can fetch the same context bundle (context
 * pages, board summary, classified worklist) the skill loads in-process.
 * Seeds/reconciles ops_journal as a side effect, same as the skill.
 */
export function createOpsContextRouter(): Router {
  const router = Router();

  // GET /api/ops-context?milestone=<milestoneId>&project=<projectId>
  router.get('/ops-context', async (req: Request, res: Response) => {
    const milestone =
      typeof req.query.milestone === 'string' ? req.query.milestone : null;
    const project =
      typeof req.query.project === 'string' ? req.query.project : null;
    if (!milestone) {
      res.status(400).json({ error: 'milestone is required' });
      return;
    }

    try {
      const result = await loadOpsContext(
        milestone,
        project ? { project } : undefined,
      );
      res.json(result);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'ops-context load failed',
      });
    }
  });

  return router;
}
