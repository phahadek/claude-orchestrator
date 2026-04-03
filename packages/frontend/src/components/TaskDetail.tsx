import { useState, useRef, useEffect } from 'react';
import type { ClientMessage } from '@claude-dashboard/backend/src/ws/types';
import type { TaskView } from '@claude-dashboard/backend/src/routes/tasks';
import type { DisplayStatus } from '@claude-dashboard/backend/src/tasks/TaskStatusEngine';
import type { SessionState } from '../hooks/useSessionStore';
import { StatusBadge } from './StatusBadge';
import { EventTranscript } from './EventTranscript';
import { parseReviewResultFromEvents } from './ReviewDetailView';
import styles from './TaskDetail.module.css';

// ── Display status helpers ─────────────────────────────────────────

const DISPLAY_STATUS_LABELS: Record<DisplayStatus, string> = {
  ready:          '🗂️ Ready',
  in_progress:    '🔄 In Progress',
  in_review:      '🔍 In Review',
  needs_attention:'⚠️ Needs Attention',
  ready_to_merge: '✅ Ready to Merge',
  done:           '✓ Done',
  backlog:        '🗂️ Backlog',
};

const DISPLAY_STATUS_CSS_KEYS: Record<DisplayStatus, string> = {
  ready:          'status--ready',
  in_progress:    'status--in-progress',
  in_review:      'status--in-review',
  needs_attention:'status--needs-attention',
  ready_to_merge: 'status--ready-to-merge',
  done:           'status--done',
  backlog:        'status--backlog',
};

const VERDICT_LABELS: Record<string, string> = {
  approved:      '✅ Approved',
  needs_changes: '⚠️ Needs Changes',
  incomplete:    '❌ Incomplete',
  error:         '⚠️ Review Error',
};

const VERDICT_CSS_KEYS: Record<string, string> = {
  approved:      'verdict--approved',
  needs_changes: 'verdict--needs-changes',
  incomplete:    'verdict--incomplete',
  error:         'verdict--error',
};

// ── PR state helpers ───────────────────────────────────────────────

function prStateLabel(state: string, draft: boolean): string {
  if (draft) return 'Draft';
  switch (state) {
    case 'open':   return 'Open';
    case 'merged': return 'Merged';
    case 'closed': return 'Closed';
    default:       return state;
  }
}

// ── Parse owner/repo from GitHub PR URL ───────────────────────────

function parseOwnerRepo(prUrl: string): { owner: string; repo: string } | null {
  const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\//);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

// ── Inline composer ───────────────────────────────────────────────

interface ComposerProps {
  sessionId: string;
  send: (msg: ClientMessage) => void;
}

function InlineComposer({ sessionId, send }: ComposerProps) {
  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function handleSend() {
    if (!draft.trim()) return;
    send({ type: 'send_message', sessionId, message: draft });
    setDraft('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }

  return (
    <div className={styles.composer}>
      <textarea
        ref={textareaRef}
        className={styles.composerInput}
        value={draft}
        rows={1}
        onChange={(e) => {
          setDraft(e.target.value);
          e.target.style.height = 'auto';
          e.target.style.height = `${e.target.scrollHeight}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && draft.trim()) {
            e.preventDefault();
            handleSend();
          }
        }}
        placeholder="Send a message to the session…"
      />
      <button
        className={styles.sendButton}
        onClick={handleSend}
        disabled={!draft.trim()}
      >
        Send
      </button>
    </div>
  );
}

// ── Props ─────────────────────────────────────────────────────────

interface Props {
  task: TaskView;
  send: (msg: ClientMessage) => void;
  onClose: () => void;
  sessions?: SessionState[];
}

// ── TaskDetail ────────────────────────────────────────────────────

export function TaskDetail({ task, send, onClose, sessions = [] }: Props) {
  const [showReviewSection, setShowReviewSection] = useState(true);
  const [showReviewDimensions, setShowReviewDimensions] = useState(false);
  const [reviewInFlight, setReviewInFlight] = useState(false);
  const [mergeInFlight, setMergeInFlight] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  // Reset state when task changes
  useEffect(() => {
    setShowReviewSection(true);
    setShowReviewDimensions(false);
    setReviewError(null);
  }, [task.taskId]);

  // Look up live session state for event transcripts
  const codeSession = task.codeSession
    ? sessions.find((s) => s.sessionId === task.codeSession!.sessionId) ?? null
    : null;
  const reviewSession = task.review
    ? sessions.find((s) => s.sessionId === task.review!.sessionId) ?? null
    : null;

  const isCodeActive =
    task.codeSession?.status === 'running' || task.codeSession?.status === 'needs_permission';

  const displayStatusLabel = DISPLAY_STATUS_LABELS[task.displayStatus] ?? task.displayStatus;
  const displayStatusClass = DISPLAY_STATUS_CSS_KEYS[task.displayStatus] ?? '';

  async function handleRunReview() {
    if (!task.pr) return;
    setReviewInFlight(true);
    setReviewError(null);
    try {
      const res = await fetch(`/api/prs/${task.pr.prNumber}/review`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setReviewError(body.error ?? `HTTP ${res.status}`);
      }
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setReviewInFlight(false);
    }
  }

  async function handleMerge() {
    if (!task.pr) return;
    if (!confirm(`Merge PR #${task.pr.prNumber} '${task.pr.title}' into ${task.pr.baseBranch}? This cannot be undone.`)) return;
    setMergeInFlight(true);
    setReviewError(null);
    try {
      const ownerRepo = parseOwnerRepo(task.pr.prUrl);
      if (!ownerRepo) {
        setReviewError('Could not parse owner/repo from PR URL.');
        return;
      }
      const res = await fetch(`/api/prs/${ownerRepo.owner}/${ownerRepo.repo}/${task.pr.prNumber}/merge`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setReviewError(body.error ?? `HTTP ${res.status}`);
      }
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setMergeInFlight(false);
    }
  }

  return (
    <div className={styles.panel}>
      {/* ── Header ── */}
      <div className={styles.header}>
        <div className={styles.headerTop}>
          <span className={styles.taskName}>{task.taskName}</span>
          <button className={styles.closeButton} onClick={onClose} aria-label="Close panel">
            ✕
          </button>
        </div>
        <div className={styles.headerMeta}>
          <span className={`${styles.displayStatusBadge} ${styles[displayStatusClass]}`}>
            {displayStatusLabel}
          </span>
          {task.priority && (
            <span className={styles.priorityBadge}>{task.priority}</span>
          )}
          {task.notionUrl && (
            <a
              href={task.notionUrl}
              target="_blank"
              rel="noreferrer"
              className={styles.notionLink}
            >
              Notion ↗
            </a>
          )}
        </div>
      </div>

      <div className={styles.body}>
        {/* ── Code Session — full transcript, takes bulk of panel ── */}
        {task.codeSession && (
          <div className={styles.codeSection}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionTitle}>Code Session</span>
              <StatusBadge status={task.codeSession.status} />
            </div>
            <div className={styles.transcriptArea}>
              {codeSession ? (
                <EventTranscript
                  events={codeSession.events}
                  permissionDenials={codeSession.permissionDenials}
                />
              ) : (
                <p className={styles.noTranscript}>Transcript not available — session not loaded.</p>
              )}
            </div>
            {isCodeActive && (
              <InlineComposer sessionId={task.codeSession.sessionId} send={send} />
            )}
          </div>
        )}

        {/* ── Review session — collapsible transcript ── */}
        {task.review && (
          <div className={styles.reviewSection}>
            <div
              className={styles.reviewSectionHeader}
              onClick={() => setShowReviewSection((v) => !v)}
              role="button"
              aria-expanded={showReviewSection}
            >
              <span className={styles.reviewToggleIcon} aria-hidden="true">
                {showReviewSection ? '▼' : '▶'}
              </span>
              <span className={styles.sectionTitle}>Review</span>
              {task.review.iterationCount > 0 && (
                <span className={styles.iterationCount}>
                  #{task.review.iterationCount}
                </span>
              )}
              {task.review.verdict ? (
                <span className={`${styles.verdictPill} ${styles[VERDICT_CSS_KEYS[task.review.verdict] ?? 'verdict--error']}`}>
                  {VERDICT_LABELS[task.review.verdict] ?? task.review.verdict}
                </span>
              ) : (task.review.status === 'running' || task.review.status === 'starting') ? (
                <span className={`${styles.verdictPill} ${styles['verdict--pending']}`}>
                  In progress…
                </span>
              ) : null}
            </div>

            {showReviewSection && (
              <div className={styles.reviewBody}>
                {reviewSession ? (
                  <>
                    <div className={styles.reviewTranscriptArea}>
                      <EventTranscript events={reviewSession.events} />
                    </div>
                    <button
                      className={styles.toggleButton}
                      onClick={() => setShowReviewDimensions((v) => !v)}
                      aria-expanded={showReviewDimensions}
                    >
                      {showReviewDimensions ? '▼ Hide dimensions' : '▶ Show dimensions'}
                    </button>
                    {showReviewDimensions && (
                      <ReviewDimensions session={reviewSession} />
                    )}
                  </>
                ) : (
                  <p className={styles.noTranscript}>Review transcript not available.</p>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Pull Request — compact metadata + action buttons ── */}
        {task.pr && (
          <div className={styles.prSection}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionTitle}>Pull Request</span>
            </div>

            <div className={styles.prTitle}>
              <span className={styles.prNumber}>#{task.pr.prNumber}</span>
              <span className={styles.prTitleText}>{task.pr.title}</span>
            </div>
            <div className={styles.prBranch}>
              {task.pr.headBranch} → {task.pr.baseBranch}
            </div>
            <div className={styles.prMeta}>
              <span className={`${styles.prStateBadge} ${styles[`prState--${task.pr.state}${task.pr.draft ? '-draft' : ''}`]}`}>
                {prStateLabel(task.pr.state, task.pr.draft)}
              </span>
            </div>

            {reviewError && (
              <div className={styles.errorBanner}>{reviewError}</div>
            )}

            <div className={styles.prActions}>
              {task.pr.state === 'open' && (
                <button
                  className={styles.reviewButton}
                  disabled={reviewInFlight}
                  onClick={() => void handleRunReview()}
                >
                  {reviewInFlight ? 'Reviewing…' : 'Run Review'}
                </button>
              )}
              {task.pr.state === 'open' && task.review?.verdict === 'approved' && (
                <button
                  className={styles.mergeButton}
                  disabled={mergeInFlight}
                  onClick={() => void handleMerge()}
                >
                  {mergeInFlight ? 'Merging…' : 'Merge ↓'}
                </button>
              )}
              <a
                href={task.pr.prUrl}
                target="_blank"
                rel="noreferrer"
                className={styles.githubLink}
              >
                GitHub ↗
              </a>
            </div>
          </div>
        )}

        {/* Empty state */}
        {!task.codeSession && !task.pr && !task.review && (
          <div className={styles.emptyState}>
            <p>No active sessions or PRs for this task.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── ReviewDimensions ──────────────────────────────────────────────

function ReviewDimensions({ session }: { session: SessionState }) {
  const result = parseReviewResultFromEvents(session.events);
  if (!result || result.dimensions.length === 0) return null;

  return (
    <div className={styles.dimensions}>
      {result.dimensions.map((dim, i) => (
        <div key={i} className={styles.dimension}>
          <span className={`${styles.dimIcon} ${dim.passed ? styles['dimIcon--pass'] : styles['dimIcon--fail']}`}>
            {dim.passed ? '✓' : '✕'}
          </span>
          <div className={styles.dimContent}>
            <span className={styles.dimName}>{dim.name}</span>
            {dim.notes && <span className={styles.dimNotes}>{dim.notes}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
