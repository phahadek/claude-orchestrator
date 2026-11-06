import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  listEntriesForMilestone,
  getEntry,
  setEntryState,
  isValidOpsTransition,
  opsResolveRequiresReconciliationOrReason,
  hasReconciliationOrNoChangeReason,
  type OpsState,
} from '../ops/opsJournal';
import { requireDeviceAuth } from '../auth/DeviceAuth';
import { requireDeviceOrSessionRouteAuth } from '../auth/SessionRouteAuth';
import { stageJournalDecision, STAGED_PROPOSAL_STATE } from './stagedIntents';
import { getLatestOpsSessionByTaskId, getMilestoneById } from '../db/queries';
import {
  resolveMilestoneRowForProject,
  UnknownMilestoneError,
} from '../projects/milestoneResolver';
import { closeDeferredOpsTask } from '../orchestration/PlanningOrchestrator';
import { getCachedType } from '../tasks/TaskWriteCommands';
import { logger } from '../logger';
import { asyncHandler } from './asyncHandler';

/**
 * Read/operator-write surface for the Ops(N) staged-intent view: exposes
 * per-task ops_journal rows for a milestone so the frontend can render them
 * in the shared StagedIntentPanel, and the state-transition write
 * (setEntryState) the interactive /ops skill performs while working a task.
 * Disposition stays human-gated at the transition level via
 * isValidOpsTransition. The read (GET) is reachable by a dispatched session
 * holding a per-session route credential (see SessionRouteAuth.ts) and a
 * matching operator-granted `Bash(node .../ops-client.mjs journal ...)`
 * capability, same as the operator/RC-session device token. The write
 * (POST .../state) stays device-only — a dispatched ops session drives its
 * journal forward by staging a `journal.setState` intent through the
 * orchestrator MCP tool surface instead (see mcp/tools/stageProposalTools.ts);
 * the session-scoped journal-write credential this route used to also accept
 * has been retired, and this task does not reopen it.
 */
export function createOpsJournalRouter(): Router {
  const router = Router();

  // GET /api/ops-journal?milestone=M12
  router.get(
    '/ops-journal',
    requireDeviceOrSessionRouteAuth,
    (req: Request, res: Response) => {
      const milestone =
        typeof req.query.milestone === 'string' ? req.query.milestone : null;
      if (!milestone) {
        res.status(400).json({ error: 'milestone is required' });
        return;
      }
      const project =
        typeof req.query.project === 'string' && req.query.project
          ? req.query.project
          : null;
      let milestoneId = getMilestoneById(milestone)?.id ?? null;
      if (!milestoneId && project) {
        try {
          milestoneId = resolveMilestoneRowForProject(project, milestone).id;
        } catch (err) {
          if (!(err instanceof UnknownMilestoneError)) throw err;
        }
      }
      if (!milestoneId) {
        // Back-compat: a ref that is already the stored journal key.
        const direct = listEntriesForMilestone(milestone);
        if (direct.length > 0) {
          res.json({ entries: direct });
          return;
        }
        res.status(404).json({
          error:
            `unknown milestone "${milestone}"` +
            (project
              ? ` for project "${project}"`
              : ' (pass project= to resolve a canonical name)'),
        });
        return;
      }
      const entries = listEntriesForMilestone(milestoneId);
      res.json({ entries });
    },
  );

  // POST /api/ops-journal/:taskId/state
  router.post(
    '/ops-journal/:taskId/state',
    requireDeviceAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const taskId = String(req.params.taskId);

      const body = req.body as {
        state?: unknown;
        resolution?: unknown;
        disposition?: unknown;
        findingOrProposal?: unknown;
        evidence?: unknown;
        workedIn?: unknown;
        falsification?: unknown;
        filedFollowons?: unknown;
        needsFromOperator?: unknown;
        reconciliation?: { description?: unknown; passed?: unknown } | null;
        noChangeReason?: unknown;
      };
      const state =
        typeof body.state === 'string' ? (body.state as OpsState) : null;
      if (!state) {
        res.status(400).json({ error: 'state is required' });
        return;
      }

      const current = getEntry(taskId);
      if (!current) {
        res
          .status(404)
          .json({ error: `no ops_journal entry for task ${taskId}` });
        return;
      }
      const taskType = getCachedType(taskId);
      if (!isValidOpsTransition(current.state, state, taskType)) {
        res.status(400).json({
          error: `invalid transition ${current.state} -> ${state} for task ${taskId}`,
        });
        return;
      }
      if (
        opsResolveRequiresReconciliationOrReason(
          current.state,
          state,
          taskType,
        ) &&
        !hasReconciliationOrNoChangeReason(body)
      ) {
        res.status(400).json({
          error:
            `${current.state} -> resolved for task ${taskId} requires either a ` +
            '"reconciliation" assertion ({"description", "passed"}) or a non-empty "noChangeReason"',
        });
        return;
      }

      const fields: Record<string, unknown> = {};
      if (body.resolution !== undefined) fields.resolution = body.resolution;
      if (body.disposition !== undefined) fields.disposition = body.disposition;
      if (body.findingOrProposal !== undefined) {
        fields.findingOrProposal = body.findingOrProposal;
      }
      if (body.evidence !== undefined) fields.evidence = body.evidence;
      if (body.workedIn !== undefined) fields.workedIn = body.workedIn;
      if (body.falsification !== undefined) {
        fields.falsification = body.falsification;
      }
      if (body.filedFollowons !== undefined) {
        fields.filedFollowons = body.filedFollowons;
      }
      if (body.needsFromOperator !== undefined) {
        fields.needsFromOperator = body.needsFromOperator;
      }

      try {
        setEntryState(taskId, state, fields, taskType);
        const updated = getEntry(taskId);
        // The entry becomes an operator-reviewable decision at
        // staged-proposal — mirror it into a staged_intent so it actually
        // renders on the decision surface, regardless of whether the
        // session also stages a journal.setState intent itself.
        if (updated && updated.state === STAGED_PROPOSAL_STATE) {
          stageJournalDecision(updated, null);
        }
        // The operator-confirmed applied-pending-confirm -> resolved path is
        // the deferred half of ops-task closure: the owning session has
        // typically already gone terminal by the time this lands (see
        // closeDeferredOpsTask's docstring), so completeOpsTask's
        // synchronous check at markTerminal's exact instant never catches
        // it. Best-effort — a failure here must not roll back the journal
        // write, which already succeeded.
        if (updated && updated.state === 'resolved') {
          const opsSession = getLatestOpsSessionByTaskId(taskId);
          if (opsSession) {
            try {
              await closeDeferredOpsTask(opsSession);
            } catch (err) {
              logger.error(
                `[opsJournal] deferred close failed for task ${taskId}: ${err}`,
              );
            }
          }
        }
        res.json(updated);
      } catch (err) {
        res.status(500).json({
          error:
            err instanceof Error ? err.message : 'ops-journal write failed',
        });
      }
    }),
  );

  return router;
}
