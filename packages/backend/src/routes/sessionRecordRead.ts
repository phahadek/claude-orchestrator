import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireSessionStageAuth } from '../auth/SessionStageAuth';
import { getSession, getEventsBySession, getGrantedCapabilities } from '../db/queries';
import { getAuditLogByActorId } from '../audit/AuditLog';
import { sessionRecordReadCapability } from '../session/orchestrator-config';
import { isSystemOnlyUserEvent } from '../utils/eventFilters';
import { eventKind } from '../session/eventKind';

/**
 * Loopback-only read endpoint materialising the one grantable own-record
 * read capability (see `session/orchestrator-config.ts#sessionRecordReadCapability`):
 * the orchestrator's own runtime records (session_events + audit_log) for a
 * single named target session id.
 *
 * A dispatched session never holds device auth, so this route is
 * authenticated by the requester's own per-session stage credential (the
 * same one `POST /api/task-intents` accepts) rather than
 * `requireDeviceAuth` — but a stage credential alone is not enough: the
 * requesting session must additionally hold a durable, operator-approved
 * grant naming this exact target session id (see
 * `routes/stagedIntents.ts#resumeCapabilityRequester` ->
 * `SessionManager.grantCapability`). No grant, no read — this route never
 * falls back to serving the record anyway.
 *
 * Strictly read-only: there is no corresponding write route, and this
 * endpoint mutates nothing.
 */
export function createSessionRecordReadRouter(): Router {
  const router = Router();

  router.get(
    '/session-record-reads/:targetSessionId',
    requireSessionStageAuth,
    (req: Request, res: Response) => {
      const { sessionId: requestingSessionId } = (
        req as Request & { stageSession: { sessionId: string } }
      ).stageSession;
      const targetSessionId = String(req.params.targetSessionId);

      const capability = sessionRecordReadCapability(targetSessionId);
      const granted = getGrantedCapabilities(requestingSessionId);
      if (!granted.includes(capability)) {
        res.status(403).json({
          error: 'capability not granted',
          code: 'capability_not_granted',
          capability,
        });
        return;
      }

      const session = getSession(targetSessionId);
      if (!session) {
        res.status(404).json({ error: 'session not found' });
        return;
      }

      const events = getEventsBySession(targetSessionId)
        .filter((ev) => !isSystemOnlyUserEvent(ev.payload))
        .map((ev) => ({
          eventType: eventKind(ev),
          content: ev.payload,
          timestamp: ev.timestamp,
          ...(ev.message_id != null && { messageId: ev.message_id }),
        }));
      const auditLog = getAuditLogByActorId(targetSessionId);

      res.json({ session, events, auditLog });
    },
  );

  return router;
}
