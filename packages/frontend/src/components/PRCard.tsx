import { useState } from 'react';
import styles from './PRCard.module.css';

export interface PRReviewDimension {
  name: string;
  passed: boolean;
  notes: string;
}

export interface PRReviewResult {
  verdict: 'approved' | 'needs_changes' | 'incomplete' | 'error';
  dimensions?: PRReviewDimension[];
  summary: string;
}

export interface PRListItem {
  prNumber: number;
  prUrl: string;
  title: string;
  headBranch: string;
  baseBranch: string;
  state: string;
  notionTaskId: string | null;
  notionTaskTitle: string | null;
  sessionId: string | null;
  reviewSessionId: string | null;
  repo: string;
  reviewResult: PRReviewResult | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
  reviewIteration?: number;
  /**
   * Categorized non-mergeability reason from the backend. One of:
   * 'clean' | 'dirty' | 'ci_failed' | 'blocked' | 'unstable' | 'unknown' | null
   */
  mergeState: string | null;
  /** Names of failing required check-runs. Populated when mergeState is 'ci_failed'. */
  failingChecks?: string[] | null;
}

export interface PRCardProps {
  pr: PRListItem;
  onReview: (prNumber: number) => void;
  onMerge: (prNumber: number) => void;
  onRemove: (prNumber: number) => void;
  onViewSession?: (sessionId: string) => void;
  onReReview: (prNumber: number) => void;
  onFixConflicts: (prNumber: number) => void;
  onApprove: (prNumber: number) => void;
  reviewInFlight: boolean;
  mergeInFlight: boolean;
  /** True while the frontend is asking the backend for a fresh mergeability check
   *  right before opening a merge. Drives the "Checking mergeability..." label. */
  checkingMergeability?: boolean;
  removeInFlight: boolean;
  reReviewInFlight: boolean;
  fixConflictsInFlight: boolean;
  approveInFlight: boolean;
  reviewElapsed: number;
  error: string | null;
}

const VERDICT_LABELS: Record<string, string> = {
  approved: '✅ Approved',
  needs_changes: '⚠️ Needs Changes',
  incomplete: '❌ Incomplete',
  error: '⚠️ Review Error',
};

export function PRCard({
  pr,
  onReview,
  onMerge,
  onRemove,
  onViewSession,
  onReReview,
  onFixConflicts,
  onApprove,
  reviewInFlight,
  mergeInFlight,
  checkingMergeability = false,
  removeInFlight,
  reReviewInFlight,
  fixConflictsInFlight,
  approveInFlight,
  reviewElapsed,
  error,
}: PRCardProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);

  const isFinished = pr.state === 'merged' || pr.state === 'closed';
  const verdict = pr.reviewResult?.verdict ?? null;
  const hasConflicts = !isFinished && pr.mergeState === 'dirty';
  const hasCiFailures = !isFinished && pr.mergeState === 'ci_failed';
  const isBlocked = !isFinished && pr.mergeState === 'blocked';
  const isUnstable = !isFinished && pr.mergeState === 'unstable';
  const isUnknownMergeState = !isFinished && pr.mergeState === 'unknown';
  // Block merge for any non-clean merge_state value (null is treated as "not
  // yet checked" and falls through to the backend's pre-merge check).
  const mergeBlocked = hasConflicts || hasCiFailures || isBlocked || isUnstable || isUnknownMergeState;
  const canMerge = pr.state === 'open' && verdict === 'approved' && !mergeBlocked;
  const failingChecks = pr.failingChecks ?? [];
  const sessionAlive = pr.sessionId !== null;
  // Single context-aware review action:
  // - finished → no button
  // - has conflicts (dirty) → "Fix Conflicts" to message code session with rebase instructions
  // - approved (no conflicts) → no button
  // - needs_changes/incomplete + session alive → "Re-review" (sends findings + queues re-review)
  // - everything else (no review yet, or session dead) → "Run Review"
  const reviewAction: 'run-review' | 're-review' | 'fix-conflicts' | null =
    isFinished
      ? null
      : hasConflicts
        ? 'fix-conflicts'
        : verdict === 'approved'
          ? null
          : (verdict === 'needs_changes' || verdict === 'incomplete') && sessionAlive
            ? 're-review'
            : 'run-review';
  const showApproveButton = !isFinished && verdict !== 'approved' && !hasConflicts;

  const verdictClass = isFinished
    ? styles[`state-${pr.state}`]
    : verdict
      ? styles[`verdict-${verdict.replace('_', '-')}`]
      : styles['verdict-none'];
  const verdictLabel = isFinished
    ? pr.state === 'merged' ? '✓ Merged' : '✕ Closed'
    : verdict ? VERDICT_LABELS[verdict] : '— Not reviewed';

  const handleMerge = () => {
    const confirmed = window.confirm(
      `Merge PR #${pr.prNumber} '${pr.title}' into ${pr.baseBranch}? This cannot be undone.`,
    );
    if (confirmed) onMerge(pr.prNumber);
  };

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <div className={styles.titleRow}>
          <span className={styles.prNumber}>#{pr.prNumber}</span>
          <span className={styles.title}>{pr.title}</span>
          <a
            href={pr.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.externalLink}
            title="Open on GitHub"
          >
            ↗
          </a>
        </div>
        <span className={styles.branch}>
          {pr.headBranch} → {pr.baseBranch}
        </span>
        {(pr.notionTaskTitle || pr.sessionId || pr.reviewSessionId) && (
          <div className={styles.metaRow}>
            {pr.notionTaskTitle && (
              <div className={styles.notionRow}>
                <span className={styles.notionLabel}>Task:</span>
                {pr.notionTaskId ? (
                  <a
                    href={`https://notion.so/${pr.notionTaskId.replace(/-/g, '')}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.notionLink}
                  >
                    {pr.notionTaskTitle} ↗
                  </a>
                ) : (
                  <span className={styles.notionTitle}>{pr.notionTaskTitle}</span>
                )}
              </div>
            )}
            {pr.sessionId && onViewSession && (
              <button
                type="button"
                className={styles.sessionLink}
                onClick={() => onViewSession(pr.sessionId!)}
              >
                Session ⇗
              </button>
            )}
            {pr.reviewSessionId && onViewSession && (
              <button
                type="button"
                className={styles.sessionLink}
                onClick={() => onViewSession(pr.reviewSessionId!)}
              >
                Review ⇗
              </button>
            )}
          </div>
        )}
      </div>

      <div className={styles.cardActions}>
        <span className={`${styles.verdictBadge} ${verdictClass}`}>{verdictLabel}</span>
        {hasConflicts && (
          <span
            className={styles.conflictBadge}
            title={`Merge conflicts on ${pr.headBranch} — rebase onto ${pr.baseBranch} and resolve.`}
          >
            ⚠ Merge Conflicts
          </span>
        )}
        {hasCiFailures && (
          <span
            className={styles.conflictBadge}
            title={
              failingChecks.length > 0
                ? `Failing checks: ${failingChecks.join(', ')}`
                : 'CI checks are failing'
            }
          >
            ⚠ CI failing{failingChecks.length > 0 ? `: ${failingChecks.join(', ')}` : ''}
          </span>
        )}
        {isUnstable && (
          <span className={styles.conflictBadge} title="CI is unstable — checks may be failing">
            ⚠ CI unstable
          </span>
        )}
        {isBlocked && (
          <span
            className={styles.conflictBadge}
            title="Blocked by branch protection — a required review or status is missing."
          >
            ⚠ Blocked by branch protection
          </span>
        )}
        {isUnknownMergeState && (
          <span className={styles.conflictBadge} title="GitHub has not yet computed mergeability">
            ⚠ Mergeability unknown
          </span>
        )}

        <div className={styles.buttons}>
          <button
            type="button"
            className={styles.removeButton}
            disabled={removeInFlight}
            onClick={() => onRemove(pr.prNumber)}
            title="Remove from list"
          >
            {removeInFlight ? '…' : '✕'}
          </button>

          {reviewAction === 'run-review' && (
            <button
              type="button"
              className={styles.reviewButton}
              disabled={reviewInFlight}
              onClick={() => onReview(pr.prNumber)}
            >
              {reviewInFlight
                ? `Reviewing...${reviewElapsed > 0 ? ` (${reviewElapsed}s)` : ''}`
                : 'Run Review'}
            </button>
          )}

          {reviewAction === 're-review' && (
            <button
              type="button"
              className={styles.reReviewButton}
              disabled={reReviewInFlight}
              onClick={() => onReReview(pr.prNumber)}
              title="Send findings to session and queue re-review after next push"
            >
              {reReviewInFlight ? 'Reviewing...' : '↺ Re-review'}
            </button>
          )}

          {reviewAction === 'fix-conflicts' && (
            <button
              type="button"
              className={styles.fixButton}
              disabled={fixConflictsInFlight}
              onClick={() => onFixConflicts(pr.prNumber)}
              title="Send rebase instructions to the code session to resolve merge conflicts"
            >
              {fixConflictsInFlight ? 'Fixing...' : '↺ Fix Conflicts'}
            </button>
          )}

          {showApproveButton && (
            <button
              type="button"
              className={styles.approveButton}
              disabled={approveInFlight}
              onClick={() => onApprove(pr.prNumber)}
              title="Manually approve this PR"
            >
              {approveInFlight ? 'Approving...' : '✓ Approve'}
            </button>
          )}

          <button
            type="button"
            className={styles.mergeButton}
            disabled={!canMerge || mergeInFlight || checkingMergeability}
            onClick={handleMerge}
          >
            {checkingMergeability
              ? 'Checking mergeability...'
              : mergeInFlight
                ? 'Merging...'
                : 'Merge ↓'}
          </button>
        </div>
      </div>

      {error && <div className={styles.inlineError}>{error}</div>}

      {pr.reviewResult && (
        <div className={styles.reviewDetails}>
          <button
            type="button"
            className={styles.detailsToggle}
            onClick={() => setDetailsOpen((o) => !o)}
          >
            {detailsOpen ? '▼' : '▶'} Review details
          </button>
          {detailsOpen && (
            <div className={styles.detailsBody}>
              {pr.reviewResult.verdict === 'error' ? (
                <div className={styles.reviewError}>Review failed: {pr.reviewResult.summary}</div>
              ) : (
                <>
                  {(pr.reviewResult.dimensions ?? []).map((dim) => (
                    <div key={dim.name} className={styles.dimension}>
                      <span className={styles.dimIcon}>{dim.passed ? '✅' : '⚠️'}</span>
                      <span className={styles.dimName}>{dim.name}</span>
                      <span className={styles.dimNotes}>{dim.notes}</span>
                    </div>
                  ))}
                  <div className={styles.reviewSummary}>{pr.reviewResult.summary}</div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
