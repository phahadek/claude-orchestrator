import { Router } from 'express';
import type { Request, Response } from 'express';
import { loadDesignContext } from '../design/designLoad';

/**
 * Read-only surface for the /design skill's loader: wraps loadDesignContext
 * (designLoad.ts) so a dispatched design session (and the planning-procedure
 * assembler) can fetch the design digest for a target task — the same bundle
 * the skill would assemble in-process. Mirrors createGroomContextRouter /
 * createOpsContextRouter.
 */
export function createDesignContextRouter(): Router {
  const router = Router();

  // GET /api/design-context?milestone=<milestoneId>&task=<taskId>&project=<projectId>
  router.get('/design-context', async (req: Request, res: Response) => {
    const milestone =
      typeof req.query.milestone === 'string' ? req.query.milestone : null;
    const task = typeof req.query.task === 'string' ? req.query.task : null;
    const project =
      typeof req.query.project === 'string' ? req.query.project : null;
    if (!milestone) {
      res.status(400).json({ error: 'milestone is required' });
      return;
    }
    if (!task) {
      res.status(400).json({ error: 'task is required' });
      return;
    }

    try {
      const result = await loadDesignContext(
        milestone,
        task,
        project ? { project } : undefined,
      );
      res.json(result);
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error ? err.message : 'design-context load failed',
      });
    }
  });

  return router;
}
