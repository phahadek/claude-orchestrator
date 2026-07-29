import { Router } from 'express';
import type { Request, Response } from 'express';
import { getArm, listArm, upsertArm } from '../db/queries';
import { recordEvent } from '../audit/AuditLog';
import { FLOW_IDS, isFlowId } from '../orchestration/flowArm';

/**
 * Per-flow auto-dispatch arm surface (Technical Architecture § "Per-flow
 * auto-dispatch arm model"). Independent of autoLaunchEnabled — no gating
 * relationship in either direction. Disarm stops NEW dispatches only; it
 * does not kill in-flight stage-only sessions.
 */
export function createMilestonesRouter(): Router {
  const router = Router();

  // GET /api/milestones/:milestoneId/arm -> effective per-flow state
  router.get(
    '/milestones/:milestoneId/arm',
    (req: Request, res: Response) => {
      const milestoneId = String(req.params.milestoneId);
      res.json(listArm(milestoneId));
    },
  );

  // PUT /api/milestones/:milestoneId/arm/:flow { armed }
  router.put(
    '/milestones/:milestoneId/arm/:flow',
    (req: Request, res: Response) => {
      const milestoneId = String(req.params.milestoneId);
      const flow = String(req.params.flow);
      if (!isFlowId(flow)) {
        res
          .status(400)
          .json({ error: `flow must be one of: ${FLOW_IDS.join(', ')}` });
        return;
      }
      const body = req.body as { armed?: unknown };
      if (typeof body.armed !== 'boolean') {
        res.status(400).json({ error: 'armed must be a boolean' });
        return;
      }

      const { previous } = upsertArm(milestoneId, flow, body.armed, Date.now());
      recordEvent({
        event_type: 'flow_arm_changed',
        actor_type: 'human',
        payload: {
          milestone: milestoneId,
          flow,
          armed: body.armed,
          previous,
        },
      });

      res.json({ milestoneId, flow, armed: getArm(milestoneId, flow) });
    },
  );

  return router;
}
