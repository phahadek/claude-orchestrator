import { useCallback } from 'react';
import type { ClientMessage } from '@claude-orchestrator/backend/src/ws/types';
import type { ProjectConfig } from '@claude-orchestrator/backend/src/config';

export interface DispatchTask {
  notionUrl: string;
  taskType?: string;
  taskName?: string;
  milestoneId?: string | null;
  taskKind?: 'milestone' | 'non_milestone';
}

/** Shared hook for dispatching one or more coding sessions via WebSocket. */
export function useDispatch(
  send: (msg: ClientMessage) => void,
  project: ProjectConfig | null,
): (tasks: DispatchTask[]) => void {
  return useCallback(
    (tasks) => {
      if (!project || tasks.length === 0) return;
      send({
        type: 'dispatch',
        tasks: tasks.map((t) => ({
          taskUrl: t.notionUrl,
          projectContextUrl: project.contextUrl,
          taskType: t.taskType,
          projectId: project.id,
          ...(t.milestoneId !== undefined && { milestoneId: t.milestoneId }),
          ...(t.taskKind !== undefined && { taskKind: t.taskKind }),
          ...(t.taskName !== undefined && { taskName: t.taskName }),
        })),
      });
    },
    [send, project],
  );
}
