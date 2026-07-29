import {
  upsertPullRequest,
  getPRByNumber,
  getProjectRowById,
  getSession,
  insertSessionAudit,
} from '../db/queries';
import { logger } from '../logger';
import {
  getCurrentBranch,
  hasNonEmptyDiff,
} from '../orchestration/localBranchHelpers';
import { submitLocalBranch } from '../orchestration/localBranchSubmission';
import { emitTaskUpdated } from '../routes/tasks';
import type { TaskBackend } from '../tasks/TaskBackend';
import type { GitHubClient } from '../github/GitHubClient';
import type { ServerMessage } from '../ws/types';
import type { ISessionManager } from './SessionAuditor';
import { SessionAuditor } from './SessionAuditor';
import { NoOpInvestigator } from '../github/NoOpInvestigator';
import type { INoOpSessionManager } from '../github/NoOpInvestigator';
import { recordEvent } from '../audit/AuditLog';
import { isCodeSession } from './sessionPredicates';

export interface RecoverSessionOpts {
  scope: 'clean_exit' | 'boot' | 'periodic';
  prUrl: string | undefined;
  prDetectedLive: boolean;
  sessionType: string;
  taskId: string;
  projectId: string;
  worktreePath: string;
  taskUrl: string;
  projectContextUrl: string;
  githubClient?: GitHubClient;
  taskBackend: TaskBackend;
  sessionManager?: ISessionManager;
  broadcast: (msg: ServerMessage) => void;
  emitPrOpened: (data: {
    prNumber: number;
    repo: string;
    taskId: string;
    taskUrl: string;
    contextUrl: string;
  }) => void;
  baseBranch?: string;
}

/**
 * Executes the post-session-end side-effect chain for a session.
 * Extracted from AgentSession.handleCleanExit so the same chain can be
 * invoked by StuckSessionMonitor for periodic stuck-session recovery.
 *
 * The scope parameter gates certain side-effects (no-op investigator spawn,
 * pr_opened emission) and is recorded in the session_backfilled audit event
 * for telemetry. Local-only branch submission runs for every scope via
 * submitLocalBranch, which is idempotent per session.
 */
export async function recoverSession(
  sessionId: string,
  opts: RecoverSessionOpts,
): Promise<void> {
  const {
    scope,
    prUrl,
    prDetectedLive,
    sessionType,
    taskId,
    projectId,
    worktreePath,
    taskUrl,
    projectContextUrl,
    githubClient,
    taskBackend,
    sessionManager,
    broadcast,
    emitPrOpened,
  } = opts;

  const projectRow = getProjectRowById(projectId);
  const baseBranch = opts.baseBranch ?? projectRow?.base_branch ?? 'dev';

  if (isCodeSession(sessionType)) {
    try {
      let hasDiff = false;
      let featureBranchName: string | undefined;
      try {
        const branchName = await getCurrentBranch(worktreePath);
        featureBranchName = branchName ?? undefined;
        if (branchName && branchName !== baseBranch) {
          hasDiff = await hasNonEmptyDiff(worktreePath, baseBranch, branchName);
        }
      } catch (e) {
        logger.error(`[recoverSession] hasDiff computation failed: ${e}`);
      }

      // No-op detection: skipped for periodic scope (StuckSessionMonitor handles retries differently).
      if (
        scope !== 'periodic' &&
        !prUrl &&
        !hasDiff &&
        taskId &&
        sessionManager &&
        'start' in sessionManager
      ) {
        const project = projectId ? getProjectRowById(projectId) : undefined;
        const repo = project?.github_repo ?? '';
        const sessionRow = getSession(sessionId);
        const taskCreatedAt = sessionRow
          ? new Date(sessionRow.started_at).toISOString()
          : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const investigator = new NoOpInvestigator(
          sessionManager as unknown as INoOpSessionManager,
          taskBackend,
          githubClient,
        );
        investigator
          .investigate({
            taskId,
            taskUrl,
            projectContextUrl,
            projectId,
            noOpSessionId: sessionId,
            baseBranch,
            featureBranchName,
            repo,
            taskCreatedAt,
          })
          .catch((e) => {
            logger.error(
              `[recoverSession] NoOpInvestigator.investigate failed for ${sessionId}: ${e}`,
            );
          });
      }

      if (prUrl && !prDetectedLive) {
        taskBackend
          .attachPR(taskId, prUrl)
          .catch((e) => logger.error(`[recoverSession] attachPR failed: ${e}`));
      }

      let existingPrState: string | undefined;
      if (prUrl) {
        const prMatch = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
        if (prMatch) {
          const repo = prMatch[1];
          const prNumber = parseInt(prMatch[2], 10);
          existingPrState = getPRByNumber(prNumber, repo)?.state;
          const now = new Date().toISOString();
          let headSha: string | null = null;
          if (githubClient) {
            try {
              const freshPR = await githubClient.fetchPR(repo, prNumber);
              headSha = freshPR.headSha ?? null;
            } catch (e) {
              logger.warn(
                `[recoverSession] failed to fetch PR #${prNumber} from GitHub for head_sha:`,
                e,
              );
            }
          }
          if (existingPrState !== 'merged' && existingPrState !== 'closed') {
            const upserted = upsertPullRequest({
              pr_number: prNumber,
              pr_url: prUrl,
              task_id: taskId || null,
              session_id: sessionId,
              repo,
              title: null,
              body: null,
              head_branch: null,
              base_branch: null,
              state: 'open',
              draft: 0,
              review_result: null,
              review_at: null,
              created_at: now,
              updated_at: now,
              synced_at: now,
              node_id: null,
              head_sha: headSha,
              conflict_nudge_sha: null,
            });
            // pr_opened emission is skipped for periodic scope or phantom URLs.
            if (upserted && !prDetectedLive && scope !== 'periodic') {
              emitPrOpened({
                prNumber,
                repo,
                taskId,
                taskUrl,
                contextUrl: projectContextUrl,
              });
            }
          }
        }
      }

      if (
        prUrl &&
        existingPrState !== 'merged' &&
        existingPrState !== 'closed'
      ) {
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
            logger.error(`[recoverSession] updateStatus failed: ${e}`),
          );
      }

      // Local-only project submission — shared with StuckSessionMonitor's
      // idle-transition path via submitLocalBranch.
      if (projectId) {
        try {
          submitLocalBranch({
            projectId,
            sessionId,
            taskId,
            featureBranchName,
            baseBranch,
            hasDiff,
            taskBackend,
            broadcast,
          });
        } catch (e) {
          logger.error(
            `[recoverSession] local-only submission check failed: ${e}`,
          );
        }
      }
    } catch (e) {
      logger.error(`[recoverSession] post-done error for ${sessionId}:`, e);
    }
  }

  broadcast({
    type: 'session_ended',
    sessionId,
    // Process-exit sets idle (waiting for PR merge); boot/periodic scopes
    // operate on already-done sessions persisted before a restart.
    status: scope === 'clean_exit' ? 'idle' : 'done',
    ...(prUrl ? { prUrl } : {}),
    ...(taskId && { taskId }),
  });

  if (isCodeSession(sessionType)) {
    const auditor = new SessionAuditor(
      taskBackend,
      githubClient,
      sessionManager,
    );
    auditor
      .audit({ sessionId, taskId, prUrl, sessionType, worktreePath }, 0)
      .then((audit) => {
        insertSessionAudit({
          session_id: audit.sessionId,
          pr_opened: audit.prOpened ? 1 : 0,
          pr_targets: audit.prTargetsBranch,
          task_status: audit.taskStatusAfter,
          violations: JSON.stringify(audit.violations),
          spec_mismatch: audit.specMismatch,
          audited_at: audit.auditedAt,
        });
        broadcast({
          type: 'session_audit',
          sessionId: audit.sessionId,
          prOpened: audit.prOpened,
          prTargetsBranch: audit.prTargetsBranch,
          violations: audit.violations,
          specMismatch: audit.specMismatch,
          auditedAt: audit.auditedAt,
        });
        // Light nudge when session completed without opening a PR.
        if (!audit.prOpened) {
          broadcast({ type: 'missed_pr_nudge', sessionId: audit.sessionId });
        }
      })
      .catch((err) => {
        logger.error(`[recoverSession] audit failed for ${sessionId}: ${err}`);
      });
  }

  try {
    recordEvent({
      event_type: 'session_backfilled',
      actor_type: 'system',
      actor_id: sessionId,
      project_id: projectId || null,
      task_id: taskId || null,
      payload: { scope },
    });
  } catch (e) {
    logger.error(
      `[recoverSession] session_backfilled audit write failed: ${e}`,
    );
  }
}
