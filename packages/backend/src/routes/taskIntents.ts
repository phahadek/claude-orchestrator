import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireSessionStageAuth } from '../auth/SessionStageAuth';
import {
  KNOWN_INTENT_KINDS,
  stageIntent,
  parseGroomProposal,
  runStageTimeReadyChecks,
} from './stagedIntents';
import { getSession } from '../db/queries';

/**
 * Loopback-only stage endpoint for the sanctioned session-side CLI client.
 * Sessions cannot reach raw HTTP (curl/wget are off the auto-dispatch
 * allowlist), so orchestrator-launched sessions submit staged task-write
 * intents here via the sanctioned node CLI client, authenticated by their
 * per-session scoped stage credential. This route only ever stages an
 * intent (a durable bookkeeping write, recording this session as its
 * originating session_id for panel correlation + pushback routing) — it
 * never applies one; apply is a human/device-auth-only surface reached
 * through POST /staged-intents/:id/apply, which this credential cannot
 * authenticate to.
 */
export function createTaskIntentsRouter(): Router {
  const router = Router();

  router.post(
    '/task-intents',
    requireSessionStageAuth,
    async (req: Request, res: Response) => {
      const { sessionId } = (
        req as Request & { stageSession: { sessionId: string } }
      ).stageSession;

      const session = getSession(sessionId);
      if (!session?.project_id) {
        res.status(404).json({ error: 'session not found or has no project' });
        return;
      }

      const body = req.body as {
        kind?: unknown;
        payload?: unknown;
        groupId?: unknown;
        decisionProposal?: unknown;
        groomProposal?: unknown;
      };
      const kind = typeof body.kind === 'string' ? body.kind : null;
      const groupId = typeof body.groupId === 'string' ? body.groupId : null;
      const decisionProposal =
        typeof body.decisionProposal === 'string'
          ? body.decisionProposal
          : null;
      const groomProposal = parseGroomProposal(body.groomProposal);

      if (!kind) {
        res.status(400).json({ error: 'kind is required' });
        return;
      }
      if (!KNOWN_INTENT_KINDS.has(kind)) {
        res.status(400).json({ error: `unknown intent kind "${kind}"` });
        return;
      }

      const intent = stageIntent(
        kind,
        body.payload,
        session.project_id,
        groupId,
        sessionId,
        decisionProposal,
        groomProposal,
      );
      const checked = await runStageTimeReadyChecks(intent);
      res.status(201).json(checked);
    },
  );

  return router;
}
