import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { TaskView } from '../types/taskView';
import type { ClientMessage } from '@claude-orchestrator/backend/src/ws/types';
import type { ProjectConfig } from '@claude-orchestrator/backend/src/config';
import type { SessionState } from '../hooks/useSessionStore';
import { sessionsApi } from '../api/projects';
import { useTaskPage } from '../hooks/useTaskPage';
import { gateApi } from '../api/gate';
import type { GateItemDetail } from '../api/gate';
import { SessionPanel } from './SessionPanel';
import type { DepthReviewStatus } from './ReviewDetailView';
import {
  taskIdFromIntent,
  taskIdForIntentDisplay,
  isGateVerifyIntent,
  isGateItemTaskId,
  gateItemIdFromIntent,
} from '../utils/milestoneStack';
import type { MilestoneStackSelection } from './MilestoneDecisionStack';
import styles from './MilestoneDrilldown.module.css';

export type DrilldownMode = 'task' | 'session';

interface Props {
  selection: MilestoneStackSelection | null;
  /** Used to resolve an intent's task ref against the middle stack's loaded tasks — falls back to a direct spec fetch when absent. */
  tasks: TaskView[];
  projectId: string | null;
  sessions: SessionState[];
  send: (msg: ClientMessage) => void;
  setSessionArchived: (sessionId: string, archived: boolean) => void;
  setSessionFavorited: (sessionId: string, favorited: boolean) => void;
  project?: ProjectConfig | null;
  /** Which of task/session occupies the panel — controlled by the parent so scroll-follow and card switches can reset it. */
  mode: DrilldownMode;
  onModeChange: (mode: DrilldownMode) => void;
  /** Escalated/routed depth-review dispositions, keyed by the depth_review session id they belong to — looked up for the currently-selected session only, so a depth_review session's own detail view can show its disposition. */
  depthReviewStatusBySessionId?: Record<string, DepthReviewStatus>;
}

/**
 * Resolves a session by id against the live store, falling back to a direct
 * by-id fetch (mirrors TaskDetail's resolution) since the live store only
 * carries active/recently-touched sessions — an archived session referenced
 * by an older intent/task won't be there after a reload.
 */
function useResolvedSession(
  sessionId: string | null | undefined,
  sessions: SessionState[],
): { session: SessionState | null; loading: boolean; notFound: boolean } {
  const liveSession = sessionId
    ? (sessions.find((s) => s.sessionId === sessionId) ?? null)
    : null;
  const [fetched, setFetched] = useState<{
    id: string;
    session: SessionState;
  } | null>(null);
  const [notFound, setNotFound] = useState<{ id: string } | null>(null);

  useEffect(() => {
    if (!sessionId || liveSession) {
      return;
    }
    let cancelled = false;
    sessionsApi
      .getById(sessionId)
      .then(({ session, events }) => {
        if (cancelled) return;
        setFetched({
          id: sessionId,
          session: {
            sessionId: session.session_id,
            taskName:
              session.task_name ?? session.task_url ?? session.session_id,
            notionTaskUrl: session.task_url ?? '',
            sessionType: session.session_type,
            status: session.status,
            events,
            started_at: session.started_at,
            ended_at: session.ended_at ?? undefined,
            archived: session.archived === 1,
            favorited: session.favorited === 1,
            project_id: session.project_id,
          },
        });
      })
      .catch(() => {
        if (cancelled) return;
        setNotFound({ id: sessionId });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, liveSession]);

  if (liveSession)
    return { session: liveSession, loading: false, notFound: false };
  if (fetched && fetched.id === sessionId) {
    return { session: fetched.session, loading: false, notFound: false };
  }
  if (sessionId && notFound && notFound.id === sessionId) {
    return { session: null, loading: false, notFound: true };
  }
  // No live/fetched/not-found match yet for this sessionId — the by-id
  // fallback fetch above is in flight (or about to start on next effect
  // pass). Treat as loading so this render never falls through empty.
  return { session: null, loading: !!sessionId, notFound: false };
}

/**
 * Resolves the task_id of a session by id, for the sole purpose of giving a
 * decision.pickOne (or other taskId-less intent) a display-only task
 * context — the originating session's task. Not derived from the live
 * session store since SessionState doesn't carry task_id.
 */
function useSessionTaskId(sessionId: string | null): string | null {
  const [result, setResult] = useState<{
    id: string;
    taskId: string | null;
  } | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    sessionsApi
      .getById(sessionId)
      .then(({ session }) => {
        if (cancelled) return;
        setResult({ id: sessionId, taskId: session.task_id });
      })
      .catch(() => {
        if (cancelled) return;
        setResult({ id: sessionId, taskId: null });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (!sessionId) return null;
  return result && result.id === sessionId ? result.taskId : null;
}

/** Fetches a gate item's detail (text/classification/state/events) directly by id — no task or session round-trip involved. */
function useGateItemDetail(gateItemId: string | null): {
  detail: GateItemDetail | null;
  loading: boolean;
  error: string | null;
} {
  const [state, setState] = useState<{
    id: string;
    detail: GateItemDetail | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    if (!gateItemId) return;
    let cancelled = false;
    gateApi
      .getGateItemDetail(gateItemId)
      .then((detail) => {
        if (cancelled) return;
        setState({ id: gateItemId, detail, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          id: gateItemId,
          detail: null,
          error:
            err instanceof Error ? err.message : 'Failed to load gate item',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [gateItemId]);

  if (!gateItemId) return { detail: null, loading: false, error: null };
  if (state && state.id === gateItemId) {
    return { detail: state.detail, loading: false, error: state.error };
  }
  return { detail: null, loading: true, error: null };
}

export function MilestoneDrilldown({
  selection,
  tasks,
  projectId,
  sessions,
  send,
  setSessionArchived,
  setSessionFavorited,
  project = null,
  mode,
  onModeChange,
  depthReviewStatusBySessionId = {},
}: Props) {
  const isGateSelection =
    selection?.type === 'intent' && isGateVerifyIntent(selection.intent);
  const gateItemId = isGateSelection
    ? gateItemIdFromIntent(selection.intent)
    : null;

  const intentPayloadTaskId =
    selection?.type === 'intent' ? taskIdFromIntent(selection.intent) : null;
  const intentSessionId =
    selection?.type === 'intent' ? (selection.intent.sessionId ?? null) : null;
  // Only resolved when needed — a payload taskId, a gate-verify intent (resolved by
  // gateItemId directly, no session round-trip) or a task selection never trigger this fetch.
  const fallbackSessionTaskId = useSessionTaskId(
    selection?.type === 'intent' && !intentPayloadTaskId && !isGateSelection
      ? intentSessionId
      : null,
  );

  const {
    detail: gateItemDetail,
    loading: gateItemLoading,
    error: gateItemError,
  } = useGateItemDetail(gateItemId);

  // Guards against the session's task_id being a `gate-item:` sentinel (e.g.
  // a stray intent whose originating session turns out to be a gate-verify
  // session) — never surface that as a real task id.
  const safeFallbackSessionTaskId = isGateItemTaskId(fallbackSessionTaskId)
    ? null
    : fallbackSessionTaskId;

  const taskId =
    isGateSelection || selection?.type === 'report'
      ? null
      : selection?.type === 'task'
        ? selection.task.taskId
        : selection
          ? taskIdForIntentDisplay(selection.intent, safeFallbackSessionTaskId)
          : null;

  const resolvedTask: TaskView | null =
    selection?.type === 'task'
      ? selection.task
      : (tasks.find((t) => t.taskId === taskId) ?? null);

  // A report has no task ref at all — its session comes from the most
  // recently dispatched investigation session (dispatchedSessions is
  // already most-recent-first, per reportStore.ts).
  const sessionId =
    selection?.type === 'task'
      ? (selection.task.codeSession?.sessionId ?? null)
      : selection?.type === 'report'
        ? (selection.report.dispatchedSessions[0]?.sessionId ?? null)
        : (selection?.intent.sessionId ??
          resolvedTask?.codeSession?.sessionId ??
          null);

  const {
    markdown: taskMarkdown,
    loading: taskLoading,
    error: taskError,
  } = useTaskPage(taskId, projectId);

  const {
    session: resolvedSession,
    loading: sessionLoading,
    notFound: sessionNotFound,
  } = useResolvedSession(sessionId, sessions);

  if (!selection) {
    return (
      <div className={styles.drilldownEmptyWrap}>
        <div
          className={styles.emptyState}
          data-testid="milestone-drilldown-empty"
        >
          Select an item from the stack to see details.
        </div>
      </div>
    );
  }

  return (
    <div className={styles.drilldown} data-testid="milestone-drilldown">
      <div className={styles.modeTabs} role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'task'}
          className={styles.modeTab}
          onClick={() => onModeChange('task')}
          data-testid="drilldown-mode-task"
        >
          Task
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'session'}
          className={styles.modeTab}
          onClick={() => onModeChange('session')}
          data-testid="drilldown-mode-session"
        >
          Session
        </button>
      </div>

      {mode === 'task' && isGateSelection ? (
        <div
          className={styles.taskReader}
          data-testid="milestone-gate-item-reader"
        >
          <div className={styles.headingRow}>
            <div className={styles.heading}>
              {gateItemDetail?.item.text ?? 'Gate item'}
            </div>
            {gateItemDetail && (
              <span className={styles.headingType}>
                {gateItemDetail.item.classification}
              </span>
            )}
          </div>
          {!gateItemId && (
            <p
              className={styles.muted}
              data-testid="milestone-drilldown-unresolved"
            >
              This gate.verify decision doesn't reference a gate item.
            </p>
          )}
          {gateItemId && gateItemLoading && (
            <p className={styles.muted}>Loading gate item…</p>
          )}
          {gateItemId && gateItemError && (
            <p className={styles.error}>
              Failed to load gate item: {gateItemError}
            </p>
          )}
          {gateItemId &&
            !gateItemLoading &&
            !gateItemError &&
            gateItemDetail && (
              <div className={styles.taskMarkdown}>
                <p>
                  <strong>State:</strong> {gateItemDetail.item.state}
                  {gateItemDetail.item.currentDisposition
                    ? ` (${gateItemDetail.item.currentDisposition})`
                    : ''}
                </p>
                <div>
                  <strong>Event history</strong>
                  {gateItemDetail.events.length === 0 ? (
                    <p className={styles.muted}>None</p>
                  ) : (
                    <ul>
                      {gateItemDetail.events.map((e, i) => (
                        <li key={i}>
                          {e.disposition} — {new Date(e.at).toLocaleString()}
                          {e.operator ? ` by ${e.operator}` : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
        </div>
      ) : mode === 'task' && selection.type === 'report' ? (
        <div
          className={styles.taskReader}
          data-testid="milestone-report-reader"
        >
          <div className={styles.headingRow}>
            <div className={styles.heading}>{selection.report.title}</div>
            <span className={styles.headingType}>{selection.report.state}</span>
          </div>
          <p className={styles.taskMarkdown}>{selection.report.symptom_text}</p>
        </div>
      ) : mode === 'task' ? (
        <div className={styles.taskReader} data-testid="milestone-task-reader">
          <div className={styles.headingRow}>
            <div className={styles.heading}>
              {resolvedTask?.taskName ?? 'No task selected'}
            </div>
            {resolvedTask && (
              <span className={styles.headingType}>
                {resolvedTask.taskType}
              </span>
            )}
          </div>
          {!taskId && (
            <p
              className={styles.muted}
              data-testid="milestone-drilldown-unresolved"
            >
              {selection.type === 'intent'
                ? `This ${selection.intent.kind} decision doesn't reference an existing task yet.`
                : 'No task selected.'}
            </p>
          )}
          {taskId && taskLoading && (
            <p className={styles.muted}>Loading task…</p>
          )}
          {taskId && taskError && (
            <p className={styles.error}>Failed to load task: {taskError}</p>
          )}
          {taskId && !taskLoading && !taskError && taskMarkdown && (
            <div className={styles.taskMarkdown}>
              <Markdown remarkPlugins={[remarkGfm]}>{taskMarkdown}</Markdown>
            </div>
          )}
          {taskId && !taskLoading && !taskError && !taskMarkdown && (
            <p className={styles.muted}>No spec available for this task.</p>
          )}
        </div>
      ) : (
        <div
          className={styles.sessionEmbed}
          data-testid="milestone-session-embed"
        >
          {!sessionId && (
            <p className={styles.muted}>
              {resolvedTask
                ? 'Not launched yet — no session to show.'
                : 'No associated session.'}
            </p>
          )}
          {sessionId && sessionLoading && (
            <p className={styles.muted}>Loading session…</p>
          )}
          {sessionId && !sessionLoading && sessionNotFound && (
            <p className={styles.muted}>
              Transcript not available — session not loaded.
            </p>
          )}
          {sessionId && !sessionLoading && resolvedSession && (
            <SessionPanel
              session={resolvedSession}
              send={send}
              setSessionArchived={setSessionArchived}
              setSessionFavorited={setSessionFavorited}
              project={project}
              showDecisionPanel={false}
              depthReviewStatus={
                depthReviewStatusBySessionId[resolvedSession.sessionId] ?? null
              }
            />
          )}
        </div>
      )}
    </div>
  );
}
