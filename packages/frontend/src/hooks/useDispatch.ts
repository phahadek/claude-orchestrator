import { useCallback } from 'react';
import type { ClientMessage } from '@claude-dashboard/backend/src/ws/types';
import type { ProjectConfig } from '@claude-dashboard/backend/src/config';

/** Shared hook for dispatching one or more coding sessions via WebSocket. */
export function useDispatch(
  send: (msg: ClientMessage) => void,
  project: ProjectConfig | null,
): (tasks: Array<{ taskUrl: string; taskType?: string }>) => void {
  return useCallback(
    (tasks) => {
      if (!project || tasks.length === 0) return;
      send({
        type: 'dispatch',
        tasks: tasks.map((t) => ({
          taskUrl: t.taskUrl,
          projectContextUrl: project.contextUrl,
          taskType: t.taskType,
          projectId: project.id,
        })),
      });
    },
    [send, project],
  );
}
