import { useState } from 'react';
import styles from './PRCard.module.css';

export interface PRReviewDimension {
  name: string;
  passed: boolean;
  notes: string;
}

export interface PRReviewResult {
  verdict: 'approved' | 'needs_changes' | 'incomplete';
  dimensions: PRReviewDimension[];
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
  reviewResult: PRReviewResult | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PRCardProps {
  pr: PRListItem;
  onReview: (prNumber: number) => void;
  onMerge: (prNumber: number) => void;
  onFix: (prNumber: number) => void;
  reviewInFlight: boolean;
  mergeInFlight: boolean;
  fixInFlight: boolean;
  reviewElapsed: number;
  error: string | null;
}

const VERDICT_LABELS: Record<string, string> = {
  approved: '✅ Approved',
  needs_changes: '⚠️ Needs Changes',
  incomplete: '❌ Incomplete',
};

export function PRCard({
  pr,
  onReview,
  onMerge,
  onFix,
  reviewInFlight,
  mergeInFlight,
  fixInFlight,
  reviewElapsed,
  error,
}: PRCardProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);

  const isFinished = pr.state === 'merged' || pr.state === 'closed';
  const verdict = pr.reviewResult?.verdict ?? null;
  const canMerge = pr.state === 'open' && verdict === 'approved';
  const showFixButton = !isFinished && (verdict === 'needs_changes' || verdict === 'incomplete');

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
      </div>

      <div className={styles.cardActions}>
        <span className={`${styles.verdictBadge} ${verdictClass}`}>{verdictLabel}</span>

        <div className={styles.buttons}>
          {!isFinished && (
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

          {showFixButton && (
            <button
              type="button"
              className={styles.fixButton}
              disabled={fixInFlight}
              onClick={() => onFix(pr.prNumber)}
            >
              {fixInFlight ? 'Sending...' : '🔁 Send to Session'}
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
              {pr.reviewResult.dimensions.map((dim) => (
                <div key={dim.name} className={styles.dimension}>
                  <span className={styles.dimIcon}>{dim.passed ? '✅' : '⚠️'}</span>
                  <span className={styles.dimName}>{dim.name}</span>
                  <span className={styles.dimNotes}>{dim.notes}</span>
                </div>
              ))}
              <div className={styles.reviewSummary}>{pr.reviewResult.summary}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
