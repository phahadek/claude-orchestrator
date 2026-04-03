import type { ResolvedTask } from '../notion/types';

export interface TaskTrackerBackend {
  /** Fetch tasks that are ready to be dispatched for a given board/project. */
  fetchReadyTasks(boardId: string, skipCache?: boolean): Promise<ResolvedTask[]>;

  /** Mark a task as in-review and attach a PR URL. */
  attachPR(taskId: string, prUrl: string): Promise<void>;

  /** Update task status. */
  updateStatus(taskId: string, status: string): Promise<void>;

  /** Fetch full task page body as markdown (for PR review bot context). */
  fetchTaskPage(taskId: string): Promise<string>;

  /** Backend identifier, used in config. */
  readonly type: 'notion' | 'local';
}
