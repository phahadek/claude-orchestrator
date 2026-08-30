import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  getArm,
  listArm,
  upsertArm,
  getLaneHealthRollup,
  listFlowHealthRegressionSnapshotHistory,
  getGateVerifyAutoCommitPolicy,
  listGateVerifyAutoCommitPolicy,
  upsertGateVerifyAutoCommitPolicy,
} from '../db/queries';
import { recordEvent } from '../audit/AuditLog';
import { FLOW_IDS, isFlowId } from '../orchestration/flowArm';
import { ProjectService } from '../projects/ProjectService';
import { checkMilestoneRegistered } from '../groom/groomLoad';
import { asyncHandler } from './asyncHandler';
import { detectFlowHealthRegressionSignal } from '../convergence/attentionSignals';
import {
  fileFlakyInvestigationTask,
  FlakyInvestigationFilingError,
} from '../audit/flakyRemediationFiling';
import {
  GATE_VERIFY_AUTO_COMMIT_DISPOSITION_CLASSES,
  isGateVerifyAutoCommitDispositionClass,
  sweepGateVerifyAutoCommitBacklogForMilestone,
} from './stagedIntents';

/** FlakyInvestigationFilingError.reason -> HTTP status. */
const FLAKY_INVESTIGATION_ERROR_STATUS: Record<
  FlakyInvestigationFilingError['reason'],
  number
> = {
  'no-test-ids': 400,
  'not-flagged-flaky': 409,
  'already-open': 409,
  'claim-conflict': 409,
  'unknown-milestone': 400,
  'backend-unsupported': 400,
};

// Auto-commit policy rows and the eligibility check that reads them are both
// keyed by the milestone's canonical short id (e.g. "M12"), not its DB board
// UUID. The arm UI passes the DB board UUID as :milestoneId, so every policy
// route must resolve it to the canonical short id before touching the table
// — otherwise an armed policy is written under a key the eligibility check
// never looks up.
function resolveMilestoneKey(milestoneId: string): string {
  return (
    ProjectService.getMilestone(milestoneId)?.canonicalShortId ?? milestoneId
  );
}

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

  // GET /api/milestones/:milestoneId/auto-commit-policy -> effective
  // per-disposition-class gate.verify auto-commit policy state.
  router.get(
    '/milestones/:milestoneId/auto-commit-policy',
    (req: Request, res: Response) => {
      const milestoneId = resolveMilestoneKey(String(req.params.milestoneId));
      const rows = listGateVerifyAutoCommitPolicy(milestoneId);
      const armedByClass = new Map(
        rows.map((r) => [r.disposition_class, r.armed === 1]),
      );
      const result: Record<string, { armed: boolean }> = {};
      for (const cls of GATE_VERIFY_AUTO_COMMIT_DISPOSITION_CLASSES) {
        result[cls] = { armed: armedByClass.get(cls) ?? false };
      }
      res.json(result);
    },
  );

  // PUT /api/milestones/:milestoneId/auto-commit-policy/:class { armed }
  // Arms/disarms auto-commit for a gate.verify disposition class. Arming
  // (armed: true) immediately sweeps and commits every already-staged/
  // approved gate.verify verdict matching the class for this milestone —
  // a policy grant must relieve the existing backlog, not just intents
  // staged afterward (see sweepGateVerifyAutoCommitBacklogForMilestone).
  router.put(
    '/milestones/:milestoneId/auto-commit-policy/:class',
    asyncHandler(async (req: Request, res: Response) => {
      const milestoneId = resolveMilestoneKey(String(req.params.milestoneId));
      const dispositionClass = String(req.params.class);
      if (!isGateVerifyAutoCommitDispositionClass(dispositionClass)) {
        res.status(400).json({
          error: `class must be one of: ${GATE_VERIFY_AUTO_COMMIT_DISPOSITION_CLASSES.join(', ')}`,
        });
        return;
      }
      const body = req.body as { armed?: unknown };
      if (typeof body.armed !== 'boolean') {
        res.status(400).json({ error: 'armed must be a boolean' });
        return;
      }

      const { previous } = upsertGateVerifyAutoCommitPolicy(
        milestoneId,
        dispositionClass,
        body.armed,
        Date.now(),
      );
      recordEvent({
        event_type: 'gate_verify_auto_commit_policy_changed',
        actor_type: 'human',
        payload: {
          milestone: milestoneId,
          dispositionClass,
          armed: body.armed,
          previous,
        },
      });

      let sweptCommittedIds: string[] = [];
      if (body.armed) {
        const swept = await sweepGateVerifyAutoCommitBacklogForMilestone(
          milestoneId,
          dispositionClass,
        );
        sweptCommittedIds = swept.committedIds;
      }

      res.json({
        milestoneId,
        dispositionClass,
        armed: getGateVerifyAutoCommitPolicy(milestoneId, dispositionClass),
        sweptCommittedIds,
      });
    }),
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
      res.json(getLaneHealthRollup(project, limit ?? 500));
    },
  );

  // GET /api/milestones/:project/flow-health -> flow-health snapshot trend
  // + the edge-triggered regression signal. Fleet-wide, not project-scoped
  // (flow_health_regression_snapshot carries no project column) — :project
  // is kept in the path only to follow the lane-health routing convention
  // above; the response is identical for every project id.
  router.get(
    '/milestones/:project/flow-health',
    (req: Request, res: Response) => {
      const limitParam = req.query.limit;
      let limit: number | undefined;
      if (typeof limitParam === 'string' && limitParam.trim() !== '') {
        const parsed = Number(limitParam);
        if (Number.isFinite(parsed) && parsed > 0) limit = Math.floor(parsed);
      }
      const history = listFlowHealthRegressionSnapshotHistory(limit ?? 90);
      const signal = detectFlowHealthRegressionSignal(history);
      res.json({ history, signal: signal[0] ?? null });
    },
  );

  // POST /api/milestones/:project/flaky-investigation -> file one operator-
  // driven 🔎 Investigation task at 🔲 Backlog covering an operator-selected
  // group of currently-flagged-flaky tests. Replaces the retired per-test
  // auto-filing path (see audit/flakyRemediationFiling.ts).
  router.post(
    '/milestones/:project/flaky-investigation',
    asyncHandler(async (req: Request, res: Response) => {
      const project = String(req.params.project);
      const body = req.body as { testIds?: unknown; milestoneId?: unknown };
      if (
        !Array.isArray(body.testIds) ||
        body.testIds.some((id) => typeof id !== 'string') ||
        body.testIds.length === 0
      ) {
        res
          .status(400)
          .json({ error: 'testIds must be a non-empty array of strings' });
        return;
      }
      if (typeof body.milestoneId !== 'string' || body.milestoneId === '') {
        res.status(400).json({ error: 'milestoneId must be a string' });
        return;
      }

      try {
        const result = await fileFlakyInvestigationTask({
          projectId: project,
          testIds: body.testIds as string[],
          milestoneId: body.milestoneId,
        });
        res.json({ taskId: result.taskId });
      } catch (err) {
        if (err instanceof FlakyInvestigationFilingError) {
          res
            .status(FLAKY_INVESTIGATION_ERROR_STATUS[err.reason])
            .json({ error: err.message, reason: err.reason });
          return;
        }
        res.status(500).json({ error: (err as Error).message });
      }
    }),
  );

  return router;
}
