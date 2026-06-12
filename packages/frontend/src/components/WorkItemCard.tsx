import { useState } from 'react';
import styles from './WorkItemCard.module.css';
import { CIBadges } from './CIBadges';

export interface PRReviewDimension {
  name: string;
  passed: boolean;
  notes: string;
}

export interface PRReviewResult {
  verdict: 'approved' | 'needs_changes' | 'incomplete' | 'error';
  dimensions?: PRReviewDimension[];
  summary: string;
  errorDetail?: string;
}

// ── PR work item (GitHub pull request) ────────────────────────────

export interface PRWorkItem {
  type: 'pr';
  prNumber: number;
  prUrl: string;
  title: string;
  headBranch: string;
  branchName: string;
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
  failingChecks?: string[] | null;
  pauseReason?: string | null;
  preReviewStage?: string | null;
  awaitingReReview?: boolean;
  autoMergeEnabled: boolean;
}

// ── Local branch work item (local-only project session) ────────────

export interface LocalBranchWorkItem {
  type: 'local_branch';
  sessionId: string;
  branchName: string;
  baseBranch: string;
  status: string;
  reviewResult: PRReviewResult | null;
  createdAt: string;
  autoMergeEnabled: boolean;
  notionTaskId: string | null;
  notionTaskTitle: string | null;
}

export type WorkItemListItem = PRWorkItem | LocalBranchWorkItem;

// ── Backward-compat alias used by existing tests and PRPanel ──────

/** @deprecated Use PRWorkItem or WorkItemListItem instead */
export type PRListItem = PRWorkItem;

export interface WorkItemCardProps {
  item: WorkItemListItem;
  onReview: (prNumber: number) => void;
  onMerge: (prNumber: number) => void;
  onRemove: (prNumber: number) => void;
  onViewSession?: (sessionId: string) => void;
  onReReview: (prNumber: number) => void;
  onFixConflicts: (prNumber: number) => void;
  onApprove: (prNumber: number) => void;
  reviewInFlight: boolean;
  mergeInFlight: boolean;
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

// ── Local branch card ──────────────────────────────────────────────

function LocalBranchCard({
  item,
  onViewSession,
}: {
  item: LocalBranchWorkItem;
  onViewSession?: (sessionId: string) => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const verdict = item.reviewResult?.verdict ?? null;

  const verdictClass = verdict
    ? styles[`verdict-${verdict.replace('_', '-')}`]
    : styles['verdict-none'];
  const verdictLabel = verdict ? VERDICT_LABELS[verdict] : '— Not reviewed';

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <div className={styles.titleRow}>
          <span className={styles.localBadge}>Local</span>
          <span className={styles.title}>{item.branchName}</span>
        </div>
        <span className={styles.branch}>
          {item.branchName} → {item.baseBranch}
        </span>
        {(item.notionTaskTitle || item.sessionId) && (
          <div className={styles.metaRow}>
            {item.notionTaskTitle && (
              <div className={styles.notionRow}>
                <span className={styles.notionLabel}>Task:</span>
                {item.notionTaskId ? (
                  <a
                    href={`https://notion.so/${item.notionTaskId.replace(/-/g, '')}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.notionLink}
                  >
                    {item.notionTaskTitle} ↗
                  </a>
                ) : (
                  <span className={styles.notionTitle}>
                    {item.notionTaskTitle}
                  </span>
                )}
              </div>
            )}
            {item.sessionId && onViewSession && (
              <button
                type="button"
                className={styles.sessionLink}
                onClick={() => onViewSession(item.sessionId)}
              >
                Session ⇗
              </button>
            )}
          </div>
        )}
      </div>

      <div className={styles.cardActions}>
        <span className={`${styles.verdictBadge} ${verdictClass}`}>
          {verdictLabel}
        </span>
      </div>

      {item.reviewResult && (
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
              {item.reviewResult.verdict === 'error' ? (
                <div className={styles.reviewError}>
                  Review failed: {item.reviewResult.summary}
                </div>
              ) : (
                <>
                  {(item.reviewResult.dimensions ?? []).map((dim) => (
                    <div key={dim.name} className={styles.dimension}>
                      <span className={styles.dimIcon}>
                        {dim.passed ? '✅' : '⚠️'}
                      </span>
                      <span className={styles.dimName}>{dim.name}</span>
                      <span className={styles.dimNotes}>{dim.notes}</span>
                    </div>
                  ))}
                  <div className={styles.reviewSummary}>
                    {item.reviewResult.summary}
                  </div>
                  {item.reviewResult.errorDetail && (
                    <pre className={styles.reviewErrorDetail}>
                      {item.reviewResult.errorDetail}
                    </pre>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── PR card (GitHub pull request) ─────────────────────────────────

function PRWorkItemCard({
  item: pr,
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
}: Omit<WorkItemCardProps, 'item'> & { item: PRWorkItem }) {
  const [detailsOpen, setDetailsOpen] = useState(false);

  const isFinished = pr.state === 'merged' || pr.state === 'closed';
  const verdict = pr.reviewResult?.verdict ?? null;
  const hasConflicts = !isFinished && pr.mergeState === 'dirty';
  const hasCiFailures = !isFinished && pr.mergeState === 'ci_failed';
  const isBlocked = !isFinished && pr.mergeState === 'blocked';
  const isUnstable = !isFinished && pr.mergeState === 'unstable';
  const isUnknownMergeState = !isFinished && pr.mergeState === 'unknown';
  const mergeBlocked =
    hasConflicts ||
    hasCiFailures ||
    isBlocked ||
    isUnstable ||
    isUnknownMergeState;
  const canMerge =
    pr.state === 'open' && verdict === 'approved' && !mergeBlocked;
  const failingChecks = pr.failingChecks ?? [];
  const ciChecksUrl = `https://github.com/${pr.repo}/pull/${pr.prNumber}/checks`;
  const sessionAlive = pr.sessionId !== null;
  const reviewAction: 'run-review' | 're-review' | 'fix-conflicts' | null =
    isFinished
      ? null
      : hasConflicts
        ? 'fix-conflicts'
        : verdict === 'approved'
          ? null
          : (verdict === 'needs_changes' || verdict === 'incomplete') &&
              sessionAlive
            ? 're-review'
            : 'run-review';
  const showApproveButton =
    !isFinished && verdict !== 'approved' && !hasConflicts;

  const verdictClass = isFinished
    ? styles[`state-${pr.state}`]
    : verdict
      ? styles[`verdict-${verdict.replace('_', '-')}`]
      : styles['verdict-none'];
  const verdictLabel = isFinished
    ? pr.state === 'merged'
      ? '✓ Merged'
      : '✕ Closed'
    : verdict
      ? VERDICT_LABELS[verdict]
      : '— Not reviewed';

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
                  <span className={styles.notionTitle}>
                    {pr.notionTaskTitle}
                  </span>
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
        <span className={`${styles.verdictBadge} ${verdictClass}`}>
          {verdictLabel}
        </span>
        <CIBadges
          mergeState={pr.mergeState}
          pauseReason={pr.pauseReason}
          prState={pr.state}
          ciChecksUrl={ciChecksUrl}
          failingChecks={failingChecks}
          awaitingReReview={pr.awaitingReReview ?? false}
        />
        {hasConflicts && (
          <span
            className={styles.conflictBadge}
            title={`Merge conflicts on ${pr.headBranch} — rebase onto ${pr.baseBranch} and resolve.`}
          >
            ⚠ Merge Conflicts
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
          <span
            className={styles.conflictBadge}
            title="GitHub has not yet computed mergeability"
          >
            ⚠ Mergeability unknown
          </span>
        )}
        {pr.pauseReason === 'review_failed' && (
          <span
            className={styles.conflictBadge}
            title="Re-review failed unexpectedly — check logs and trigger a manual re-review."
          >
            ⚠ Review failed
          </span>
        )}
        {pr.pauseReason === 'api_overloaded' && (
          <span
            className={styles.conflictBadge}
            title="Session paused — Anthropic API returned 529 Overloaded. Resume when the API is available."
          >
            ⚠ API Overloaded
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
                <div className={styles.reviewError}>
                  Review failed: {pr.reviewResult.summary}
                </div>
              ) : (
                <>
                  {(pr.reviewResult.dimensions ?? []).map((dim) => (
                    <div key={dim.name} className={styles.dimension}>
                      <span className={styles.dimIcon}>
                        {dim.passed ? '✅' : '⚠️'}
                      </span>
                      <span className={styles.dimName}>{dim.name}</span>
                      <span className={styles.dimNotes}>{dim.notes}</span>
                    </div>
                  ))}
                  <div className={styles.reviewSummary}>
                    {pr.reviewResult.summary}
                  </div>
                  {pr.reviewResult.errorDetail && (
                    <pre className={styles.reviewErrorDetail}>
                      {pr.reviewResult.errorDetail}
                    </pre>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Dispatcher ────────────────────────────────────────────────────

export function WorkItemCard(props: WorkItemCardProps) {
  if (props.item.type === 'local_branch') {
    return (
      <LocalBranchCard item={props.item} onViewSession={props.onViewSession} />
    );
  }
  return <PRWorkItemCard {...props} item={props.item} />;
}

// ── Backward-compat named export ──────────────────────────────────

/** @deprecated Use WorkItemCard instead */
export const PRCard = WorkItemCard;
export type PRCardProps = WorkItemCardProps;
