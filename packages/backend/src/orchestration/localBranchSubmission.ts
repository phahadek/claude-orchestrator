import {
  getProjectRowById,
  getLocalBranchBySession,
  insertLocalBranch,
} from '../db/queries';
import { logger } from '../logger';
import { emitTaskUpdated } from '../routes/tasks';
import type { TaskBackend } from '../tasks/TaskBackend';
import type { ServerMessage } from '../ws/types';

export interface SubmitLocalBranchOpts {
  projectId: string;
  sessionId: string;
  taskId: string;
  featureBranchName: string | undefined;
  baseBranch: string;
  hasDiff: boolean;
  taskBackend: TaskBackend;
  broadcast: (msg: ServerMessage) => void;
}

/**
 * Inserts the local_branches row that carries a local-only session's
 * completed feature branch into review, mirroring the pull_requests row a
 * github-mode session gets from its PR. Shared by the clean-exit/periodic
 * recovery chain (sessionRecovery.recoverSession) and the idle-transition
 * path in StuckSessionMonitor — both observe the same "session finished,
 * branch differs from base, diff is non-empty" condition and must submit
 * exactly once, so this is idempotent via getLocalBranchBySession.
 *
 * Callers are responsible for computing featureBranchName/hasDiff (git reads
 * belong to the caller so tests can mock them per call site).
 */
export function submitLocalBranch(opts: SubmitLocalBranchOpts): boolean {
  const {
    projectId,
    sessionId,
    taskId,
    featureBranchName,
    baseBranch,
    hasDiff,
    taskBackend,
    broadcast,
  } = opts;

  if (
    !projectId ||
    !featureBranchName ||
    featureBranchName === baseBranch ||
    !hasDiff
  ) {
    return false;
  }

  const project = getProjectRowById(projectId);
  if (project?.git_mode !== 'local-only') return false;

  if (getLocalBranchBySession(sessionId)) return false;

  const now = new Date().toISOString();
  insertLocalBranch({
    project_id: projectId,
    session_id: sessionId,
    branch_name: featureBranchName,
    base_branch: baseBranch,
    status: 'open',
    review_result: null,
    created_at: now,
    updated_at: now,
  });
  broadcast({
    type: 'local_branch_submitted',
    projectId,
    sessionId,
    branchName: featureBranchName,
    baseBranch,
  });
  taskBackend
    .updateStatus(taskId, '👀 In Review')
    .then(() => {
      broadcast({
        type: 'task_status_changed',
        notionTaskId: taskId,
        newStatus: '👀 In Review',
      });
      emitTaskUpdated(taskId);
    })
    .catch((e) =>
      logger.error(`[submitLocalBranch] updateStatus failed: ${e}`),
    );

  return true;
}
