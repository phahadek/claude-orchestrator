import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireDeviceAuth } from '../auth/DeviceAuth';
import { getTaskBackend } from '../tasks/TaskBackend';
import { BackendTaskWriteCommands } from '../tasks/TaskWriteCommands';
import { toCanonicalStatus } from '../tasks/statusCanonical';
import { getActivePlanningSessionForTask } from '../db/queries';
import { recordEvent } from '../audit/AuditLog';
import { asyncHandler } from './asyncHandler';

interface SessionManagerLike {
  kill(sessionId: string): Promise<void>;
}

const DEFAULT_ABORT_NOTE =
  'Aborted: mis-filed Backlog task returned to Deferred via the abort route.';

/**
 * Device-authed-only remedy for a mis-filed 🔲 Backlog task: flips it to
 * ⏭️ Deferred and, if a groom session is actively bound to it, kills that
 * session with reason `user_kill` (reused verbatim so
 * isPlanningKillSuppressed keeps working unmodified). Restricted to
 * Backlog-status tasks only — a dispatched session never holds a device
 * token (only ORCHESTRATOR_STAGE_TOKEN, see AgentSession.ts), so gating this
 * on requireDeviceAuth structurally limits it to the operator + RC sessions,
 * never a session acting on its own task.
 *
 * Order matters: status flips to Deferred first, then the session is
 * killed. If the request fails between the two steps, the task is already
 * excluded from isGroomCandidate (its first check is status === 'Backlog')
 * regardless of whether the kill landed.
 */
export function createTaskAbortRouter(
  sessionManager?: SessionManagerLike,
): Router {
  const router = Router();

  // POST /api/tasks/:id/abort
  router.post(
    '/tasks/:id/abort',
    requireDeviceAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const taskId = String(req.params.id);
      const body = req.body as { projectId?: unknown; note?: unknown };
      const projectId =
        typeof body.projectId === 'string' ? body.projectId : null;
      const note =
        typeof body.note === 'string' && body.note.trim()
          ? body.note
          : DEFAULT_ABORT_NOTE;

      if (!projectId) {
        res.status(400).json({ error: 'projectId is required' });
        return;
      }

      const backend = getTaskBackend(projectId);
      const summary = await backend.fetchTaskSummary(taskId);
      if (!summary) {
        res.status(404).json({ error: `task not found: ${taskId}` });
        return;
      }
      const currentStatus = toCanonicalStatus(summary.status);
      if (currentStatus !== 'Backlog') {
        res.status(400).json({
          error: `task ${taskId} is not in Backlog (current status: ${summary.status})`,
        });
        return;
      }

      try {
        const commands = new BackendTaskWriteCommands(backend, projectId);
        await commands.setStatus(taskId, 'Deferred', { source: 'human' });
        await backend.appendImplementationNote(taskId, note);

        let killedSessionId: string | null = null;
        const groomSession = getActivePlanningSessionForTask(taskId, 'groom');
        if (groomSession && sessionManager) {
          await sessionManager.kill(groomSession.session_id);
          killedSessionId = groomSession.session_id;
        }

        recordEvent({
          event_type: 'task_aborted',
          actor_type: 'human',
          actor_id: null,
          project_id: projectId,
          task_id: taskId,
          payload: { taskId, projectId, note, killedSessionId },
        });

        res.json({ ok: true, killedSessionId });
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : 'abort failed',
        });
      }
    }),
  );

  return router;
}
