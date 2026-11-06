import { Router } from 'express';
import type { Request, Response } from 'express';
import { getTestHistory, getFlaggedFlakyTestsRollup } from '../db/queries';

export function createTestHistoryRouter(): Router {
  const router = Router();

  router.get(
    '/projects/:projectId/tests/flakiest',
    (req: Request, res: Response) => {
      res.json({
        tests: getFlaggedFlakyTestsRollup(String(req.params.projectId)),
      });
    },
  );

  router.get(
    '/projects/:projectId/tests/history',
    (req: Request, res: Response) => {
      const testId =
        typeof req.query.testId === 'string' ? req.query.testId : '';
      if (!testId) {
        res.status(400).json({ error: 'testId query parameter is required' });
        return;
      }
      res.json(getTestHistory(String(req.params.projectId), testId));
    },
  );

  return router;
}
