import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { TaskView } from '../types/taskView';
import type { ClientMessage } from '@claude-orchestrator/backend/src/ws/types';
import type { ProjectConfig } from '@claude-orchestrator/backend/src/config';
import type { SessionState } from '../hooks/useSessionStore';
import { sessionsApi } from '../api/projects';
import { useTaskPage } from '../hooks/useTaskPage';
import { SessionPanel } from './SessionPanel';
import { taskIdFromIntent } from './MilestoneDecisionStack';
import type { MilestoneStackSelection } from './MilestoneDecisionStack';
import styles from './MilestoneDrilldown.module.css';

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
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    setNotFound(false);
    if (!sessionId || liveSession) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
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
        setNotFound(true);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
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
  return { session: null, loading, notFound };
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
}: Props) {
  const taskId =
    selection?.type === 'task'
      ? selection.task.taskId
      : selection
        ? taskIdFromIntent(selection.intent)
        : null;

  const resolvedTask: TaskView | null =
    selection?.type === 'task'
      ? selection.task
      : (tasks.find((t) => t.taskId === taskId) ?? null);

  const sessionId =
    selection?.type === 'task'
      ? (selection.task.codeSession?.sessionId ?? null)
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
      <div
        className={styles.emptyState}
        data-testid="milestone-drilldown-empty"
      >
        Select an item from the stack to see details.
      </div>
    );
  }

  return (
    <div className={styles.drilldown} data-testid="milestone-drilldown">
      <div className={styles.taskReader} data-testid="milestone-task-reader">
        <div className={styles.heading}>{resolvedTask?.taskName ?? 'Task'}</div>
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
        {taskId && taskLoading && <p className={styles.muted}>Loading task…</p>}
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
          />
        )}
      </div>
    </div>
  );
}
