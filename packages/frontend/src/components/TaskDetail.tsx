import { useState, useRef, useEffect } from 'react';
import type { ClientMessage } from '@claude-dashboard/backend/src/ws/types';
import type { TaskView } from '@claude-dashboard/backend/src/routes/tasks';
import type { DisplayStatus } from '@claude-dashboard/backend/src/tasks/TaskStatusEngine';
import type { SessionState } from '../hooks/useSessionStore';
import { formatDuration } from '../utils/sessionTimer';
import { formatTokenCount } from '@claude-dashboard/backend/src/utils/usage';
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
};

const DISPLAY_STATUS_CSS_KEYS: Record<DisplayStatus, string> = {
  ready:          'status--ready',
  in_progress:    'status--in-progress',
  in_review:      'status--in-review',
  needs_attention:'status--needs-attention',
  ready_to_merge: 'status--ready-to-merge',
  done:           'status--done',
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

// ── Elapsed time for code session ─────────────────────────────────

function calcSessionElapsedMs(codeSession: NonNullable<TaskView['codeSession']>): number | null {
  const start = codeSession.startedAt;
  if (!start) return null;
  const end = codeSession.endedAt ?? Date.now();
  return end - start;
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
  const [showCodeTranscript, setShowCodeTranscript] = useState(false);
  const [showReviewDimensions, setShowReviewDimensions] = useState(false);
  const [showReviewTranscript, setShowReviewTranscript] = useState(false);
  const [reviewInFlight, setReviewInFlight] = useState(false);
  const [mergeInFlight, setMergeInFlight] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  // Reset transcript toggles when task changes
  useEffect(() => {
    setShowCodeTranscript(false);
    setShowReviewDimensions(false);
    setShowReviewTranscript(false);
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

  const codeElapsedMs = task.codeSession ? calcSessionElapsedMs(task.codeSession) : null;
  const totalTokens = task.codeSession
    ? (task.codeSession.inputTokens ?? 0) + (task.codeSession.outputTokens ?? 0)
    : 0;

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
        {/* ── Code Session section ── */}
        {task.codeSession && (
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionTitle}>Code Session</span>
              <StatusBadge status={task.codeSession.status} />
              {codeElapsedMs != null && (
                <span className={styles.elapsed}>{formatDuration(codeElapsedMs)}</span>
              )}
              {totalTokens > 0 && (
                <span className={styles.tokenCount}>
                  {formatTokenCount(totalTokens)} tokens
                </span>
              )}
            </div>

            {task.codeSession.lastMessage && (
              <p className={styles.lastMessage}>{task.codeSession.lastMessage}</p>
            )}

            {isCodeActive && (
              <InlineComposer sessionId={task.codeSession.sessionId} send={send} />
            )}

            <button
              className={styles.toggleButton}
              onClick={() => setShowCodeTranscript((v) => !v)}
              aria-expanded={showCodeTranscript}
            >
              {showCodeTranscript ? '▼ Hide transcript' : '▶ View full transcript'}
            </button>

            {showCodeTranscript && codeSession && (
              <div className={styles.transcriptWrapper}>
                <EventTranscript
                  events={codeSession.events}
                  permissionDenials={codeSession.permissionDenials}
                />
              </div>
            )}
            {showCodeTranscript && !codeSession && (
              <p className={styles.noTranscript}>Transcript not available — session not loaded.</p>
            )}
          </div>
        )}

        {/* ── Pull Request section ── */}
        {task.pr && (
          <div className={styles.section}>
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

        {/* ── Review section ── */}
        {task.review && (
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionTitle}>Review</span>
              {task.review.iterationCount > 0 && (
                <span className={styles.iterationCount}>
                  Review #{task.review.iterationCount}
                </span>
              )}
            </div>

            {task.review.verdict ? (
              <div
                className={`${styles.verdictBadge} ${styles[VERDICT_CSS_KEYS[task.review.verdict] ?? 'verdict--error']}`}
              >
                {VERDICT_LABELS[task.review.verdict] ?? task.review.verdict}
              </div>
            ) : task.review.status === 'running' || task.review.status === 'starting' ? (
              <div className={`${styles.verdictBadge} ${styles['verdict--pending']}`}>
                Review in progress…
              </div>
            ) : (
              <div className={`${styles.verdictBadge} ${styles['verdict--pending']}`}>
                No verdict yet
              </div>
            )}

            {task.review.summary && (
              <p className={styles.reviewSummary}>{task.review.summary}</p>
            )}

            {reviewSession && (
              <>
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

                <button
                  className={styles.toggleButton}
                  onClick={() => setShowReviewTranscript((v) => !v)}
                  aria-expanded={showReviewTranscript}
                >
                  {showReviewTranscript ? '▼ Hide review transcript' : '▶ View review transcript'}
                </button>
                {showReviewTranscript && (
                  <div className={styles.transcriptWrapper}>
                    <EventTranscript events={reviewSession.events} />
                  </div>
                )}
              </>
            )}
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
