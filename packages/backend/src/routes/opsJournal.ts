import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  listEntriesForMilestone,
  getEntry,
  setEntryState,
  isValidOpsTransition,
  type OpsState,
  type OpsJournalEntry,
} from '../ops/opsJournal';
import { requireDeviceAuth } from '../auth/DeviceAuth';
import { stageIntent } from './stagedIntents';

/** The state at which an ops_journal entry becomes an operator-reviewable
 *  decision — the point this route also mirrors it into a staged_intent so
 *  it renders on the decision surface (DecisionPanel reads staged_intent,
 *  not ops_journal). */
const STAGED_PROPOSAL_STATE: OpsState = 'staged-proposal';

/** Best-effort short human-readable summary of a journal entry's finding for
 *  the staged intent's `decisionProposal` — the payload itself carries the
 *  full structured finding, this is just the panel headline. */
function summarizeDecision(entry: OpsJournalEntry): string {
  const finding = entry.findingOrProposal;
  if (typeof finding === 'string' && finding.trim()) return finding.trim();
  if (finding && typeof finding === 'object') {
    const candidate =
      (finding as Record<string, unknown>).summary ??
      (finding as Record<string, unknown>).proposal;
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return `ops_journal proposal for ${entry.taskId} — awaiting sign-off`;
}

/**
 * Stage (or re-stage) the journal.setState decision for this entry so it
 * shows up on the decision surface. Content-idempotent (stageIntent dedups
 * by payload hash), so a re-transition into staged-proposal with unchanged
 * fields is a no-op rather than a duplicate row.
 */
function stageJournalDecision(
  entry: OpsJournalEntry,
  sessionId: string | null,
): void {
  stageIntent(
    'journal.setState',
    {
      taskId: entry.taskId,
      state: entry.state,
      fields: {
        disposition: entry.disposition,
        findingOrProposal: entry.findingOrProposal,
        evidence: entry.evidence,
        resolution: entry.resolution,
      },
    },
    entry.project,
    null,
    sessionId,
    summarizeDecision(entry),
  );
}

/**
 * Read/operator-write surface for the Ops(N) staged-intent view: exposes
 * per-task ops_journal rows for a milestone so the frontend can render them
 * in the shared StagedIntentPanel, and the state-transition write
 * (setEntryState) the interactive /ops skill performs while working a task.
 * Disposition stays human-gated at the transition level via
 * isValidOpsTransition. Device-authed only — a dispatched ops session
 * drives its journal forward by staging a `journal.setState` intent through
 * the orchestrator MCP tool surface instead (see mcp/tools/stageProposalTools.ts);
 * the session-scoped journal-write credential this route used to also accept
 * has been retired.
 */
export function createOpsJournalRouter(): Router {
  const router = Router();

  // GET /api/ops-journal?milestone=M12
  router.get(
    '/ops-journal',
    requireDeviceAuth,
    (req: Request, res: Response) => {
      const milestone =
        typeof req.query.milestone === 'string' ? req.query.milestone : null;
      if (!milestone) {
        res.status(400).json({ error: 'milestone is required' });
        return;
      }
      const entries = listEntriesForMilestone(milestone);
      res.json({ entries });
    },
  );

  // POST /api/ops-journal/:taskId/state
  router.post(
    '/ops-journal/:taskId/state',
    requireDeviceAuth,
    (req: Request, res: Response) => {
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
      if (!isValidOpsTransition(current.state, state)) {
        res.status(400).json({
          error: `invalid transition ${current.state} -> ${state} for task ${taskId}`,
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
        setEntryState(taskId, state, fields);
        const updated = getEntry(taskId);
        // The entry becomes an operator-reviewable decision at
        // staged-proposal — mirror it into a staged_intent so it actually
        // renders on the decision surface, regardless of whether the
        // session also stages a journal.setState intent itself.
        if (updated && updated.state === STAGED_PROPOSAL_STATE) {
          stageJournalDecision(updated, null);
        }
        res.json(updated);
      } catch (err) {
        res.status(500).json({
          error:
            err instanceof Error ? err.message : 'ops-journal write failed',
        });
      }
    },
  );

  return router;
}
