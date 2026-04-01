import { useState, useCallback } from 'react';
import type { ServerMessage, PermissionDenial } from '@claude-dashboard/backend/src/ws/types';
import type { ResolvedTask } from '@claude-dashboard/backend/src/notion/types';

export interface SessionState {
  sessionId: string;
  taskName: string;
  notionTaskUrl: string;
  taskType?: string;
  status: string;
  events: { eventType: string; content: string; timestamp: number }[];
  pendingPermission?: { toolName: string; proposedAction: string };
  permissionDenials?: PermissionDenial[];
  prUrl?: string;
  /** Unix ms — set from SQLite sessions.started_at for JSONL-imported sessions */
  started_at?: number;
  /** Unix ms — set from SQLite sessions.ended_at for JSONL-imported sessions */
  ended_at?: number;
}

export function useSessionStore() {
  const [sessions, setSessions] = useState<Map<string, SessionState>>(new Map());
  const [tasks, setTasks] = useState<ResolvedTask[]>([]);
  const [tasksReady, setTasksReady] = useState(false);
  const [synced, setSynced] = useState(false);

  const dispatch = useCallback((msg: ServerMessage) => {
    setSynced(true);
    setSessions((prev) => {
      const next = new Map(prev);
      switch (msg.type) {
        case 'session_started':
          next.set(msg.sessionId, {
            sessionId: msg.sessionId,
            taskName: msg.taskName,
            notionTaskUrl: msg.notionTaskUrl,
            taskType: msg.taskType,
            status: 'starting',
            events: [],
            started_at: msg.started_at,
            ended_at: msg.ended_at,
          });
          break;
        case 'session_event': {
          const s = next.get(msg.sessionId);
          if (s) {
            next.set(msg.sessionId, {
              ...s,
              events: [
                ...s.events,
                { eventType: msg.eventType, content: msg.content, timestamp: Date.now() },
              ],
            });
          }
          break;
        }
        case 'session_status': {
          const s = next.get(msg.sessionId);
          if (s) next.set(msg.sessionId, { ...s, status: msg.status });
          break;
        }
        case 'permission_request': {
          const s = next.get(msg.sessionId);
          if (s) {
            next.set(msg.sessionId, {
              ...s,
              status: 'needs_permission',
              pendingPermission: { toolName: msg.toolName, proposedAction: msg.proposedAction },
            });
          }
          break;
        }
        case 'permission_denials': {
          const s = next.get(msg.sessionId);
          if (s) {
            next.set(msg.sessionId, {
              ...s,
              permissionDenials: msg.denials,
            });
          }
          break;
        }
        case 'session_ended': {
          const s = next.get(msg.sessionId);
          if (s) {
            next.set(msg.sessionId, {
              ...s,
              status: msg.status,
              prUrl: msg.prUrl,
              pendingPermission: undefined,
            });
          }
          break;
        }
        default:
          return prev;
      }
      return next;
    });

    if (msg.type === 'tasks_ready') {
      setTasks(msg.tasks);
      setTasksReady(true);
    }
  }, []);

  const deleteSession = useCallback((sessionId: string) => {
    setSessions((prev) => {
      const next = new Map(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);

  return { sessions: [...sessions.values()], tasks, tasksReady, synced, dispatch, deleteSession };
}
