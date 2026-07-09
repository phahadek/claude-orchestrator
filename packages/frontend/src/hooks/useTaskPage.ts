import { useState, useEffect, useRef } from 'react';
import { apiRequest } from '../api/projects';

interface TaskPageState {
  markdown: string | null;
  loading: boolean;
  error: string | null;
}

const cache = new Map<string, string>();

function cacheKey(taskId: string, projectId: string): string {
  return `${projectId}:${taskId}`;
}

/** Lazily fetches a task's full spec body as markdown, caching by taskId + projectId. */
export function useTaskPage(
  taskId: string | null | undefined,
  projectId: string | null | undefined,
): TaskPageState {
  const [state, setState] = useState<TaskPageState>({
    markdown: null,
    loading: false,
    error: null,
  });
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!taskId || !projectId) {
      setState({ markdown: null, loading: false, error: null });
      return;
    }

    const key = cacheKey(taskId, projectId);
    const cached = cache.get(key);
    if (cached !== undefined) {
      setState({ markdown: cached, loading: false, error: null });
      return;
    }

    const requestId = ++requestIdRef.current;
    setState({ markdown: null, loading: true, error: null });

    apiRequest<{ markdown: string }>(
      `/api/tasks/${encodeURIComponent(taskId)}/page?projectId=${encodeURIComponent(projectId)}`,
    )
      .then((res) => {
        if (requestIdRef.current !== requestId) return;
        cache.set(key, res.markdown);
        setState({ markdown: res.markdown, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (requestIdRef.current !== requestId) return;
        setState({
          markdown: null,
          loading: false,
          error:
            err instanceof Error ? err.message : 'Failed to load task spec',
        });
      });
  }, [taskId, projectId]);

  return state;
}
