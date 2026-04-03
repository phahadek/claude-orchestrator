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
  mergeState: string | null;
}

export interface PRCardProps {
  pr: PRListItem;
  onReview: (prNumber: number) => void;
  onMerge: (prNumber: number) => void;
  onRemove: (prNumber: number) => void;
  onViewSession?: (sessionId: string) => void;
  onReReview: (prNumber: number) => void;
  onApprove: (prNumber: number) => void;
  reviewInFlight: boolean;
  mergeInFlight: boolean;
  removeInFlight: boolean;
  reReviewInFlight: boolean;
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
  onApprove,
  reviewInFlight,
  mergeInFlight,
  removeInFlight,
  reReviewInFlight,
  approveInFlight,
  reviewElapsed,
  error,
}: PRCardProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);

  const isFinished = pr.state === 'merged' || pr.state === 'closed';
  const verdict = pr.reviewResult?.verdict ?? null;
  const hasConflicts = !isFinished && pr.mergeState === 'dirty';
  const canMerge = pr.state === 'open' && verdict === 'approved' && !hasConflicts;
  const sessionAlive = pr.sessionId !== null;
  // Single context-aware review action:
  // - finished → no button
  // - has conflicts (dirty) → "Re-review" to resolve conflicts (regardless of verdict)
  // - approved (no conflicts) → no button
  // - needs_changes/incomplete + session alive → "Re-review" (sends findings + queues re-review)
  // - everything else (no review yet, or session dead) → "Run Review"
  const reviewAction: 'run-review' | 're-review' | null =
    isFinished
      ? null
      : hasConflicts
        ? 're-review'
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
          <span className={styles.conflictBadge} title="PR has merge conflicts">⚠ Merge Conflicts</span>
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
            disabled={!canMerge || mergeInFlight}
            onClick={handleMerge}
          >
            {mergeInFlight ? 'Merging...' : 'Merge ↓'}
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
