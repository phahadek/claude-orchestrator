import { useEffect, useState, useRef, useCallback } from 'react';
import type { ResolvedTask } from '@claude-orchestrator/backend/src/notion/types';
import type { ClientMessage } from '@claude-orchestrator/backend/src/ws/types';

export interface UseTasksParams {
  projectId: string | null;
  milestoneId: string | null;
  send: (msg: ClientMessage) => boolean;
  /** Tasks slice from useSessionStore — driven by tasks_ready WS messages. */
  tasks: ResolvedTask[];
  /** Counter that increments on WS events that should refetch (session start/end, task status changes, PR events). */
  refreshTrigger?: number;
}

export interface UseTasksResult {
  tasks: ResolvedTask[];
  loading: boolean;
  refresh: () => void;
}

/**
 * Drives WS `fetch_tasks` requests for the active project + milestone and tracks the
 * loading state for the response. The actual task data still lives in useSessionStore
 * (populated by the `tasks_ready` event); this hook just orchestrates when to refetch.
 */
export function useTasks({ projectId, milestoneId, send, tasks, refreshTrigger }: UseTasksParams): UseTasksResult {
  const [loading, setLoading] = useState(false);
  const lastTasksRef = useRef<ResolvedTask[]>(tasks);
  const lastTriggerRef = useRef<number | undefined>(refreshTrigger);

  // Mount + project/milestone change → fetch.
  useEffect(() => {
    if (!projectId || !milestoneId) return;
    const sent = send({ type: 'fetch_tasks', projectId, milestoneId });
    if (sent) setLoading(true);
  }, [projectId, milestoneId, send]);

  // Auto-refresh when an external WS event nudges the counter.
  useEffect(() => {
    if (refreshTrigger == null) return;
    if (refreshTrigger === lastTriggerRef.current) return;
    lastTriggerRef.current = refreshTrigger;
    if (!projectId || !milestoneId) return;
    const sent = send({ type: 'fetch_tasks', projectId, milestoneId });
    if (sent) setLoading(true);
  }, [refreshTrigger, projectId, milestoneId, send]);

  // tasks_ready installs a new array reference — clear loading once it lands.
  useEffect(() => {
    if (lastTasksRef.current !== tasks) {
      lastTasksRef.current = tasks;
      setLoading(false);
    }
  }, [tasks]);

  const refresh = useCallback(() => {
    if (!projectId || !milestoneId) return;
    const sent = send({ type: 'fetch_tasks', projectId, milestoneId, skipCache: true });
    if (sent) setLoading(true);
  }, [projectId, milestoneId, send]);

  return { tasks, loading, refresh };
}
