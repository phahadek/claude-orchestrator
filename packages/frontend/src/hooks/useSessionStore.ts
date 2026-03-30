import { useState, useCallback } from 'react';
import type { ServerMessage } from '@claude-dashboard/backend/src/ws/types';
import type { NotionTask } from '@claude-dashboard/backend/src/notion/types';

export interface SessionState {
  sessionId: string;
  taskName: string;
  notionTaskUrl: string;
  status: string;
  events: { eventType: string; content: string; timestamp: number }[];
  pendingPermission?: { toolName: string; proposedAction: string };
  prUrl?: string;
}

export function useSessionStore() {
  const [sessions, setSessions] = useState<Map<string, SessionState>>(new Map());
  const [tasks, setTasks] = useState<NotionTask[]>([]);

  const dispatch = useCallback((msg: ServerMessage) => {
    setSessions((prev) => {
      const next = new Map(prev);
      switch (msg.type) {
        case 'session_started':
          next.set(msg.sessionId, {
            sessionId: msg.sessionId,
            taskName: msg.taskName,
            notionTaskUrl: msg.notionTaskUrl,
            status: 'starting',
            events: [],
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

    if (msg.type === 'tasks_ready') setTasks(msg.tasks);
  }, []);

  return { sessions: [...sessions.values()], tasks, dispatch };
}
