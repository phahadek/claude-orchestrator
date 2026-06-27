import { WebSocket } from 'ws';
import { ClientMessage } from './types';
import { logger } from '../logger';
import { SessionManager } from '../session/SessionManager';
import { getProjectById } from '../config';
import { approveEnrollment } from '../auth/Enrollment';
import { getTaskCache } from '../db/queries';
import { ProjectService } from '../projects/ProjectService';
import { DependencyResolver } from '../notion/DependencyResolver';
import type { NotionTask } from '../notion/types';

let refreshProjectFn:
  | ((projectId: string, skipCache?: boolean) => Promise<void>)
  | null = null;

export function setWsRouterRefreshFn(
  fn: (projectId: string, skipCache?: boolean) => Promise<void>,
): void {
  refreshProjectFn = fn;
}

export async function handleMessage(
  ws: WebSocket,
  raw: string,
  sessions: SessionManager,
): Promise<void> {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw) as ClientMessage;
  } catch {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
    return;
  }

  switch (msg.type) {
    case 'dispatch':
      if (!Array.isArray(msg.tasks)) {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: 'dispatch requires tasks array',
          }),
        );
        break;
      }
      for (const t of msg.tasks) {
        if (!t.taskUrl) {
          ws.send(
            JSON.stringify({
              type: 'error',
              message: 'dispatch task requires a non-empty taskUrl',
            }),
          );
          continue;
        }
        try {
          await sessions.start(t.taskUrl, t.projectContextUrl, {
            taskType: t.taskType,
            projectId: t.projectId,
            milestoneId: t.milestoneId,
            taskKind: t.taskKind ?? 'milestone',
            taskName: t.taskName,
          });
        } catch (e) {
          const err = e as Error & { alreadyRunning?: boolean };
          if (err.alreadyRunning) {
            ws.send(
              JSON.stringify({
                type: 'error',
                message: `Task already has an active session — no duplicate launched.`,
              }),
            );
          } else {
            ws.send(JSON.stringify({ type: 'error', message: String(e) }));
          }
        }
      }
      break;
    case 'approve':
      // The claude CLI --print mode does not support mid-session permission approval.
      // Tools are pre-approved via --allowedTools at spawn time. This is a no-op.
      logger.info(
        `[router] approve ignored — CLI does not support mid-session approval`,
      );
      break;
    case 'deny':
      logger.info(
        `[router] deny ignored — CLI does not support mid-session denial`,
      );
      break;
    case 'send_message':
      void sessions
        .sendOrResume(msg.sessionId, msg.message)
        .catch((err: unknown) => {
          logger.error(
            `[router] sendOrResume failed for session ${msg.sessionId}: ${String(err)}`,
          );
        });
      break;
    case 'kill':
      sessions.kill(msg.sessionId);
      break;
    case 'end_session':
      sessions.endSession(msg.sessionId);
      break;
    case 'fetch_tasks': {
      const rawMsg = msg as Record<string, unknown>;
      // Reject the legacy { boardId } payload with a clear error so callers update.
      if ('boardId' in rawMsg && !('milestoneId' in rawMsg)) {
        ws.send(
          JSON.stringify({
            type: 'error',
            message:
              'fetch_tasks payload changed: send { projectId, milestoneId }, not { boardId }',
          }),
        );
        break;
      }
      if (typeof msg.projectId !== 'string' || !msg.projectId) {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: 'fetch_tasks requires projectId',
          }),
        );
        break;
      }
      if (typeof msg.milestoneId !== 'string' || !msg.milestoneId) {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: 'fetch_tasks requires milestoneId',
          }),
        );
        break;
      }
      const project = getProjectById(msg.projectId);
      if (!project) {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: `Project not found: ${msg.projectId}`,
          }),
        );
        break;
      }
      // Serve from cache only — never block on a Notion round-trip.
      const milestone = ProjectService.getMilestone(msg.milestoneId);
      const isLocalTaskSource = project.taskSource === 'yaml';
      if (!milestone || (!isLocalTaskSource && !milestone.sourceId)) {
        ws.send(
          JSON.stringify({
            type: 'tasks_ready',
            tasks: [],
          }),
        );
        break;
      }
      const boardCacheKey = isLocalTaskSource
        ? milestone.id
        : (milestone.sourceId as string);
      const cacheRow = getTaskCache(`board:${boardCacheKey}`);
      if (!cacheRow) {
        ws.send(JSON.stringify({ type: 'tasks_ready', tasks: [] }));
        if (msg.skipCache && refreshProjectFn) {
          void refreshProjectFn(msg.projectId, true);
        }
        break;
      }
      try {
        const notionTasks = JSON.parse(cacheRow.raw_json) as NotionTask[];
        const resolver = new DependencyResolver();
        const resolved = resolver.resolve(notionTasks);
        ws.send(JSON.stringify({ type: 'tasks_ready', tasks: resolved }));
      } catch {
        ws.send(JSON.stringify({ type: 'tasks_ready', tasks: [] }));
      }
      // skipCache: true → trigger a background refresh so the cache gets fresh
      // data from Notion. The refresher broadcasts task_cache_updated on completion,
      // which the frontend uses to re-render and clear the Sync spinner.
      if (msg.skipCache && refreshProjectFn) {
        void refreshProjectFn(msg.projectId, true);
      }
      break;
    }
    case 'enrollment_approve': {
      const result = approveEnrollment(msg.code);
      if (!result) {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: 'invalid or expired enrollment code',
          }),
        );
        break;
      }
      ws.send(
        JSON.stringify({
          type: 'enrollment_approved',
          code: msg.code,
          deviceId: result.deviceId,
        }),
      );
      break;
    }
    default: {
      const _exhaustive: never = msg;
      void _exhaustive;
      ws.send(
        JSON.stringify({ type: 'error', message: 'Unknown message type' }),
      );
    }
  }
}
