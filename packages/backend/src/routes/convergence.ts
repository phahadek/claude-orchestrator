import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  getMilestoneConvergence,
  listProjectConvergence,
} from '../convergence/convergenceService';
import { UnknownMilestoneError } from '../projects/milestoneResolver';

/**
 * The milestone convergence read-surface: composes the four readiness axes
 * (Notion tasks, gate, seed, ops) at request time. Consumed by the M13
 * Milestone view, the decision inbox, and the trigger evaluator.
 */
export function createConvergenceRouter(): Router {
  const router = Router();

  // GET /api/milestones/:project/:milestone/convergence
  router.get(
    '/milestones/:project/:milestone/convergence',
    (req: Request, res: Response) => {
      const project = String(req.params.project);
      const milestone = String(req.params.milestone);
      try {
        res.json(getMilestoneConvergence(project, milestone));
      } catch (err) {
        if (err instanceof UnknownMilestoneError) {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  // GET /api/milestones/:project/convergence
  router.get(
    '/milestones/:project/convergence',
    (req: Request, res: Response) => {
      const project = String(req.params.project);
      try {
        res.json(listProjectConvergence(project));
      } catch (err) {
        if (err instanceof UnknownMilestoneError) {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  return router;
}
