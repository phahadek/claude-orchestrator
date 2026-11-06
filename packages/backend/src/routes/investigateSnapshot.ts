import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  buildInvestigateDbSnapshot,
  UnknownInvestigateProjectError,
} from '../investigation/investigateSnapshot';
import { asyncHandler } from './asyncHandler';

/**
 * Read-only surface for the /investigate loader (scripts/investigate-load.mjs):
 * serves the DB-derived half of the live-health snapshot so the skill works from
 * a host that does not hold dashboard.db.
 */
export function createInvestigateSnapshotRouter(): Router {
  const router = Router();

  // GET /api/investigate-snapshot?project=<projectId>[&limit=<n>][&hours=<n>]
  router.get(
    '/investigate-snapshot',
    asyncHandler(async (req: Request, res: Response) => {
      const project =
        typeof req.query.project === 'string' ? req.query.project : null;
      if (!project) {
        res.status(400).json({ error: 'project is required' });
        return;
      }
      const limit = Number(req.query.limit) || undefined;
      const hours = Number(req.query.hours) || undefined;
      try {
        res.json(buildInvestigateDbSnapshot(project, { limit, hours }));
      } catch (err) {
        if (err instanceof UnknownInvestigateProjectError) {
          res.status(404).json({ error: err.message });
          return;
        }
        res.status(500).json({
          error:
            err instanceof Error
              ? err.message
              : 'investigate-snapshot load failed',
        });
      }
    }),
  );

  return router;
}
