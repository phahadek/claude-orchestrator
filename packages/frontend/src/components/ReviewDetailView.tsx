import type { SessionState } from '../hooks/useSessionStore';
import {
  type ReviewResult,
  parseReviewResultFromEvents,
} from './ReviewDetailView.helpers';
import styles from './ReviewDetailView.module.css';

// ── Verdict helpers ───────────────────────────────────────────────

const VERDICT_LABELS: Record<ReviewResult['verdict'], string> = {
  approved: 'Approved',
  needs_changes: 'Needs Changes',
  incomplete: 'Incomplete',
  error: 'Error',
  pass: 'Pass',
  fail: 'Fail',
};

const VERDICT_ICONS: Record<ReviewResult['verdict'], string> = {
  approved: '✓',
  needs_changes: '⚠',
  incomplete: '✕',
  error: '✕',
  pass: '✓',
  fail: '✕',
};

const VERDICT_STYLE_KEYS: Record<ReviewResult['verdict'], string> = {
  approved: 'verdict--approved',
  needs_changes: 'verdict--needs-changes',
  incomplete: 'verdict--incomplete',
  error: 'verdict--error',
  pass: 'verdict--approved',
  fail: 'verdict--needs-changes',
};

// ── Component ─────────────────────────────────────────────────────

/** Escalated/routed disposition for a depth_review session, matched back to it by session id — not part of the session's own emitted JSON (see ReviewOrchestrator.dispatchDepthReview). */
export interface DepthReviewStatus {
  escalated: boolean;
  routeCount: number;
}

interface Props {
  session: SessionState;
  depthReviewStatus?: DepthReviewStatus | null;
}

export function ReviewDetailView({ session, depthReviewStatus = null }: Props) {
  const result = parseReviewResultFromEvents(session.events);
  const isActive =
    session.status === 'running' || session.status === 'needs_permission';

  return (
    <div className={styles.reviewBody}>
      {/* ── Verdict + dimensions + summary ── */}
      <div className={styles.verdictSection}>
        {result ? (
          <>
            <div
              className={`${styles.verdictBadge} ${styles[VERDICT_STYLE_KEYS[result.verdict]]}`}
            >
              <span className={styles.verdictIcon}>
                {VERDICT_ICONS[result.verdict]}
              </span>
              {VERDICT_LABELS[result.verdict]}
            </div>

            {depthReviewStatus && (
              <div
                className={
                  depthReviewStatus.escalated
                    ? styles.depthStatusBadgeEscalated
                    : styles.depthStatusBadgeRouted
                }
                data-testid="depth-review-status"
              >
                {depthReviewStatus.escalated
                  ? 'Escalated to operator'
                  : `Routed to session${depthReviewStatus.routeCount > 0 ? ` (×${depthReviewStatus.routeCount})` : ''}`}
              </div>
            )}

            {result.verdict !== 'error' && result.dimensions.length > 0 && (
              <div className={styles.dimensions}>
                {result.dimensions.map((dim, i) => (
                  <div key={i} className={styles.dimension}>
                    <span
                      className={`${styles.dimIcon} ${dim.passed ? styles['dimIcon--pass'] : styles['dimIcon--fail']}`}
                    >
                      {dim.passed ? '✓' : '✕'}
                    </span>
                    <div className={styles.dimContent}>
                      <span className={styles.dimName}>{dim.name}</span>
                      {dim.notes && (
                        <span className={styles.dimNotes}>{dim.notes}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {result.summary && (
              <p
                className={`${styles.summary} ${result.verdict === 'error' ? styles['summary--error'] : ''}`}
              >
                {result.summary}
              </p>
            )}
            {result.errorDetail && (
              <pre className={styles.errorDetail}>{result.errorDetail}</pre>
            )}
          </>
        ) : isActive ? (
          <>
            <div
              className={`${styles.verdictBadge} ${styles['verdict--pending']}`}
            >
              Review in progress…
            </div>
            <p className={styles.pendingHint}>
              Verdict will appear here when the review session completes.
            </p>
          </>
        ) : (
          <>
            <div
              className={`${styles.verdictBadge} ${styles['verdict--pending']}`}
            >
              No result
            </div>
            <p className={styles.pendingHint}>
              No review verdict was found in this session's output.
            </p>
          </>
        )}
      </div>

      {/* ── Links: PR + code session ── */}
      {(session.prUrl || session.codeSessionId) && (
        <div className={styles.links}>
          {session.prUrl && (
            <a
              href={session.prUrl}
              target="_blank"
              rel="noreferrer"
              className={styles.prLink}
            >
              View PR{session.prNumber ? ` #${session.prNumber}` : ''} on GitHub
              ↗
            </a>
          )}
          {session.codeSessionId && (
            <button
              type="button"
              className={styles.codeSessionLink}
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent('selectSession', {
                    detail: { sessionId: session.codeSessionId },
                  }),
                )
              }
            >
              View code session ↗
            </button>
          )}
        </div>
      )}
    </div>
  );
}
