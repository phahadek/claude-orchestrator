import { Router } from 'express';
import type { Request, Response } from 'express';
import { getArm, listArm, upsertArm, getLaneHealthRollup } from '../db/queries';
import { recordEvent } from '../audit/AuditLog';
import { FLOW_IDS, isFlowId } from '../orchestration/flowArm';
import { ProjectService } from '../projects/ProjectService';
import { checkMilestoneRegistered } from '../groom/groomLoad';
import { typedGetSetting } from '../config/settings';

/**
 * Per-flow auto-dispatch arm surface (Technical Architecture § "Per-flow
 * auto-dispatch arm model"). Independent of autoLaunchEnabled — no gating
 * relationship in either direction. Disarm stops NEW dispatches only; it
 * does not kill in-flight stage-only sessions.
 */
export function createMilestonesRouter(): Router {
  const router = Router();

  // GET /api/milestones/:milestoneId/arm -> effective per-flow state
  router.get('/milestones/:milestoneId/arm', (req: Request, res: Response) => {
    const milestoneId = String(req.params.milestoneId);
    res.json(listArm(milestoneId));
  });

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

      if (body.armed) {
        const milestone = ProjectService.getMilestone(milestoneId);
        if (milestone?.canonicalShortId) {
          const project = ProjectService.getById(milestone.projectId);
          const check = project
            ? checkMilestoneRegistered(
                project.projectDir,
                milestone.canonicalShortId,
              )
            : null;
          if (check && !check.registered) {
            res.status(409).json({
              error:
                `milestone "${milestone.canonicalShortId}" is not registered in the grooming manifest ` +
                `(registered: ${check.registeredKeys.join(', ') || 'none'}).`,
            });
            return;
          }
        }
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

  // GET /api/milestones/:project/lane-health -> project-scoped test-lane
  // health rollup (pass rate, timeout rate, queue-wait vs execution-time
  // distributions). Fleet-scoped, not milestone-scoped — test_request_runs
  // carries no milestone column — so :project is a project id, matching the
  // convergence router's convention.
  router.get(
    '/milestones/:project/lane-health',
    (req: Request, res: Response) => {
      const project = String(req.params.project);
      const limitParam = req.query.limit;
      let limit: number | undefined;
      if (typeof limitParam === 'string' && limitParam.trim() !== '') {
        const parsed = Number(limitParam);
        if (Number.isFinite(parsed) && parsed > 0) limit = Math.floor(parsed);
      }
      const flipRateWindowN = typedGetSetting('flip_rate_window_n');
      const flipRateThresholdK = typedGetSetting('flip_rate_threshold_k');
      res.json(
        getLaneHealthRollup(
          project,
          limit ?? 500,
          flipRateWindowN,
          flipRateThresholdK,
        ),
      );
    },
  );

  return router;
}
