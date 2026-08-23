import { Router } from 'express';
import type { Request, Response } from 'express';
import type { SessionManager } from '../session/SessionManager';
import { launchInvestigateBatch } from '../investigation/investigateDispatcher';
import { asyncHandler } from './asyncHandler';

/**
 * The operator-triggered investigate dispatch surface — the manual-dispatch
 * counterpart to investigation/investigationReconciler.ts's auto-dispatch
 * tick, both funneling through the same launchInvestigateBatch dispatcher.
 * Mirrors routes/gateState.ts's `POST /api/gate/verify-launch`.
 */
export function createInvestigateRouter(
  sessionManager: SessionManager,
): Router {
  const router = Router();

  // POST /api/investigate/launch  { reportIds }
  router.post(
    '/investigate/launch',
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as { reportIds?: unknown };
      const reportIds =
        Array.isArray(body.reportIds) &&
        body.reportIds.every((id) => typeof id === 'string')
          ? (body.reportIds as string[])
          : null;
      if (!reportIds || reportIds.length === 0) {
        res.status(400).json({ error: 'a non-empty reportIds[] is required' });
        return;
      }
      try {
        const sessionId = await launchInvestigateBatch(
          sessionManager,
          reportIds,
        );
        res.status(202).json({ sessionId, reportIds });
      } catch (err) {
        res.status(400).json({
          error:
            err instanceof Error ? err.message : 'investigate dispatch failed',
        });
      }
    }),
  );

  return router;
}
