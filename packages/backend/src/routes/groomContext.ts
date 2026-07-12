import { Router } from 'express';
import type { Request, Response } from 'express';
import { loadGroomContext } from '../groom/groomLoad';
import { getProjectRowById } from '../db/queries';

/**
 * Read-only surface for the /groom skill's Step-1 loader: wraps
 * loadGroomContext (groomLoad.ts) so the panel can fetch the same context
 * bundle (context pages, board, code worklist, git freshness, dependency
 * candidates) the skill loads in-process. Pure read — never writes.
 */
export function createGroomContextRouter(): Router {
  const router = Router();

  // GET /api/groom-context?milestone=M12&project=p1
  router.get('/groom-context', async (req: Request, res: Response) => {
    const milestone =
      typeof req.query.milestone === 'string' ? req.query.milestone : null;
    const project =
      typeof req.query.project === 'string' ? req.query.project : null;
    if (!milestone) {
      res.status(400).json({ error: 'milestone is required' });
      return;
    }

    let repoRoot: string | undefined;
    if (project) {
      const projectRow = getProjectRowById(project);
      if (!projectRow) {
        res.status(404).json({ error: `unknown project ${project}` });
        return;
      }
      repoRoot = projectRow.project_dir;
    }

    try {
      const result = await loadGroomContext(
        milestone,
        repoRoot ? { repoRoot } : undefined,
      );
      res.json({
        ...result,
        codeWorklist: Object.fromEntries(result.codeWorklist),
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'groom-context load failed',
      });
    }
  });

  return router;
}
