import { useState } from 'react';
import type { TaskView, DisplayStatus, PauseReason } from '../types/taskView';
import type { ClientMessage } from '@claude-orchestrator/backend/src/ws/types';
import type { ProjectConfig } from '@claude-orchestrator/backend/src/config';
import { parsePauseReason } from '@claude-orchestrator/backend/src/db/pauseReason';
import { useDispatch } from '../hooks/useDispatch';
import { formatTokenCount } from '@claude-orchestrator/backend/src/utils/usage';
import { CIBadges, PipelineStageBadge } from './CIBadges';
import { ContextBadge } from './ContextBadge';
import { getTaskSourceLinkLabel } from '../utils/taskSourceLabel';
import styles from './TaskCard.module.css';

interface Props {
  task: TaskView;
  selected: boolean;
  onClick: () => void;
  send: (msg: ClientMessage) => void;
  project: ProjectConfig | null;
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
};

function verdictLabel(verdict: string): string {
  if (verdict === 'approved') return '✅ Approved';
  if (verdict === 'needs_changes') return '🔁 Needs changes';
  if (verdict === 'incomplete') return '❌ Incomplete';
  return verdict;
}

function launchTooltip(task: TaskView): string {
  if (task.notionStatus !== '🗂️ Ready') return 'Task is not Ready';
  if (!task.taskType.includes('💻')) return 'Non-code task';
  if (task.blocked) return `Blocked by ${task.blockerNames.join(', ')}`;
  return '';
}

export function TaskCard({ task, selected, onClick, send, project }: Props) {
  const { codeSession, pr, review } = task;
  const [unblockInFlight, setUnblockInFlight] = useState(false);
  const [optimisticStatus, setOptimisticStatus] =
    useState<DisplayStatus | null>(null);
  const effectiveDisplayStatus = optimisticStatus ?? task.displayStatus;
  const statusKey = effectiveDisplayStatus.replace(/_/g, '-') as string;

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
  const dispatchTask = useDispatch(send, project);
  const isNonCode = !task.taskType.includes('💻');
  const pauseStruct = parsePauseReason(task.pauseReason);

  // Only Ready code tasks that aren't blocked can be launched.
  // In Progress and In Review tasks already have an active session — launching
  // another would create a duplicate.
  const isLaunchable =
    task.notionStatus === '🗂️ Ready' && !isNonCode && !task.blocked;

  const tooltip = isLaunchable ? '' : launchTooltip(task);

  const handleLaunch = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isLaunchable) return;
    dispatchTask([
      {
        notionUrl: task.notionUrl,
        taskType: task.taskType,
        taskName: task.taskName,
      },
    ]);
  };

  const handleUnblock = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (unblockInFlight || !project?.id) return;
    setUnblockInFlight(true);
    setOptimisticStatus('ready');
    try {
      await fetch(
        `/api/tasks/${encodeURIComponent(task.taskId)}/unblock?projectId=${encodeURIComponent(project.id)}`,
        { method: 'POST' },
      );
    } catch {
      setOptimisticStatus(null);
    } finally {
      setUnblockInFlight(false);
    }
  };

  return (
    <div
      className={`${styles.card} ${selected ? styles.selected : ''} ${isNonCode ? styles.nonCode : ''}`}
      onClick={onClick}
      data-status={effectiveDisplayStatus}
    >
      <div className={styles.header}>
        <span className={styles.taskName}>{task.taskName}</span>
        <span
          className={`${styles.statusBadge} ${styles[`status-${statusKey}`] ?? ''}`}
          title={
            pauseStruct
              ? `[${pauseStruct.source}] ${PAUSE_REASON_LABELS[pauseStruct.reason] ?? pauseStruct.reason}`
              : undefined
          }
          data-pause-severity={pauseStruct?.severity}
          data-pause-source={pauseStruct?.source}
        >
          {STATUS_LABELS[effectiveDisplayStatus]}
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
        {isNonCode ? (
          <span className={styles.taskTypeLabel}>{task.taskType}</span>
        ) : (
          <>
            {effectiveDisplayStatus === 'blocked' && (
              <button
                className={styles.unblockButton}
                disabled={unblockInFlight}
                onClick={(e) => void handleUnblock(e)}
                title="Clear block and set to Ready"
                aria-label={`Unblock ${task.taskName}`}
              >
                ↩ Unblock
              </button>
            )}
            <button
              className={styles.launchButton}
              disabled={!isLaunchable}
              onClick={handleLaunch}
              title={tooltip || 'Launch session'}
              aria-label={
                isLaunchable ? `Launch session for ${task.taskName}` : tooltip
              }
            >
              🚀
            </button>
          </>
        )}
      </div>
    </div>
  );
}
