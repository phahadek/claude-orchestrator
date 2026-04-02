import { useState, useCallback } from 'react';
import type { ServerMessage, PermissionDenial } from '@claude-dashboard/backend/src/ws/types';
import type { ResolvedTask } from '@claude-dashboard/backend/src/notion/types';

const DISMISSED_DENIALS_KEY = 'permission_denials_dismissed';

function loadDismissedFromStorage(): Map<string, Set<string>> {
  try {
    const raw = localStorage.getItem(DISMISSED_DENIALS_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as Record<string, string[]>;
    return new Map(Object.entries(parsed).map(([k, v]) => [k, new Set(v)]));
  } catch {
    return new Map();
  }
}

function saveDismissedToStorage(map: Map<string, Set<string>>): void {
  try {
    const obj: Record<string, string[]> = {};
    for (const [k, v] of map) obj[k] = [...v];
    localStorage.setItem(DISMISSED_DENIALS_KEY, JSON.stringify(obj));
  } catch { /* quota or private browsing */ }
}

export interface SessionState {
  sessionId: string;
  taskName: string;
  notionTaskUrl: string;
  taskType?: string;
  sessionType?: string;
  status: string;
  events: { eventType: string; content: string; timestamp: number; messageId?: string }[];
  pendingPermission?: { toolName: string; proposedAction: string };
  permissionDenials?: PermissionDenial[];
  prUrl?: string;
  /** Unix ms — set from SQLite sessions.started_at for JSONL-imported sessions */
  started_at?: number;
  /** Unix ms — set from SQLite sessions.ended_at for JSONL-imported sessions */
  ended_at?: number;
  archived?: boolean;
  favorited?: boolean;
  project_id?: string | null;
  note?: string | null;
  tags?: string[];
  /** True when the latest event indicates an API rate-limit interruption */
  isRateLimited?: boolean;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  /** PR number this review session is reviewing (review sessions only) */
  prNumber?: number;
  model?: string | null;
}

export interface IncompleteReview {
  prNumber: number;
  repo: string;
  message: string;
}

export function useSessionStore() {
  const [sessions, setSessions] = useState<Map<string, SessionState>>(new Map());
  const [tasks, setTasks] = useState<ResolvedTask[]>([]);
  const [tasksReady, setTasksReady] = useState(false);
  const [synced, setSynced] = useState(false);
  const [dismissedDenialIds, setDismissedDenialIds] = useState<Map<string, Set<string>>>(loadDismissedFromStorage);
  const [prRefreshTrigger, setPrRefreshTrigger] = useState(0);
  const [lastPrReviewEvent, setLastPrReviewEvent] = useState<{ prNumber: number; repo: string; verdict: string; summary: string } | null>(null);
  const [incompleteReviews, setIncompleteReviews] = useState<IncompleteReview[]>([]);

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
            sessionType: msg.sessionType,
            status: 'starting',
            events: [],
            started_at: msg.started_at,
            ended_at: msg.ended_at,
            archived: msg.archived ?? false,
            favorited: msg.favorited ?? false,
            project_id: msg.project_id,
            note: msg.note,
            tags: msg.tags,
            totalInputTokens: msg.totalInputTokens ?? 0,
            totalOutputTokens: msg.totalOutputTokens ?? 0,
            prNumber: msg.prNumber,
            model: msg.model ?? null,
            prUrl: msg.prUrl,
          });
          break;
        case 'session_event': {
          const s = next.get(msg.sessionId);
          if (s) {
            let isRateLimited = s.isRateLimited;
            try {
              const payload = JSON.parse(msg.content) as Record<string, unknown>;
              if (payload && typeof payload === 'object' && payload.type === 'rate_limit_event') {
                const info = payload.rate_limit_info as Record<string, unknown> | undefined;
                if (info?.status === 'rate_limited') isRateLimited = true;
                else if (info?.status === 'resumed') isRateLimited = false;
              }
            } catch { /* not JSON */ }
            const newEvent = { eventType: msg.eventType, content: msg.content, timestamp: Date.now(), messageId: msg.messageId };
            let events: typeof s.events;
            // Upsert by messageId: if we already have an event with this messageId,
            // replace it in-place instead of appending a duplicate.
            if (msg.messageId) {
              const idx = s.events.findIndex((e) => e.messageId === msg.messageId);
              if (idx >= 0) {
                events = [...s.events];
                events[idx] = newEvent;
              } else {
                events = [...s.events, newEvent];
              }
            } else {
              events = [...s.events, newEvent];
            }
            next.set(msg.sessionId, { ...s, isRateLimited, events });
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
        case 'session_updated': {
          const s = next.get(msg.sessionId);
          if (s) {
            next.set(msg.sessionId, {
              ...s,
              ...(Object.prototype.hasOwnProperty.call(msg, 'note') && { note: msg.note }),
              ...(Object.prototype.hasOwnProperty.call(msg, 'tags') && { tags: msg.tags }),
              ...(msg.totalInputTokens != null && { totalInputTokens: msg.totalInputTokens }),
              ...(msg.totalOutputTokens != null && { totalOutputTokens: msg.totalOutputTokens }),
              ...(msg.model != null && { model: msg.model }),
            });
          }
          break;
        }
        case 'pr_created': {
          const s = next.get(msg.sessionId);
          if (s) next.set(msg.sessionId, { ...s, prUrl: msg.prUrl });
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
    if (msg.type === 'task_status_changed') {
      setTasks((prev) => prev.map((t) =>
        t.task.id === msg.notionTaskId
          ? { ...t, task: { ...t.task, status: msg.newStatus } }
          : t,
      ));
    }
    if (msg.type === 'pr_created') {
      setPrRefreshTrigger((n) => n + 1);
    }
    if (msg.type === 'pr_review_complete') {
      setLastPrReviewEvent({ prNumber: msg.prNumber, repo: msg.repo, verdict: msg.verdict, summary: msg.summary });
    }
    if (msg.type === 'review_incomplete') {
      setIncompleteReviews((prev) => [...prev, { prNumber: msg.prNumber, repo: msg.repo, message: msg.message }]);
    }
  }, []);

  const resetTasks = useCallback(() => {
    setTasksReady(false);
    setTasks([]);
  }, []);

  const deleteSession = useCallback((sessionId: string) => {
    setSessions((prev) => {
      const next = new Map(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);

  const setSessionArchived = useCallback((sessionId: string, archived: boolean) => {
    setSessions((prev) => {
      const s = prev.get(sessionId);
      if (!s) return prev;
      const next = new Map(prev);
      next.set(sessionId, { ...s, archived });
      return next;
    });
  }, []);

  const setSessionFavorited = useCallback((sessionId: string, favorited: boolean) => {
    setSessions((prev) => {
      const s = prev.get(sessionId);
      if (!s) return prev;
      const next = new Map(prev);
      next.set(sessionId, { ...s, favorited });
      return next;
    });
  }, []);

  const dismissDenial = useCallback((sessionId: string, toolUseId: string) => {
    setDismissedDenialIds((prev) => {
      const next = new Map(prev);
      const existing = next.get(sessionId) ?? new Set<string>();
      next.set(sessionId, new Set([...existing, toolUseId]));
      saveDismissedToStorage(next);
      return next;
    });
  }, []);

  const dismissAllDenials = useCallback((sessionId: string, toolUseIds: string[]) => {
    setDismissedDenialIds((prev) => {
      const next = new Map(prev);
      next.set(sessionId, new Set(toolUseIds));
      saveDismissedToStorage(next);
      return next;
    });
  }, []);

  const clearSessionDenials = useCallback((sessionId: string) => {
    setSessions((prev) => {
      const s = prev.get(sessionId);
      if (!s) return prev;
      const next = new Map(prev);
      next.set(sessionId, { ...s, permissionDenials: [] });
      return next;
    });
    setDismissedDenialIds((prev) => {
      const next = new Map(prev);
      next.delete(sessionId);
      saveDismissedToStorage(next);
      return next;
    });
  }, []);

  const dismissIncompleteReviews = useCallback(() => {
    setIncompleteReviews([]);
  }, []);

  const readyCount = tasks.filter((t) => !t.blocked && t.task.status === '🗂️ Ready').length;
  const blockedCount = tasks.filter((t) => t.blocked).length;

  return { sessions: [...sessions.values()], tasks, tasksReady, synced, readyCount, blockedCount, dispatch, resetTasks, deleteSession, setSessionArchived, setSessionFavorited, dismissedDenialIds, dismissDenial, dismissAllDenials, clearSessionDenials, prRefreshTrigger, lastPrReviewEvent, incompleteReviews, dismissIncompleteReviews };
}
