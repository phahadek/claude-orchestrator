import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  listEntriesForMilestone,
  getEntry,
  setEntryState,
  isValidOpsTransition,
  type OpsState,
} from '../ops/opsJournal';
import { requireDeviceAuth } from '../auth/DeviceAuth';
import {
  requireOpsJournalWriteAuth,
  type OpsJournalWriteAuthedRequest,
} from '../auth/OpsJournalAuth';
import { getSession } from '../db/queries';

/** Terminal state — reachable only through the device-authed operator path,
 *  never through a session-scoped journal-write credential. See § Terminal
 *  in the ops_journal decision-surface task. */
const RESOLVED_STATE: OpsState = 'resolved';

/**
 * Read/write surface for the Ops(N) staged-intent view: exposes per-task
 * ops_journal rows for a milestone so the frontend can render them in the
 * shared StagedIntentPanel, and the single state-transition write
 * (setEntryState) the skill performs while working a task. Disposition
 * stays human-gated at the transition level via isValidOpsTransition.
 *
 * The state-transition write additionally accepts a dispatched ops
 * session's scoped journal-write credential (requireOpsJournalWriteAuth),
 * restricted to that session's own task and to the staging transitions —
 * never -> resolved, which stays device-auth/operator-only. This is
 * additive: the existing device-authed interactive /ops path keeps full,
 * unrestricted access to every transition.
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
    requireOpsJournalWriteAuth,
    (req: Request, res: Response) => {
      const taskId = String(req.params.taskId);
      const opsJournalSession = (req as OpsJournalWriteAuthedRequest)
        .opsJournalSession;

      if (opsJournalSession) {
        const session = getSession(opsJournalSession.sessionId);
        if (!session?.task_id || session.task_id !== taskId) {
          res.status(403).json({
            error: 'ops_journal: session credential is scoped to its own task',
            code: 'ops_journal_wrong_task',
          });
          return;
        }
      }

      const body = req.body as {
        state?: unknown;
        resolution?: unknown;
        disposition?: unknown;
      };
      const state =
        typeof body.state === 'string' ? (body.state as OpsState) : null;
      if (!state) {
        res.status(400).json({ error: 'state is required' });
        return;
      }

      if (opsJournalSession && state === RESOLVED_STATE) {
        res.status(403).json({
          error:
            'ops_journal: -> resolved requires device-auth (operator), not a session credential',
          code: 'ops_journal_resolved_requires_device_auth',
        });
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
      if (body.disposition !== undefined)
        fields.disposition = body.disposition;

      try {
        setEntryState(taskId, state, fields);
        res.json(getEntry(taskId));
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
