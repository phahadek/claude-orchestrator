import { useState, useRef, useEffect, useCallback } from 'react';
import type { ClientMessage } from '@claude-orchestrator/backend/src/ws/types';
import type { TaskView } from '@claude-orchestrator/backend/src/routes/tasks';
import type { DisplayStatus } from '@claude-orchestrator/backend/src/tasks/TaskStatusEngine';
import type { SessionState } from '../hooks/useSessionStore';
import { StatusBadge } from './StatusBadge';
import { EventTranscript } from './EventTranscript';
import { DiffViewer } from './DiffViewer';
import { SessionDetail } from './SessionDetail';
import { parseReviewResultFromEvents } from './ReviewDetailView';
import { formatTokenCount } from '@claude-orchestrator/backend/src/utils/usage';
import { sessionsApi } from '../api/projects';
import { useIsMobile } from '../hooks/useIsMobile';
import styles from './TaskDetail.module.css';

// ── Display status helpers ─────────────────────────────────────────

const DISPLAY_STATUS_LABELS: Record<DisplayStatus, string> = {
  ready: '🗂️ Ready',
  in_progress: '🔄 In Progress',
  in_review: '🔍 In Review',
  needs_attention: '⚠️ Needs Attention',
  ready_to_merge: '✅ Ready to Merge',
  done: '✓ Done',
  backlog: '🗂️ Backlog',
};

const DISPLAY_STATUS_CSS_KEYS: Record<DisplayStatus, string> = {
  ready: 'status--ready',
  in_progress: 'status--in-progress',
  in_review: 'status--in-review',
  needs_attention: 'status--needs-attention',
  ready_to_merge: 'status--ready-to-merge',
  done: 'status--done',
  backlog: 'status--backlog',
};

const VERDICT_LABELS: Record<string, string> = {
  approved: '✅ Approved',
  needs_changes: '⚠️ Needs Changes',
  incomplete: '❌ Incomplete',
  error: '⚠️ Review Error',
};

const VERDICT_CSS_KEYS: Record<string, string> = {
  approved: 'verdict--approved',
  needs_changes: 'verdict--needs-changes',
  incomplete: 'verdict--incomplete',
  error: 'verdict--error',
};

// ── PR state helpers ───────────────────────────────────────────────

function prStateLabel(state: string, draft: boolean): string {
  if (draft) return 'Draft';
  switch (state) {
    case 'open':
      return 'Open';
    case 'merged':
      return 'Merged';
    case 'closed':
      return 'Closed';
    default:
      return state;
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
  projectId?: string;
  /** When true, shows the "Mark Merged" button for local-only projects. */
  isLocalOnly?: boolean;
  /** When true, hides the "Mark Merged" button — AutoMerger handles merging. */
  autoMergeEnabled?: boolean;
  /** Whether the mobile session overlay is open (controlled by App). */
  sessionOverlayOpen?: boolean;
  /** Called when the user wants to open the mobile session overlay. */
  onOpenSessionOverlay?: () => void;
}

// ── TaskDetail ────────────────────────────────────────────────────

export function TaskDetail({
  task,
  send,
  // onClose is kept in Props for API compatibility; close button calls window.history.back() directly
  onClose: _onClose,
  sessions = [],
  projectId,
  isLocalOnly = false,
  autoMergeEnabled = false,
  sessionOverlayOpen = false,
  onOpenSessionOverlay,
}: Props) {
  const isMobile = useIsMobile();
  const [showReviewSection, setShowReviewSection] = useState(true);
  const [mobileOpenSection, setMobileOpenSection] = useState<
    'review' | 'pr' | null
  >('review');
  const [showReviewDimensions, setShowReviewDimensions] = useState(false);
  const [reviewInFlight, setReviewInFlight] = useState(false);
  const [mergeInFlight, setMergeInFlight] = useState(false);
  const [markMergedInFlight, setMarkMergedInFlight] = useState(false);
  const [fixConflictsInFlight, setFixConflictsInFlight] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [optimisticDisplayStatus, setOptimisticDisplayStatus] =
    useState<DisplayStatus | null>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'diff'>('overview');

  // Reset state when task changes
  useEffect(() => {
    setShowReviewSection(true);
    setMobileOpenSection('review');
    setShowReviewDimensions(false);
    setReviewError(null);
    setFixConflictsInFlight(false);
    setOptimisticDisplayStatus(null);
    setActiveTab('overview');
  }, [task.taskId]);

  // Look up live session state for event transcripts
  const codeSession = task.codeSession
    ? (sessions.find((s) => s.sessionId === task.codeSession!.sessionId) ??
      null)
    : null;
  const reviewSession = task.review
    ? (sessions.find((s) => s.sessionId === task.review!.sessionId) ?? null)
    : null;

  const liveStatus = codeSession?.status ?? task.codeSession?.status;
  const isCodeActive =
    liveStatus === 'running' || liveStatus === 'needs_permission';

  function handleKill() {
    if (!task.codeSession || !isCodeActive) return;
    if (confirm('Kill this session? It will have 15 seconds to wrap up.')) {
      send({ type: 'kill', sessionId: task.codeSession.sessionId });
    }
  }

  const effectiveDisplayStatus = optimisticDisplayStatus ?? task.displayStatus;
  const displayStatusLabel =
    DISPLAY_STATUS_LABELS[effectiveDisplayStatus] ?? effectiveDisplayStatus;
  const displayStatusClass =
    DISPLAY_STATUS_CSS_KEYS[effectiveDisplayStatus] ?? '';

  async function handleRunReview() {
    if (!task.pr) return;
    setReviewInFlight(true);
    setReviewError(null);
    try {
      const url = projectId
        ? `/api/prs/${task.pr.prNumber}/review?projectId=${encodeURIComponent(projectId)}`
        : `/api/prs/${task.pr.prNumber}/review`;
      const res = await fetch(url, { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setReviewError(body.error ?? `HTTP ${res.status}`);
      }
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setReviewInFlight(false);
    }
  }

  async function handleFixConflicts() {
    if (!task.pr) return;
    setFixConflictsInFlight(true);
    setReviewError(null);
    try {
      const ownerRepo = parseOwnerRepo(task.pr.prUrl);
      if (!ownerRepo) {
        setReviewError('Could not parse owner/repo from PR URL.');
        return;
      }
      const res = await fetch(
        `/api/prs/${ownerRepo.owner}/${ownerRepo.repo}/${task.pr.prNumber}/fix-conflicts`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setReviewError(body.error ?? `HTTP ${res.status}`);
      }
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setFixConflictsInFlight(false);
    }
  }

  async function handleMerge() {
    if (!task.pr) return;
    if (
      !confirm(
        `Merge PR #${task.pr.prNumber} '${task.pr.title}' into ${task.pr.baseBranch}? This cannot be undone.`,
      )
    )
      return;
    setMergeInFlight(true);
    setReviewError(null);
    try {
      const ownerRepo = parseOwnerRepo(task.pr.prUrl);
      if (!ownerRepo) {
        setReviewError('Could not parse owner/repo from PR URL.');
        return;
      }
      const res = await fetch(
        `/api/prs/${ownerRepo.owner}/${ownerRepo.repo}/${task.pr.prNumber}/merge`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setReviewError(body.error ?? `HTTP ${res.status}`);
      } else {
        setOptimisticDisplayStatus('done');
      }
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setMergeInFlight(false);
    }
  }

  async function handleMarkMerged() {
    const sessionId = task.codeSession?.sessionId ?? task.review?.sessionId;
    if (!sessionId) return;
    if (
      !confirm(
        'Mark this task as merged/done? The Notion task will move to ✅ Done.',
      )
    )
      return;
    setMarkMergedInFlight(true);
    setReviewError(null);
    try {
      await sessionsApi.markMerged(sessionId);
      setOptimisticDisplayStatus('done');
    } catch (err) {
      setReviewError(
        err instanceof Error ? err.message : 'Failed to mark merged',
      );
    } finally {
      setMarkMergedInFlight(false);
    }
  }

  // Accordion: on mobile, REVIEW and PULL REQUEST are mutually exclusive when both exist.
  const mobileAccordionActive = isMobile && !!task.review && !!task.pr;
  const isReviewExpanded = mobileAccordionActive
    ? mobileOpenSection === 'review'
    : showReviewSection;
  const isPrExpanded = mobileAccordionActive
    ? mobileOpenSection === 'pr'
    : true;

  const handleReviewToggle = useCallback(() => {
    if (mobileAccordionActive) {
      setMobileOpenSection((prev) => (prev === 'review' ? null : 'review'));
    } else {
      setShowReviewSection((v) => !v);
    }
  }, [mobileAccordionActive]);

  const handlePrToggle = useCallback(() => {
    setMobileOpenSection((prev) => (prev === 'pr' ? null : 'pr'));
  }, []);

  return (
    <div className={styles.panel}>
      {/* ── Mobile session overlay ── */}
      {isMobile && sessionOverlayOpen && codeSession && (
        <>
          <div
            className={styles.sessionOverlayBackdrop}
            onClick={() => window.history.back()}
            aria-hidden="true"
            data-testid="session-overlay-backdrop"
          />
          <div className={styles.sessionOverlay} data-testid="session-overlay">
            <SessionDetail
              session={codeSession}
              send={send}
              onClose={() => window.history.back()}
              onDelete={() => window.history.back()}
              onArchive={() => window.history.back()}
              onUnarchive={() => window.history.back()}
            />
          </div>
        </>
      )}

      {/* ── Header ── */}
      <div className={styles.header}>
        <div className={styles.headerTop}>
          <span className={styles.taskName}>{task.taskName}</span>
          <button
            className={styles.closeButton}
            onClick={() => window.history.back()}
            aria-label="Close panel"
          >
            ✕
          </button>
        </div>
        <div className={styles.headerMeta}>
          <span
            className={`${styles.displayStatusBadge} ${styles[displayStatusClass]}`}
          >
            {displayStatusLabel}
          </span>
          {task.priority && (
            <span className={styles.priorityBadge}>{task.priority}</span>
          )}
          {task.totalTokens.input + task.totalTokens.output > 0 && (
            <span className={styles.totalTokensBadge}>
              {formatTokenCount(
                task.totalTokens.input + task.totalTokens.output,
              )}{' '}
              tokens
            </span>
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
        {/* ── Tab bar — only shown when task has a PR ── */}
        {task.pr && (
          <div className={styles.tabBar}>
            <button
              className={`${styles.tabButton} ${activeTab === 'overview' ? styles['tabButton--active'] : ''}`}
              onClick={() => setActiveTab('overview')}
            >
              Overview
            </button>
            <button
              className={`${styles.tabButton} ${activeTab === 'diff' ? styles['tabButton--active'] : ''}`}
              onClick={() => setActiveTab('diff')}
            >
              Diff
            </button>
          </div>
        )}

        {/* ── Overview tab (or full content when no PR) ── */}
        {(!task.pr || activeTab === 'overview') && (
          <>
            {/* ── Code Session — full transcript on desktop, compact summary on mobile ── */}
            {task.codeSession && (
              <div className={styles.codeSection}>
                <div className={styles.sectionHeader}>
                  <span className={styles.sectionTitle}>Code Session</span>
                  <StatusBadge status={task.codeSession.status} />
                  {isCodeActive && (
                    <button className={styles.killButton} onClick={handleKill}>
                      Kill
                    </button>
                  )}
                </div>
                {isMobile ? (
                  <div className={styles.sessionSummary}>
                    {task.codeSession.lastMessage && (
                      <p className={styles.sessionSummaryMessage}>
                        {task.codeSession.lastMessage}
                      </p>
                    )}
                    {task.codeSession.inputTokens +
                      task.codeSession.outputTokens >
                      0 && (
                      <span className={styles.sessionSummaryTokens}>
                        {formatTokenCount(
                          task.codeSession.inputTokens +
                            task.codeSession.outputTokens,
                        )}{' '}
                        tokens
                      </span>
                    )}
                    <button
                      className={styles.viewSessionButton}
                      onClick={onOpenSessionOverlay}
                    >
                      View full session
                    </button>
                    {isCodeActive && (
                      <InlineComposer
                        sessionId={task.codeSession.sessionId}
                        send={send}
                      />
                    )}
                  </div>
                ) : (
                  <>
                    <div className={styles.transcriptArea}>
                      {codeSession ? (
                        <EventTranscript
                          events={codeSession.events}
                          permissionDenials={codeSession.permissionDenials}
                        />
                      ) : (
                        <p className={styles.noTranscript}>
                          Transcript not available — session not loaded.
                        </p>
                      )}
                    </div>
                    {isCodeActive && (
                      <InlineComposer
                        sessionId={task.codeSession.sessionId}
                        send={send}
                      />
                    )}
                  </>
                )}
              </div>
            )}

            {/* ── Review session — collapsible transcript ── */}
            {task.review && (
              <div className={styles.reviewSection}>
                <div
                  className={styles.reviewSectionHeader}
                  onClick={handleReviewToggle}
                  role="button"
                  aria-expanded={isReviewExpanded}
                >
                  <span className={styles.reviewToggleIcon} aria-hidden="true">
                    {isReviewExpanded ? '▼' : '▶'}
                  </span>
                  <span className={styles.sectionTitle}>Review</span>
                  {task.review.iterationCount > 0 && (
                    <span className={styles.iterationCount}>
                      #{task.review.iterationCount}
                    </span>
                  )}
                  {task.review.inputTokens + task.review.outputTokens > 0 && (
                    <span className={styles.reviewTokenCount}>
                      {formatTokenCount(
                        task.review.inputTokens + task.review.outputTokens,
                      )}{' '}
                      tokens
                    </span>
                  )}
                  {task.review.verdict ? (
                    <span
                      className={`${styles.verdictPill} ${styles[VERDICT_CSS_KEYS[task.review.verdict] ?? 'verdict--error']}`}
                    >
                      {VERDICT_LABELS[task.review.verdict] ??
                        task.review.verdict}
                    </span>
                  ) : task.review.status === 'running' ||
                    task.review.status === 'starting' ? (
                    <span
                      className={`${styles.verdictPill} ${styles['verdict--pending']}`}
                    >
                      In progress…
                    </span>
                  ) : null}
                </div>

                {isReviewExpanded && (
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
                          {showReviewDimensions
                            ? '▼ Hide dimensions'
                            : '▶ Show dimensions'}
                        </button>
                        {showReviewDimensions && (
                          <ReviewDimensions session={reviewSession} />
                        )}
                      </>
                    ) : (
                      <p className={styles.noTranscript}>
                        Review transcript not available.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ── Mark Merged — local-only projects, no PR, manual merge only ── */}
            {isLocalOnly &&
              !task.pr &&
              !autoMergeEnabled &&
              (task.codeSession || task.review) && (
                <div className={styles.prSection}>
                  <div className={styles.sectionHeader}>
                    <span className={styles.sectionTitle}>Mark as Done</span>
                  </div>
                  {reviewError && (
                    <div className={styles.errorBanner}>{reviewError}</div>
                  )}
                  <div className={styles.prActions}>
                    <button
                      className={styles.mergeButton}
                      disabled={
                        markMergedInFlight ||
                        effectiveDisplayStatus === 'done' ||
                        !(
                          task.review?.verdict === 'approved' ||
                          task.codeSession?.status === 'done'
                        )
                      }
                      onClick={() => void handleMarkMerged()}
                      title={
                        task.review?.verdict !== 'approved' &&
                        task.codeSession?.status !== 'done'
                          ? 'Available after code session completes or review approves'
                          : undefined
                      }
                    >
                      {markMergedInFlight ? 'Marking…' : 'Mark Merged ↓'}
                    </button>
                  </div>
                </div>
              )}

            {/* ── Pull Request — compact metadata + action buttons ── */}
            {task.pr && (
              <div className={styles.prSection}>
                {mobileAccordionActive ? (
                  <div
                    className={styles.prSectionHeaderMobile}
                    onClick={handlePrToggle}
                    role="button"
                    aria-expanded={isPrExpanded}
                  >
                    <span
                      className={styles.reviewToggleIcon}
                      aria-hidden="true"
                    >
                      {isPrExpanded ? '▼' : '▶'}
                    </span>
                    <span className={styles.sectionTitle}>Pull Request</span>
                  </div>
                ) : (
                  <div className={styles.sectionHeader}>
                    <span className={styles.sectionTitle}>Pull Request</span>
                  </div>
                )}

                {isPrExpanded && (
                  <>
                    {/* Line 1: PR number + title (truncated) + state badge */}
                    <div className={styles.prTitleRow}>
                      <div className={styles.prTitleLeft}>
                        <span className={styles.prNumber}>
                          #{task.pr.prNumber}
                        </span>
                        <span className={styles.prTitleText}>
                          {task.pr.title}
                        </span>
                      </div>
                      <span
                        className={`${styles.prStateBadge} ${styles[`prState--${task.pr.state}${task.pr.draft ? '-draft' : ''}`]}`}
                      >
                        {prStateLabel(task.pr.state, task.pr.draft)}
                      </span>
                    </div>

                    {/* Line 2: branch info + GitHub link */}
                    <div className={styles.prBranchRow}>
                      <span className={styles.prBranch}>
                        {task.pr.headBranch} → {task.pr.baseBranch}
                      </span>
                      <a
                        href={task.pr.prUrl}
                        target="_blank"
                        rel="noreferrer"
                        className={styles.githubLink}
                      >
                        GitHub ↗
                      </a>
                    </div>

                    {reviewError && (
                      <div className={styles.errorBanner}>{reviewError}</div>
                    )}

                    {task.pr.mergeState === 'dirty' && (
                      <div className={styles.conflictBanner}>
                        ⚠ Merge conflicts detected — use Fix Conflicts to have
                        the code session rebase and resolve them.
                      </div>
                    )}

                    {/* Line 3 (conditional): action buttons only when PR is open */}
                    {task.pr.state === 'open' && (
                      <div className={styles.prActions}>
                        {task.pr.mergeState !== 'dirty' && (
                          <button
                            className={styles.reviewButton}
                            disabled={reviewInFlight || !projectId}
                            onClick={() => void handleRunReview()}
                            title={
                              !projectId ? 'Project ID unavailable' : undefined
                            }
                          >
                            {reviewInFlight ? 'Reviewing…' : 'Run Review'}
                          </button>
                        )}
                        {task.pr.mergeState === 'dirty' && (
                          <button
                            className={styles.reReviewButton}
                            disabled={fixConflictsInFlight}
                            onClick={() => void handleFixConflicts()}
                            title="Send rebase instructions to the code session to resolve merge conflicts"
                          >
                            {fixConflictsInFlight
                              ? 'Fixing…'
                              : '↺ Fix Conflicts'}
                          </button>
                        )}
                        {task.review?.verdict === 'approved' &&
                          task.pr.mergeState !== 'dirty' && (
                            <button
                              className={styles.mergeButton}
                              disabled={mergeInFlight}
                              onClick={() => void handleMerge()}
                            >
                              {mergeInFlight ? 'Merging…' : 'Merge ↓'}
                            </button>
                          )}
                        {task.review?.verdict === 'approved' &&
                          task.pr.mergeState === 'dirty' && (
                            <button
                              className={styles.mergeButton}
                              disabled={true}
                              title="Cannot merge — PR has merge conflicts"
                            >
                              Merge ↓
                            </button>
                          )}
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
          </>
        )}

        {/* ── Diff tab ── */}
        {task.pr && activeTab === 'diff' && (
          <DiffViewer prNumber={task.pr.prNumber} projectId={projectId} />
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
          <span
            className={`${styles.dimIcon} ${dim.passed ? styles['dimIcon--pass'] : styles['dimIcon--fail']}`}
          >
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
