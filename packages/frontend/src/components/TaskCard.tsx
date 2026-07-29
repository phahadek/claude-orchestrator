import { useState } from 'react';
import { authedFetch } from '../api/projects';
import type { TaskView, DisplayStatus, PauseReason } from '../types/taskView';
import type { ClientMessage } from '@claude-orchestrator/backend/src/ws/types';
import type { ProjectConfig } from '@claude-orchestrator/backend/src/config';
import { parsePauseReason } from '@claude-orchestrator/backend/src/db/pauseReason';
import { formatTokenCount } from '@claude-orchestrator/backend/src/utils/usage';
import { CIBadges, PipelineStageBadge } from './CIBadges';
import { ContextBadge } from './ContextBadge';
import { getTaskSourceLinkLabel } from '../utils/taskSourceLabel';
import { TaskMoveDialog } from './TaskMoveDialog';
import type { StagedIntent } from '../api/stagedIntents';
import styles from './TaskCard.module.css';

interface Props {
  task: TaskView;
  selected: boolean;
  onClick: () => void;
  send: (msg: ClientMessage) => void;
  project: ProjectConfig | null;
  /** The current board (milestone) id, used to resolve the move source milestone. */
  boardId?: string | null;
  /** Called when a task.move intent is staged, so the parent can display it. */
  onMoveStaged?: (intent: StagedIntent) => void;
}

function getProjectRepos(
  project: { githubRepo?: string } | null | undefined,
): string[] {
  const raw = project?.githubRepo;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as string[];
  } catch {
    /* bare string */
  }
  return [raw];
}

const STATUS_LABELS: Record<DisplayStatus, string> = {
  needs_attention: '⚠️ Needs Attention',
  ready_to_merge: '✅ Ready to Merge',
  in_progress: '🔄 In Progress',
  in_review: '👀 In Review',
  ready: '🗂️ Ready',
  done: '✔️ Done',
  backlog: '🔲 Backlog',
  blocked: '🚫 Blocked',
  deferred: '⏭️ Deferred',
};

const PAUSE_REASON_LABELS: Record<PauseReason, string> = {
  max_reviews: 'Max review iterations reached — re-review or close the PR.',
  stuck_timeout: 'Session stuck — no progress within the timeout window.',
  ci_failing: 'CI is failing — fix the failing checks and push.',
  ci_billing_blocked:
    'GitHub billing limit reached — jobs cannot start. Resolve billing in GitHub settings, then re-run failed jobs.',
  auto_merge_failed: 'Auto-merge failed — merge manually or investigate.',
  pr_closed: 'PR was closed during auto-merge — reopen or create a new PR.',
  review_failed: 'Re-review failed unexpectedly — check the backend logs.',
  api_overloaded:
    'API overloaded (529) — session paused. Resume when the API recovers.',
  merge_conflict:
    'Merge conflict detected — rebase onto the base branch and resolve conflicts.',
  awaiting_human_approval:
    'Awaiting human approval — approve the PR to proceed with auto-merge.',
  human_changes_requested:
    'Human reviewer requested changes — address the feedback and push.',
  pr_body_invalid:
    'PR body missing required sections — update the PR description and resume.',
  attribution_missing:
    'Commit attribution trailer missing — add AI-Authored-By to commits and push.',
  audit_findings:
    'Post-session audit found issues — review and address the findings.',
  pr_creation_failed:
    "PR creation failed — the session couldn't open its PR. Review and retry.",
  stalled_idle:
    'Session stalled without opening a PR — review and resume or abort.',
  notion_done_update_stuck:
    'PR merged but Notion status update failed repeatedly — update Notion to Done manually and clear the pause.',
  launch_failed:
    'Launch failed repeatedly — fix the underlying issue (e.g. delete the stale branch) then restart the backend.',
  diverged_branch:
    'Branch has diverged from origin — manual reconciliation needed before auto-push can resume.',
  diverged_branch_unresolved:
    'Branch diverged and repeated rebase nudges failed — manual rebase required.',
  analyze_failing:
    'Static analysis gate failed — fix the reported issues and re-push.',
  rate_limit:
    'API rate limit reached — session paused. Will resume automatically.',
  stalled_reconcile_cap:
    'PR stalled — reconciler retry cap reached. Manual intervention required.',
  needs_repo:
    'No repo assigned — assign a target repository before this task can launch.',
  autofix_git_infra_failure:
    'Git infrastructure failure (exit 128) during autofix — likely a corrupted .git/config. The orchestrator attempted a repair; manual inspection may be needed.',
  autofix_tool_infra_failure:
    'Autofix tool could not execute — a host/environment issue (config load abort, toolchain incompatibility), not a code defect. Fix the host tooling, then rerun.',
  workflow_scope_denied:
    'Push rejected: the auto-dispatch PAT lacks the `workflow` scope and cannot modify .github/workflows/. Re-type this task as 🛠️ Tooling and land it interactively with a workflow-scoped credential.',
  resume_failed:
    'Session could not be resumed at boot (missing worktree, or the resumed process failed immediately) — review and redispatch when ready.',
  review_rules_escalation:
    'Reviewer escalated per project-specific review rules — see the review summary for details and resolve manually.',
  planning_crashed:
    'Planning session crashed repeatedly — review the session and redispatch planning when ready.',
  planning_first_turn_empty:
    'Planning session finished its first turn without staging anything — review the transcript and redispatch or close.',
  planning_terminal_no_decision:
    'Planning session reached a terminal state without ever staging a decision — review and redispatch planning when ready.',
};

function verdictLabel(verdict: string): string {
  if (verdict === 'approved') return '✅ Approved';
  if (verdict === 'needs_changes') return '🔁 Needs changes';
  if (verdict === 'incomplete') return '❌ Incomplete';
  return verdict;
}

export function TaskCard({
  task,
  selected,
  onClick,
  project,
  boardId = null,
  onMoveStaged,
}: Props) {
  const { codeSession, pr, review } = task;
  const isMultiRepo = getProjectRepos(project).length > 1;
  const needsRepo = isMultiRepo && task.assignedRepo === null;
  const [recoveryInFlight, setRecoveryInFlight] = useState(false);
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const statusKey = task.displayStatus.replace(/_/g, '-') as string;

  // Derive implementing/reviewing pre-stages when no post-PR pipeline stage is active.
  // Post-PR stages (pr.preReviewStage) always take precedence.
  const derivedPreStage: string | null = (() => {
    if (
      !pr &&
      codeSession?.status === 'running' &&
      (codeSession.sessionType === 'standard' || !codeSession.sessionType)
    )
      return 'implementing';
    if (
      pr &&
      review?.status === 'running' &&
      (review.verdict === null || review.iterationCount > 1)
    )
      return 'reviewing';
    return null;
  })();
  const isNonCode = !task.taskType.includes('💻');
  const pauseStruct = parsePauseReason(task.pauseReason);

  const handleRecover = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (recoveryInFlight || !project?.id) return;
    setRecoveryInFlight(true);
    try {
      await authedFetch(
        `/api/tasks/${encodeURIComponent(task.taskId)}/recover?projectId=${encodeURIComponent(project.id)}`,
        { method: 'POST' },
      );
    } catch {
      // state will be updated via WS broadcast
    } finally {
      setRecoveryInFlight(false);
    }
  };

  return (
    <div
      className={`${styles.card} ${selected ? styles.selected : ''} ${isNonCode ? styles.nonCode : ''}`}
      onClick={onClick}
      data-status={task.displayStatus}
    >
      <div className={styles.header}>
        <span className={styles.taskName}>{task.taskName}</span>
        <span
          className={`${styles.statusBadge} ${styles[`status-${statusKey}`] ?? ''}`}
          title={
            pauseStruct
              ? `[${pauseStruct.source}] ${PAUSE_REASON_LABELS[pauseStruct.reason] ?? pauseStruct.reason}` +
                (pauseStruct.reason === 'stalled_reconcile_cap' &&
                task.pauseDetail
                  ? ` (${task.pauseDetail})`
                  : '')
              : undefined
          }
          data-pause-severity={pauseStruct?.severity}
          data-pause-source={pauseStruct?.source}
        >
          {STATUS_LABELS[task.displayStatus]}
        </span>
      </div>

      {task.priority && <div className={styles.priority}>{task.priority}</div>}

      {!isNonCode && (
        <>
          {codeSession && (
            <div className={styles.sessionRow}>
              <span
                className={`${styles.sessionStatus} ${styles[`session-${codeSession.status}`] ?? ''}`}
              >
                {codeSession.status}
              </span>
              {codeSession.lastMessage && (
                <span className={styles.lastMessage}>
                  {codeSession.lastMessage}
                </span>
              )}
            </div>
          )}

          {codeSession &&
            ['running', 'needs_permission', 'retrying', 'starting'].includes(
              codeSession.status,
            ) && (
              <div className={styles.contextRow}>
                <ContextBadge
                  contextOccupancyTokens={codeSession.context_occupancy_tokens}
                  compactionCount={codeSession.compaction_count}
                  model={codeSession.model}
                />
              </div>
            )}

          {!codeSession && <span className={styles.placeholder}>—</span>}

          {pr ? (
            <div className={styles.prRow}>
              <a
                href={pr.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.prLink}
                onClick={(e) => e.stopPropagation()}
              >
                #{pr.prNumber}
              </a>
              <span className={styles.prState}>
                {pr.draft ? 'draft' : pr.state}
              </span>
              {pr.mergeState === 'dirty' && (
                <span
                  className={styles.conflictBadge}
                  title="PR has merge conflicts"
                >
                  ⚠ Conflict
                </span>
              )}
              {review?.verdict && (
                <span
                  className={`${styles.verdict} ${styles[`verdict-${review.verdict.replace(/_/g, '-')}`] ?? ''}`}
                >
                  {verdictLabel(review.verdict)}
                </span>
              )}
              <CIBadges
                mergeState={pr.mergeState}
                pauseReason={task.pauseReason}
                prState={pr.state}
              />
              <PipelineStageBadge
                stage={pr.preReviewStage ?? derivedPreStage}
                prState={pr.state}
                compact
              />
            </div>
          ) : derivedPreStage ? (
            <div className={styles.prRow}>
              <PipelineStageBadge stage={derivedPreStage} compact />
            </div>
          ) : (
            <span className={styles.placeholder}>—</span>
          )}
        </>
      )}

      <div className={styles.cardFooter}>
        {task.notionUrl && (
          <a
            href={task.notionUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.notionLink}
            onClick={(e) => e.stopPropagation()}
          >
            {getTaskSourceLinkLabel(project?.taskSource ?? 'notion')}
          </a>
        )}
        {task.totalTokens.input + task.totalTokens.output > 0 && (
          <span className={styles.tokenBadge}>
            {formatTokenCount(task.totalTokens.input + task.totalTokens.output)}{' '}
            tokens
          </span>
        )}
        {needsRepo && (
          <span
            className={styles.needsRepoBadge}
            title="Assign a target repository"
          >
            ⚠ Needs repo
          </span>
        )}
        {isNonCode ? (
          <span className={styles.taskTypeLabel}>{task.taskType}</span>
        ) : (
          task.recoveryDescriptor?.available && (
            <button
              className={styles.unblockButton}
              disabled={recoveryInFlight}
              onClick={(e) => void handleRecover(e)}
              title={task.recoveryDescriptor.label}
              aria-label={`${task.recoveryDescriptor.label} ${task.taskName}`}
            >
              ↩ {task.recoveryDescriptor.label}
            </button>
          )
        )}
        {project?.id && (
          <button
            className={styles.moveButton}
            onClick={(e) => {
              e.stopPropagation();
              setShowMoveDialog(true);
            }}
            title="Move to another milestone"
            aria-label={`Move ${task.taskName} to another milestone`}
          >
            ↗ Move
          </button>
        )}
      </div>
      {showMoveDialog && project?.id && (
        <TaskMoveDialog
          task={task}
          projectId={project.id}
          currentBoardId={boardId}
          onClose={() => setShowMoveDialog(false)}
          onStaged={(intent) => {
            onMoveStaged?.(intent);
            setShowMoveDialog(false);
          }}
        />
      )}
    </div>
  );
}
