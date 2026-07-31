import { useState, useEffect, useCallback } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ClientMessage } from '@claude-orchestrator/backend/src/ws/types';
import type { TaskView } from '@claude-orchestrator/backend/src/routes/tasks';
import type { DisplayStatus } from '@claude-orchestrator/backend/src/tasks/TaskStatusEngine';
import type { ProjectConfig } from '@claude-orchestrator/backend/src/config';
import type { SessionState } from '../hooks/useSessionStore';
import { SessionPanel } from './SessionPanel';
import { formatTokenCount } from '@claude-orchestrator/backend/src/utils/usage';
import { sessionsApi, authedFetch } from '../api/projects';
import type { SessionWithEvents } from '../api/projects';
import { useIsMobile } from '../hooks/useIsMobile';
import { useTaskPage } from '../hooks/useTaskPage';
import { getTaskSourceLinkLabel } from '../utils/taskSourceLabel';
import { TaskMoveDialog } from './TaskMoveDialog';
import { StagedIntentPanel } from './StagedIntentPanel';
import type { StagedIntent } from '../api/stagedIntents';
import styles from './TaskDetail.module.css';

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

// ── Display status helpers ─────────────────────────────────────────

const DISPLAY_STATUS_LABELS: Record<DisplayStatus, string> = {
  ready: '🗂️ Ready',
  in_progress: '🔄 In Progress',
  in_review: '🔍 In Review',
  needs_attention: '⚠️ Needs Attention',
  ready_to_merge: '✅ Ready to Merge',
  done: '✓ Done',
  backlog: '🔲 Backlog',
  blocked: '🚫 Blocked',
  deferred: '⏭️ Deferred',
};

const DISPLAY_STATUS_CSS_KEYS: Record<DisplayStatus, string> = {
  ready: 'status--ready',
  in_progress: 'status--in-progress',
  in_review: 'status--in-review',
  needs_attention: 'status--needs-attention',
  ready_to_merge: 'status--ready-to-merge',
  done: 'status--done',
  backlog: 'status--backlog',
  blocked: 'status--blocked',
  deferred: 'status--deferred',
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

// ── Archived-session resolution ────────────────────────────────────

function toSessionState({ session, events }: SessionWithEvents): SessionState {
  return {
    sessionId: session.session_id,
    taskName: session.task_name ?? session.task_url ?? session.session_id,
    notionTaskUrl: session.task_url ?? '',
    sessionType: session.session_type,
    status: session.status,
    events,
    started_at: session.started_at,
    ended_at: session.ended_at ?? undefined,
    archived: session.archived === 1,
    favorited: session.favorited === 1,
    project_id: session.project_id,
    note: session.note,
    tags: session.tags ? (JSON.parse(session.tags) as string[]) : undefined,
    model: session.model,
    compaction_count: session.compaction_count,
    context_occupancy_tokens: session.context_occupancy_tokens,
    totalInputTokens: session.total_input_tokens,
    totalOutputTokens: session.total_output_tokens,
  };
}

type SessionFetchState = 'idle' | 'loading' | 'not_found';

/**
 * Resolves a session referenced by a task. The live `sessions` store only
 * carries active/recently-touched sessions — an archived session is absent
 * after a reload, so a miss there triggers a direct by-id fetch (which
 * resolves regardless of archived state) rather than assuming the miss
 * means the session is gone.
 */
function useResolvedSession(
  sessionId: string | undefined,
  sessions: SessionState[],
): { session: SessionState | null; fetchState: SessionFetchState } {
  const liveSession = sessionId
    ? (sessions.find((s) => s.sessionId === sessionId) ?? null)
    : null;
  const [fetched, setFetched] = useState<{
    id: string;
    session: SessionState;
  } | null>(null);
  const [fetchState, setFetchState] = useState<SessionFetchState>('idle');

  useEffect(() => {
    if (!sessionId || liveSession) {
      setFetchState('idle');
      return;
    }
    let cancelled = false;
    setFetchState('loading');
    sessionsApi
      .getById(sessionId)
      .then((result) => {
        if (cancelled) return;
        setFetched({ id: sessionId, session: toSessionState(result) });
      })
      .catch(() => {
        if (cancelled) return;
        setFetchState('not_found');
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, liveSession]);

  if (liveSession) return { session: liveSession, fetchState: 'idle' };
  if (fetched && fetched.id === sessionId) {
    return { session: fetched.session, fetchState: 'idle' };
  }
  return { session: null, fetchState };
}

// ── Props ─────────────────────────────────────────────────────────

interface Props {
  task: TaskView;
  send: (msg: ClientMessage) => void;
  onClose: () => void;
  sessions?: SessionState[];
  projectId?: string;
  /** The current board (milestone) id, used to resolve the move source milestone. */
  boardId?: string | null;
  project?: ProjectConfig | null;
  /** When true, shows the "Mark Merged" button for local-only projects. */
  isLocalOnly?: boolean;
  /** When true, hides the "Mark Merged" button — AutoMerger handles merging. */
  autoMergeEnabled?: boolean;
  setSessionArchived?: (sessionId: string, archived: boolean) => void;
  setSessionFavorited?: (sessionId: string, favorited: boolean) => void;
}

// A concluded grooming session is historical reference; collapse it by default.
// Design/Ops sessions are the task's primary content and always start expanded.
function defaultShowPlanningSection(
  planningSession: TaskView['planningSession'],
): boolean {
  return !(
    planningSession?.sessionType === 'groom' &&
    ['done', 'error', 'killed'].includes(planningSession.status)
  );
}

// ── TaskDetail ────────────────────────────────────────────────────

export function TaskDetail({
  task,
  send,
  // onClose is kept in Props for API compatibility; close button calls window.history.back() directly
  onClose: _onClose,
  sessions = [],
  projectId,
  boardId = null,
  project = null,
  isLocalOnly = false,
  autoMergeEnabled = false,
  setSessionArchived = () => {},
  setSessionFavorited = () => {},
}: Props) {
  const isMobile = useIsMobile();
  const [showReviewSection, setShowReviewSection] = useState(true);
  const [showPlanningSection, setShowPlanningSection] = useState(() =>
    defaultShowPlanningSection(task.planningSession),
  );
  const [showSpec, setShowSpec] = useState(!task.codeSession);
  const [mobileOpenSection, setMobileOpenSection] = useState<
    'review' | 'pr' | null
  >('review');
  const [reviewInFlight, setReviewInFlight] = useState(false);
  const [mergeInFlight, setMergeInFlight] = useState(false);
  const [markMergedInFlight, setMarkMergedInFlight] = useState(false);
  const [fixConflictsInFlight, setFixConflictsInFlight] = useState(false);
  const [abortInFlight, setAbortInFlight] = useState(false);
  const [unblockInFlight, setUnblockInFlight] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [optimisticDisplayStatus, setOptimisticDisplayStatus] =
    useState<DisplayStatus | null>(null);
  const [assignedRepo, setAssignedRepo] = useState<string | null>(
    task.assignedRepo,
  );
  const [assignRepoInFlight, setAssignRepoInFlight] = useState(false);
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const [moveIntent, setMoveIntent] = useState<StagedIntent | null>(null);
  const {
    markdown: specMarkdown,
    loading: specLoading,
    error: specError,
  } = useTaskPage(task.taskId, projectId);

  // Reset state when task changes
  useEffect(() => {
    setShowReviewSection(true);
    setShowPlanningSection(defaultShowPlanningSection(task.planningSession));
    setMobileOpenSection('review');
    setReviewError(null);
    setFixConflictsInFlight(false);
    setUnblockInFlight(false);
    setOptimisticDisplayStatus(null);
    setReviewInFlight(false);
    setMergeInFlight(false);
    setMarkMergedInFlight(false);
    setAbortInFlight(false);
    setAssignedRepo(task.assignedRepo);
    setAssignRepoInFlight(false);
    setShowSpec(!task.codeSession);
    setShowMoveDialog(false);
    setMoveIntent(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.taskId, task.assignedRepo]);

  // Look up live session state
  const codeSession = task.codeSession
    ? (sessions.find((s) => s.sessionId === task.codeSession!.sessionId) ??
      null)
    : null;
  const { session: reviewSession, fetchState: reviewFetchState } =
    useResolvedSession(task.review?.sessionId, sessions);
  const { session: planningSession, fetchState: planningFetchState } =
    useResolvedSession(task.planningSession?.sessionId, sessions);

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
      const res = await authedFetch(url, { method: 'POST' });
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
      const res = await authedFetch(
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
      const res = await authedFetch(
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

  const ACTIVE_CODE_STATUSES = new Set([
    'starting',
    'running',
    'needs_permission',
    'idle',
  ]);
  const isCodeSessionActive =
    !!task.codeSession && ACTIVE_CODE_STATUSES.has(task.codeSession.status);

  async function handleAbort() {
    const sessionId = task.codeSession?.sessionId;
    if (!sessionId) return;
    if (
      !confirm(
        'Abort this session?\n\nThis will kill the session and reset the task to Ready. ' +
          'All work in progress will be discarded. The next launch will start fresh — ' +
          'the aborted session will not be resumed.',
      )
    )
      return;
    setAbortInFlight(true);
    setReviewError(null);
    try {
      await sessionsApi.abort(sessionId);
      setOptimisticDisplayStatus('ready');
    } catch (err) {
      setReviewError(
        err instanceof Error ? err.message : 'Failed to abort session',
      );
    } finally {
      setAbortInFlight(false);
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

  async function handleUnblock() {
    if (!projectId) return;
    setUnblockInFlight(true);
    setReviewError(null);
    try {
      const res = await authedFetch(
        `/api/tasks/${encodeURIComponent(task.taskId)}/unblock?projectId=${encodeURIComponent(projectId)}`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setReviewError(body.error ?? `HTTP ${res.status}`);
      } else {
        setOptimisticDisplayStatus('ready');
      }
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setUnblockInFlight(false);
    }
  }

  const projectRepos = getProjectRepos(project);
  const isMultiRepo = projectRepos.length > 1;

  async function handleAssignRepo(repo: string) {
    if (!projectId || assignRepoInFlight) return;
    setAssignRepoInFlight(true);
    setReviewError(null);
    try {
      const res = await authedFetch(
        `/api/tasks/${encodeURIComponent(task.taskId)}/assign-repo?projectId=${encodeURIComponent(projectId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setReviewError(body.error ?? `HTTP ${res.status}`);
      } else {
        setAssignedRepo(repo);
      }
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setAssignRepoInFlight(false);
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

  const handleSpecToggle = useCallback(() => {
    setShowSpec((v) => !v);
  }, []);

  return (
    <div className={styles.panel}>
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
              {getTaskSourceLinkLabel(project?.taskSource ?? 'notion')}
            </a>
          )}
          <button
            className={styles.specToggleButton}
            onClick={handleSpecToggle}
            aria-expanded={showSpec}
            aria-controls="task-detail-spec-section"
          >
            {showSpec ? 'Hide spec' : 'Show spec'}
          </button>
          {projectId && (
            <button
              className={styles.specToggleButton}
              onClick={() => setShowMoveDialog(true)}
              aria-label={`Move ${task.taskName} to another milestone`}
            >
              ↗ Move
            </button>
          )}
          {isMultiRepo && (
            <select
              className={styles.repoSelect}
              value={assignedRepo ?? ''}
              disabled={assignRepoInFlight}
              onChange={(e) => {
                if (e.target.value) void handleAssignRepo(e.target.value);
              }}
              aria-label="Assign repository"
              title="Assign target repository"
            >
              <option value="">⚠ Needs repo</option>
              {projectRepos.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      <div className={styles.body}>
        {moveIntent && (
          <div data-testid="task-detail-move-panel">
            <StagedIntentPanel
              intent={moveIntent}
              onApplied={() => setMoveIntent(null)}
              onRejected={() => setMoveIntent(null)}
            />
          </div>
        )}

        {/* ── Spec — read-only task body, uniform across sources ── */}
        {showSpec && (
          <div id="task-detail-spec-section" className={styles.specSection}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionTitle}>Spec</span>
            </div>
            <div className={styles.specBody}>
              {specLoading && (
                <p className={styles.noTranscript}>Loading spec…</p>
              )}
              {specError && (
                <div className={styles.errorBanner}>
                  Failed to load spec: {specError}
                </div>
              )}
              {!specLoading && !specError && specMarkdown && (
                <div className={styles.specMarkdown}>
                  <Markdown remarkPlugins={[remarkGfm]}>
                    {specMarkdown}
                  </Markdown>
                </div>
              )}
              {!specLoading && !specError && !specMarkdown && (
                <p className={styles.noTranscript}>No spec available.</p>
              )}
            </div>
          </div>
        )}

        {/* ── Planning SessionPanel — collapsible ── */}
        {task.planningSession && (
          <div
            className={styles.planningSection}
            data-expanded={showPlanningSection}
            data-testid="planning-session-section"
          >
            <div
              className={styles.planningSectionHeader}
              onClick={() => setShowPlanningSection((v) => !v)}
              role="button"
              aria-expanded={showPlanningSection}
              data-testid="planning-session-header"
            >
              <span className={styles.planningToggleIcon} aria-hidden="true">
                {showPlanningSection ? '▼' : '▶'}
              </span>
              <span className={styles.sectionTitle}>
                {task.planningSession.sessionType === 'groom'
                  ? 'Grooming'
                  : task.planningSession.sessionType === 'design'
                    ? 'Design'
                    : 'Ops'}{' '}
                session
              </span>
            </div>
            {showPlanningSection && (
              <div
                className={styles.planningBody}
                data-testid="planning-session-body"
              >
                {planningSession ? (
                  <SessionPanel
                    session={planningSession}
                    send={send}
                    setSessionArchived={setSessionArchived}
                    setSessionFavorited={setSessionFavorited}
                    project={project}
                    showTaskName={false}
                  />
                ) : (
                  <p className={styles.noTranscript}>
                    {planningFetchState === 'loading'
                      ? 'Transcript not available — loading session…'
                      : 'Transcript not available — session not found.'}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Code SessionPanel ── */}
        {task.codeSession && (
          <div className={styles.codeSection}>
            {codeSession ? (
              <SessionPanel
                session={codeSession}
                send={send}
                setSessionArchived={setSessionArchived}
                setSessionFavorited={setSessionFavorited}
                project={project}
                showTaskName={false}
              />
            ) : (
              <p className={styles.noTranscript}>
                Transcript not available — session not loaded.
              </p>
            )}
          </div>
        )}

        {/* ── Abort — destructive action to kill session + reset to Ready ── */}
        {isCodeSessionActive && (
          <div className={styles.abortSection}>
            {reviewError && (
              <div className={styles.errorBanner}>{reviewError}</div>
            )}
            <div className={styles.abortActions}>
              <button
                className={styles.abortButton}
                disabled={abortInFlight}
                onClick={() => void handleAbort()}
                title="Kill the session and reset the task to Ready. Work in progress will be discarded."
              >
                {abortInFlight ? 'Aborting…' : 'Abort'}
              </button>
            </div>
          </div>
        )}

        {/* ── Unblock — clear pause/crash state and reset to Ready ── */}
        {effectiveDisplayStatus === 'blocked' && (
          <div className={styles.abortSection}>
            {reviewError && (
              <div className={styles.errorBanner}>{reviewError}</div>
            )}
            <div className={styles.abortActions}>
              <button
                className={styles.unblockButton}
                disabled={unblockInFlight}
                onClick={() => void handleUnblock()}
                title="Clear the block and reset this task to 🗂️ Ready"
                aria-label="Unblock task"
              >
                {unblockInFlight ? 'Unblocking…' : '↩ Unblock'}
              </button>
            </div>
          </div>
        )}

        {/* ── Review SessionPanel — collapsible ── */}
        {task.review && (
          <div
            className={styles.reviewSection}
            data-expanded={isReviewExpanded}
            data-testid="review-session-section"
          >
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
                  {VERDICT_LABELS[task.review.verdict] ?? task.review.verdict}
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
                  <SessionPanel
                    session={reviewSession}
                    send={send}
                    setSessionArchived={setSessionArchived}
                    setSessionFavorited={setSessionFavorited}
                    project={project}
                    showTaskName={false}
                  />
                ) : (
                  <p className={styles.noTranscript}>
                    {reviewFetchState === 'loading'
                      ? 'Review transcript not available — loading session…'
                      : 'Review transcript not available — session not found.'}
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
                <span className={styles.reviewToggleIcon} aria-hidden="true">
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
                    <span className={styles.prNumber}>#{task.pr.prNumber}</span>
                    <span className={styles.prTitleText}>{task.pr.title}</span>
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
                    ⚠ Merge conflicts detected — use Fix Conflicts to have the
                    code session rebase and resolve them.
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
                        {fixConflictsInFlight ? 'Fixing…' : '↺ Fix Conflicts'}
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
        {!task.codeSession &&
          !task.pr &&
          !task.review &&
          !task.planningSession && (
            <div className={styles.emptyState}>
              <p>No active sessions or PRs for this task.</p>
            </div>
          )}
      </div>

      {showMoveDialog && projectId && (
        <TaskMoveDialog
          task={task}
          projectId={projectId}
          currentBoardId={boardId}
          onClose={() => setShowMoveDialog(false)}
          onStaged={(intent) => {
            setMoveIntent(intent);
            setShowMoveDialog(false);
          }}
        />
      )}
    </div>
  );
}
