import { apiRequest } from './projects';

/**
 * Read-only preview of a cross-milestone move: runs the same planMove used by
 * the task.move apply path, so the confirm UI can show the cascade set (later
 * move) before the operator stages the intent. Never mutates anything.
 */
export interface MoveTaskPreview {
  ok: true;
  isLaterMove: boolean;
  cascadeSet: string[];
  droppedEdges: { from: string; to: string }[];
}

export const taskMoveApi = {
  preview(params: {
    projectId: string;
    taskId: string;
    sourceMilestoneId: string;
    targetMilestoneId: string;
  }): Promise<MoveTaskPreview> {
    return apiRequest<MoveTaskPreview>('/api/tasks/move-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
  },
};
