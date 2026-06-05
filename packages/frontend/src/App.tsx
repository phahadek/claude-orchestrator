import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { EnrollmentFlow } from './auth/EnrollmentFlow';
import { SetupWizard } from './wizard/SetupWizard';
import type { ConnectionState } from './hooks/useWebSocket';
import { useSessionStore } from './hooks/useSessionStore';
import { useWebSocket } from './hooks/useWebSocket';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useNotifications } from './hooks/useNotifications';
import { useIsMobile } from './hooks/useIsMobile';
import { useNavigationHistory } from './hooks/useNavigationHistory';
import { Header } from './components/Header';
import type { TopView } from './components/Header';
import { SessionGrid } from './components/SessionGrid';
import { HistoryGrid } from './components/HistoryGrid';
import { SessionDetail } from './components/SessionDetail';
import { PRPanel } from './components/PRPanel';
import { DispatchModal } from './components/DispatchModal';
import { PermissionEventLog } from './components/PermissionEventLog';
import { TaskList } from './components/TaskList';
import { TaskDetail } from './components/TaskDetail';
import { Settings } from './components/Settings';
import { UpdateBanner } from './components/UpdateBanner';
import { RateLimitBanner } from './components/RateLimitBanner';
import { AnalyticsPanel } from './components/AnalyticsPanel';
import { Notifications } from './components/Notifications';
import { ShortcutHint } from './components/ShortcutHint';
import { SessionFilterBar } from './components/SessionFilterBar';
import { ErrorBoundary } from './components/ErrorBoundary';
import type { NotificationItem } from './components/Notifications';
import type { ServerMessage } from '@claude-orchestrator/backend/src/ws/types';
import type { ProjectConfig } from '@claude-orchestrator/backend/src/config';
import { calculateCost } from '@claude-orchestrator/backend/src/utils/usage';
import type { TaskView } from '@claude-orchestrator/backend/src/routes/tasks';
import type {
  Session,
  EventType,
} from '@claude-orchestrator/backend/src/db/types';
import styles from './App.module.css';

interface ArchivedSessionEvent {
  eventType: EventType;
  content: string;
  timestamp: number;
  messageId?: string;
}

interface ArchivedSessionResponse {
  session: Session;
  events: ArchivedSessionEvent[];
}

const DEFAULT_DETAIL_WIDTH = 40;
const MIN_DETAIL_WIDTH_PCT = 20;
const MAX_DETAIL_WIDTH_PCT = 80;
const MIN_LEFT_PANEL_PX = 300;
const MIN_RIGHT_PANEL_PX = 300;

const ACTIVE_PROJECT_KEY = 'activeProjectId';
const ACTIVE_MILESTONE_KEY_PREFIX = 'activeMilestone_';
const NON_MILESTONE_BOARD_ID = '__non_milestone__';

function getMilestoneKey(projectId: string) {
  return `${ACTIVE_MILESTONE_KEY_PREFIX}${projectId}`;
}

function getDefaultBoardId(project: ProjectConfig): string {
  return project.boards?.[0]?.id ?? project.boardId;
}

function resolveActiveBoardId(project: ProjectConfig): string {
  const stored = localStorage.getItem(getMilestoneKey(project.id));
  const boards = project.boards ?? [];
  if (stored && boards.some((b) => b.id === stored)) {
    return stored;
  }
  return getDefaultBoardId(project);
}

export default function App() {
  const [needsEnrollment, setNeedsEnrollment] = useState(false);
  const [setupNeeded, setSetupNeeded] = useState(false);
  const [wizardGoToSettings, setWizardGoToSettings] = useState(false);

  useEffect(() => {
    fetch('/api/setup/status')
      .then((r) => r.json())
      .then((data: { setupNeeded: boolean }) => {
        if (data.setupNeeded) setSetupNeeded(true);
      })
      .catch(() => {
        /* keep showing dashboard on failure */
      });
  }, []);

  useEffect(() => {
    const handler = () => setNeedsEnrollment(true);
    window.addEventListener('device-unauthorized', handler);
    return () => window.removeEventListener('device-unauthorized', handler);
  }, []);

  const {
    sessions,
    tasks,
    tasksReady,
    synced,
    readyCount,
    blockedCount,
    dispatch,
    resetTasks,
    deleteSession,
    setSessionArchived,
    setSessionFavorited,
    prRefreshTrigger,
    lastPrReviewEvent,
    lastPrMergedEvent,
    lastPrClosedEvent,
    lastPrStateChangedEvent,
    lastPrMergeabilityChangedEvent,
    lastReviewEscalation,
    lastReviewFailed,
    lastStuckNotification,
    lastStuckPaused,
    lastStuckKilled,
    lastApiOverloadedPaused,
    incompleteReviews,
    lastTaskUpdate,
    taskListRefreshTrigger,
    lastAutofixEvent,
    lastReviewStartedEvent,
    lastCiBillingBlockedEvent,
    lastSessionStartedEvent,
    lastSessionEndedEvent,
  } = useSessionStore();
  const [projects, setProjects] = useState<ProjectConfig[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const activeProjectIdRef = useRef<string | null>(null);
  const [activeBoardId, setActiveBoardId] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [activeView, setActiveView] = useState<
    'sessions' | 'history' | 'denials'
  >('sessions');
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [updateInfo, setUpdateInfo] = useState<{
    version: string;
    releaseNotesUrl: string;
  } | null>(null);
  const [rateLimitInfo, setRateLimitInfo] = useState<{
    resetAt: string;
  } | null>(null);
  const [rateLimitDismissed, setRateLimitDismissed] = useState(false);
  const notifiedRef = useRef<Set<string>>(new Set());
  const [showReconnected, setShowReconnected] = useState(false);
  const [hasConnectedOnce, setHasConnectedOnce] = useState(false);
  const prevConnectionState = useRef<ConnectionState>('disconnected');

  const dismissNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const handleWsMessage = useCallback(
    (msg: Parameters<typeof dispatch>[0]) => {
      if (msg.type === 'error') {
        const notifId = crypto.randomUUID();
        setNotifications((prev) => [
          ...prev,
          { id: notifId, message: msg.message, status: 'error' },
        ]);
        setTimeout(() => dismissNotification(notifId), 10_000);
        return;
      }
      if (msg.type === 'update_available') {
        setUpdateInfo({
          version: msg.version,
          releaseNotesUrl: msg.releaseNotesUrl,
        });
        return;
      }
      if (msg.type === 'github_rate_limit_hit') {
        setRateLimitInfo({ resetAt: msg.resetAt });
        setRateLimitDismissed(false);
        return;
      }
      if (msg.type === 'github_rate_limit_cleared') {
        setRateLimitInfo(null);
        setRateLimitDismissed(false);
        return;
      }
      dispatch(msg);
    },
    [dispatch, dismissNotification],
  );

  const { send, connectionState } = useWebSocket(handleWsMessage);

  const [cardPreviewLines, setCardPreviewLines] = useState<number>(3);
  const [sessionMode, setSessionMode] = useState<string>('cli');
  const [autoLaunchCap, setAutoLaunchCap] = useState<number>(1);
  const [autoLaunchPollIntervalMs, setAutoLaunchPollIntervalMs] =
    useState<number>(60000);

  const [detailWidthPct, setDetailWidthPct] = useState<number>(() => {
    const saved = localStorage.getItem('sessionDetailWidth');
    if (saved) {
      const n = Number(saved);
      if (n >= MIN_DETAIL_WIDTH_PCT && n <= MAX_DETAIL_WIDTH_PCT) return n;
    }
    return DEFAULT_DETAIL_WIDTH;
  });
  const [isDragging, setIsDragging] = useState(false);
  const detailWidthRef = useRef(detailWidthPct);

  const [topView, setTopView] = useState<TopView>('tasks');

  useEffect(() => {
    if (wizardGoToSettings) setTopView('settings');
  }, [wizardGoToSettings]);

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskViews, setTaskViews] = useState<TaskView[]>([]);
  const [taskViewsLoading, setTaskViewsLoading] = useState(true);
  const settingsInitialTab = 'general' as const;
  const isMobile = useIsMobile();

  const { pushView } = useNavigationHistory({
    setSelectedTaskId,
    setSelectedId,
  });

  const handleSelectTask = useCallback(
    (taskId: string) => {
      if (taskId === selectedTaskId) return;
      pushView({ type: 'task', id: taskId });
      setSelectedTaskId(taskId);
    },
    [selectedTaskId, pushView],
  );

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      if (sessionId === selectedId) return;
      pushView({ type: 'session', id: sessionId });
      setSelectedId(sessionId);
    },
    [selectedId, pushView],
  );

  useEffect(() => {
    detailWidthRef.current = detailWidthPct;
  }, [detailWidthPct]);

  // Send fetch_tasks after React commits state — covers user switches and WS reconnects
  useEffect(() => {
    if (connectionState !== 'connected' || !activeProjectId || !activeBoardId)
      return;
    send({
      type: 'fetch_tasks',
      projectId: activeProjectId,
      milestoneId: activeBoardId,
    });
  }, [connectionState, activeProjectId, activeBoardId, send]);

  useEffect(() => {
    if (connectionState === 'connected') {
      if (hasConnectedOnce) {
        setShowReconnected(true);
        const timer = setTimeout(() => setShowReconnected(false), 3000);
        return () => clearTimeout(timer);
      }
      setHasConnectedOnce(true);
    }
    prevConnectionState.current = connectionState;
  }, [connectionState, hasConnectedOnce]);

  const handleArchiveAll = useCallback(async () => {
    await fetch('/api/sessions/archive-finished', { method: 'POST' });
    for (const s of sessions) {
      if (!s.archived && ['done', 'error', 'killed', 'idle'].includes(s.status)) {
        setSessionArchived(s.sessionId, true);
      }
    }
  }, [sessions, setSessionArchived]);

  const RESUME_MESSAGE = 'Limits have reset. Continue where you left off.';

  const handleResume = useCallback(
    (sessionId: string) => {
      send({ type: 'send_message', sessionId, message: RESUME_MESSAGE });
    },
    [send],
  );

  const handleResumeAll = useCallback(() => {
    for (const s of sessions) {
      if (!s.archived && s.isRateLimited) {
        send({
          type: 'send_message',
          sessionId: s.sessionId,
          message: RESUME_MESSAGE,
        });
      }
    }
  }, [sessions, send]);

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((s: Record<string, string>) => {
        const lines = Number(s.card_preview_lines);
        if (lines > 0) setCardPreviewLines(lines);
        if (s.session_mode === 'api' || s.session_mode === 'cli')
          setSessionMode(s.session_mode);
        const cap = Number(s.auto_launch_concurrency);
        if (cap > 0) setAutoLaunchCap(cap);
        const pollMs = Number(s.auto_launch_poll_interval_ms);
        if (pollMs > 0) setAutoLaunchPollIntervalMs(pollMs);
      })
      .catch(() => {
        /* keep default */
      });
  }, []);

  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((loaded: ProjectConfig[]) => {
        if (loaded.length === 0) return;
        setProjects(loaded);

        // Restore from localStorage, validate against current project list
        const stored = localStorage.getItem(ACTIVE_PROJECT_KEY);
        const validProjectId =
          stored && loaded.some((p) => p.id === stored) ? stored : loaded[0].id;
        const project = loaded.find((p) => p.id === validProjectId)!;
        const boardId = resolveActiveBoardId(project);

        activeProjectIdRef.current = validProjectId;
        setActiveProjectId(validProjectId);
        setActiveBoardId(boardId);
      })
      .catch(() => {
        /* leave projects empty — DispatchModal handles the empty case */
      });
  }, []);

  const handleProjectChange = useCallback(
    (id: string) => {
      const project = projects.find((p) => p.id === id);
      const boardId = project ? resolveActiveBoardId(project) : null;
      localStorage.setItem(ACTIVE_PROJECT_KEY, id);
      activeProjectIdRef.current = id;
      setActiveProjectId(id);
      setActiveBoardId(boardId);
    },
    [projects],
  );

  const handleBoardChange = useCallback((boardId: string) => {
    if (!activeProjectIdRef.current) return;
    localStorage.setItem(getMilestoneKey(activeProjectIdRef.current), boardId);
    setActiveBoardId(boardId);
  }, []);

  const handleAutoLaunchToggle = useCallback(
    (patch: {
      autoLaunchEnabled: boolean;
      autoLaunchMilestoneId?: string | null;
    }) => {
      const projectId = activeProjectIdRef.current;
      if (!projectId) return;
      void (async () => {
        try {
          const res = await fetch(
            `/api/projects/${encodeURIComponent(projectId)}`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(patch),
            },
          );
          if (!res.ok) return;
          const refreshed = await fetch('/api/config');
          if (!refreshed.ok) return;
          const loaded = (await refreshed.json()) as ProjectConfig[];
          setProjects(loaded);
        } catch {
          /* non-critical — next refresh will reconcile */
        }
      })();
    },
    [],
  );

  const handleProjectsChanged = useCallback(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((loaded: ProjectConfig[]) => {
        setProjects(loaded);
      })
      .catch(() => {
        /* non-critical */
      });
  }, []);

  // Fetch TaskView list whenever tasks are ready, project/board changes, or a review session starts.
  // This is the single source of truth for task data — TaskList reads from taskViews via props.
  useEffect(() => {
    if (!activeProjectId) {
      setTaskViews([]);
      setTaskViewsLoading(false);
      return;
    }
    setTaskViewsLoading(true);
    let url: string;
    if (activeBoardId === NON_MILESTONE_BOARD_ID) {
      url = `/api/tasks/non-milestone?projectId=${encodeURIComponent(activeProjectId)}`;
    } else {
      const params = new URLSearchParams({ projectId: activeProjectId });
      if (activeBoardId) params.set('boardId', activeBoardId);
      url = `/api/tasks/active?${params.toString()}`;
    }
    fetch(url)
      .then((r) =>
        r.ok ? (r.json() as Promise<TaskView[]>) : Promise.resolve([]),
      )
      .then((data) => {
        setTaskViews(data);
        setTaskViewsLoading(false);
      })
      .catch(() => {
        setTaskViewsLoading(false);
      });
  }, [activeProjectId, activeBoardId, tasksReady, taskListRefreshTrigger]);

  // Merge a single task update in-place so TaskDetail sees live changes without a full re-fetch
  useEffect(() => {
    if (!lastTaskUpdate) return;
    setTaskViews((prev) => {
      const idx = prev.findIndex((t) => t.taskId === lastTaskUpdate.taskId);
      if (idx < 0) return prev;
      const next = [...prev];
      next[idx] = lastTaskUpdate;
      return next;
    });
  }, [lastTaskUpdate]);

  // In-place update when a session starts: mark the matching task's codeSession as starting.
  // This runs in addition to the task_updated path so the panel reflects the change immediately
  // even when task_updated is suppressed (display-status dedup).
  useEffect(() => {
    if (!lastSessionStartedEvent) return;
    const { taskId, sessionId } = lastSessionStartedEvent;
    setTaskViews((prev) => {
      const idx = prev.findIndex((t) => t.taskId === taskId);
      if (idx < 0) return prev;
      const task = prev[idx];
      if (task.codeSession?.sessionId === sessionId) return prev;
      const next = [...prev];
      next[idx] = {
        ...task,
        codeSession: task.codeSession ?? {
          sessionId,
          status: 'starting',
          startedAt: Date.now(),
          endedAt: null,
          lastMessage: '',
          inputTokens: 0,
          outputTokens: 0,
        },
      };
      return next;
    });
  }, [lastSessionStartedEvent]);

  // In-place update when a session ends: mark codeSession as ended and carry prUrl.
  useEffect(() => {
    if (!lastSessionEndedEvent) return;
    const { taskId, status, prUrl } = lastSessionEndedEvent;
    setTaskViews((prev) => {
      const idx = prev.findIndex((t) => t.taskId === taskId);
      if (idx < 0) return prev;
      const task = prev[idx];
      if (task.codeSession?.endedAt != null) return prev;
      const next = [...prev];
      next[idx] = {
        ...task,
        codeSession: task.codeSession
          ? { ...task.codeSession, status, endedAt: Date.now() }
          : null,
        pr: prUrl && task.pr ? { ...task.pr, prUrl } : task.pr,
      };
      return next;
    });
  }, [lastSessionEndedEvent]);

  // Passed to TaskList so it can apply optimistic status updates without a full re-fetch
  const handleTaskOptimisticDispatch = useCallback((taskIds: string[]) => {
    setTaskViews((prev) =>
      prev.map((t) =>
        taskIds.includes(t.taskId)
          ? {
              ...t,
              notionStatus: '🔄 In Progress',
              displayStatus: 'in_progress' as const,
            }
          : t,
      ),
    );
  }, []);

  // Used by TaskList's Sync button for non-milestone views (WS sync not supported there)
  const handleForceRefetch = useCallback(async () => {
    if (!activeProjectId) return;
    setTaskViewsLoading(true);
    try {
      let url: string;
      if (activeBoardId === NON_MILESTONE_BOARD_ID) {
        url = `/api/tasks/non-milestone?projectId=${encodeURIComponent(activeProjectId)}`;
      } else {
        const params = new URLSearchParams({ projectId: activeProjectId });
        if (activeBoardId) params.set('boardId', activeBoardId);
        url = `/api/tasks/active?${params.toString()}`;
      }
      const res = await fetch(url);
      if (res.ok) setTaskViews((await res.json()) as TaskView[]);
    } catch {
      /* ignore */
    } finally {
      setTaskViewsLoading(false);
    }
  }, [activeProjectId, activeBoardId]);

  useEffect(() => {
    for (const session of sessions) {
      if (
        (session.status === 'done' || session.status === 'error') &&
        !session.archived &&
        !notifiedRef.current.has(session.sessionId)
      ) {
        notifiedRef.current.add(session.sessionId);
        if (session.lastStatusReplay) continue;
        const notifId = `${session.sessionId}-notif`;
        setNotifications((prev) => [
          ...prev,
          {
            id: notifId,
            taskName: session.taskName,
            status: session.status as 'done' | 'error',
            prUrl: session.prUrl,
          },
        ]);
        setTimeout(() => dismissNotification(notifId), 10000);
      }
    }
  }, [sessions, dismissNotification]);

  useEffect(() => {
    if (!lastPrReviewEvent) return;
    const { prNumber, verdict, summary } = lastPrReviewEvent;
    let message: string;
    if (verdict === 'approved') {
      message = `✅ PR #${prNumber} approved`;
    } else if (verdict === 'needs_changes') {
      message = `⚠️ PR #${prNumber} needs changes: ${summary.slice(0, 80)}`;
    } else if (verdict === 'incomplete') {
      message = `❌ PR #${prNumber} incomplete: ${summary}`;
    } else {
      message = `⏰ Review failed for PR #${prNumber} — click Run Review to retry`;
    }
    const notifId = `review-${prNumber}-${Date.now()}`;
    setNotifications((prev) => [
      ...prev,
      {
        id: notifId,
        message,
        status: 'review',
        onClick: () => setTopView('prs'),
      },
    ]);
    setTimeout(() => dismissNotification(notifId), 10000);
  }, [lastPrReviewEvent, dismissNotification]);

  useEffect(() => {
    if (!lastReviewEscalation) return;
    const { prNumber, receivedAt } = lastReviewEscalation;
    const notifId = `escalation-${prNumber}-${receivedAt}`;
    setNotifications((prev) => [
      ...prev,
      {
        id: notifId,
        message: `⚠️ PR #${prNumber} review loop hit max iterations — needs your attention`,
        status: 'review',
        onClick: () => setTopView('prs'),
      },
    ]);
    setTimeout(() => dismissNotification(notifId), 10000);
  }, [lastReviewEscalation, dismissNotification]);

  useEffect(() => {
    if (!lastReviewFailed) return;
    const { prNumber, message, receivedAt } = lastReviewFailed;
    const notifId = `review-failed-${prNumber}-${receivedAt}`;
    setNotifications((prev) => [
      ...prev,
      {
        id: notifId,
        message: `❌ PR #${prNumber} re-review failed unexpectedly: ${message}`,
        status: 'review',
        onClick: () => setTopView('prs'),
      },
    ]);
    setTimeout(() => dismissNotification(notifId), 10000);
  }, [lastReviewFailed, dismissNotification]);

  useEffect(() => {
    if (!lastStuckNotification) return;
    const { sessionId, message, receivedAt } = lastStuckNotification;
    const notifId = `stuck-notify-${sessionId}-${receivedAt}`;
    setNotifications((prev) => [
      ...prev,
      {
        id: notifId,
        message,
        status: 'review',
        onClick: () =>
          window.dispatchEvent(
            new CustomEvent('selectSession', { detail: { sessionId } }),
          ),
      },
    ]);
    setTimeout(() => dismissNotification(notifId), 10000);
  }, [lastStuckNotification, dismissNotification]);

  useEffect(() => {
    if (!lastStuckPaused) return;
    const { sessionId, taskName, receivedAt } = lastStuckPaused;
    const notifId = `stuck-paused-${sessionId}-${receivedAt}`;
    setNotifications((prev) => [
      ...prev,
      {
        id: notifId,
        message: `⏸ ${taskName} paused — supervisor flagged this session`,
        status: 'review',
        onClick: () =>
          window.dispatchEvent(
            new CustomEvent('selectSession', { detail: { sessionId } }),
          ),
      },
    ]);
    setTimeout(() => dismissNotification(notifId), 10000);
  }, [lastStuckPaused, dismissNotification]);

  useEffect(() => {
    if (!lastStuckKilled) return;
    const { sessionId, taskName, receivedAt } = lastStuckKilled;
    const notifId = `stuck-killed-${sessionId}-${receivedAt}`;
    setNotifications((prev) => [
      ...prev,
      {
        id: notifId,
        message: `🛑 ${taskName} hard-stopped — session continued tool use after pause`,
        status: 'review',
        onClick: () =>
          window.dispatchEvent(
            new CustomEvent('selectSession', { detail: { sessionId } }),
          ),
      },
    ]);
    setTimeout(() => dismissNotification(notifId), 10000);
  }, [lastStuckKilled, dismissNotification]);

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);

    const onMove = (ev: MouseEvent) => {
      const w = window.innerWidth;
      const pct = 100 - (ev.clientX / w) * 100;
      // Left panel must be at least 300px or 25%, whichever is larger
      const leftMinPct = Math.max(25, (MIN_LEFT_PANEL_PX / w) * 100);
      // Right panel must be at least 300px or 20%, whichever is larger
      const rightMinPct = Math.max(
        MIN_DETAIL_WIDTH_PCT,
        (MIN_RIGHT_PANEL_PX / w) * 100,
      );
      const maxDetailPct = Math.min(MAX_DETAIL_WIDTH_PCT, 100 - leftMinPct);
      const clamped = Math.min(maxDetailPct, Math.max(rightMinPct, pct));
      detailWidthRef.current = clamped;
      setDetailWidthPct(clamped);
    };

    const onUp = () => {
      setIsDragging(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      localStorage.setItem(
        'sessionDetailWidth',
        String(Math.round(detailWidthRef.current)),
      );
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  const handleViewChange = useCallback((view: TopView) => {
    setTopView(view);
  }, []);

  const [selectedSessionIndex, setSelectedSessionIndex] = useState(-1);

  // Reset keyboard selection index when active project changes
  useEffect(() => {
    setSelectedSessionIndex(-1);
  }, [activeProjectId]);

  const fetchedArchivedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!selectedId) return;
    if (fetchedArchivedRef.current.has(selectedId)) return;
    const inStore = sessions.find((s) => s.sessionId === selectedId);
    if (inStore) return;
    fetchedArchivedRef.current.add(selectedId);
    fetch(`/api/sessions/${selectedId}/events`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<ArchivedSessionResponse>;
      })
      .then(({ session, events }) => {
        dispatch({
          type: 'session_started',
          sessionId: session.session_id,
          taskName: session.task_url ?? session.session_id.slice(0, 8),
          notionTaskUrl: session.task_url ?? '',
          started_at: session.started_at,
          ended_at: session.ended_at,
          archived: session.archived === 1,
          favorited: session.favorited === 1,
          project_id: session.project_id,
        } as ServerMessage);
        dispatch({
          type: 'session_status',
          sessionId: session.session_id,
          status: session.status,
        } as ServerMessage);
        for (const ev of events) {
          dispatch({
            type: 'session_event',
            sessionId: session.session_id,
            eventType: ev.eventType,
            content: ev.content,
            ...(ev.messageId && { messageId: ev.messageId }),
          } as ServerMessage);
        }
      })
      .catch((err) =>
        console.error('[App] failed to load archived session events:', err),
      );
  }, [selectedId, dispatch, sessions]);

  // Fetch session events for the selected task's code and review sessions if not yet in store.
  // Mirrors the archived-session fetch for the Sessions tab so TaskDetail always has live or
  // historical transcript data regardless of whether the session was started before page load.
  const fetchedTaskSessionsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!selectedTaskId) return;
    const task = taskViews.find((t) => t.taskId === selectedTaskId);
    if (!task) return;

    const sessionIds: string[] = [];
    if (task.codeSession?.sessionId)
      sessionIds.push(task.codeSession.sessionId);
    if (task.review?.sessionId) sessionIds.push(task.review.sessionId);

    for (const sessionId of sessionIds) {
      if (fetchedTaskSessionsRef.current.has(sessionId)) continue;
      if (sessions.find((s) => s.sessionId === sessionId)) continue;
      fetchedTaskSessionsRef.current.add(sessionId);
      fetch(`/api/sessions/${sessionId}/events`)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json() as Promise<ArchivedSessionResponse>;
        })
        .then(({ session, events }) => {
          dispatch({
            type: 'session_started',
            sessionId: session.session_id,
            taskName: session.task_url ?? session.session_id.slice(0, 8),
            notionTaskUrl: session.task_url ?? '',
            started_at: session.started_at,
            ended_at: session.ended_at,
            archived: session.archived === 1,
            favorited: session.favorited === 1,
            project_id: session.project_id,
          } as ServerMessage);
          dispatch({
            type: 'session_status',
            sessionId: session.session_id,
            status: session.status,
          } as ServerMessage);
          for (const ev of events) {
            dispatch({
              type: 'session_event',
              sessionId: session.session_id,
              eventType: ev.eventType,
              content: ev.content,
              ...(ev.messageId && { messageId: ev.messageId }),
            } as ServerMessage);
          }
        })
        .catch((err) =>
          console.error('[App] failed to load task session events:', err),
        );
    }
  }, [selectedTaskId, taskViews, dispatch, sessions]);

  const selectedSession =
    selectedId != null
      ? (sessions.find((s) => s.sessionId === selectedId) ?? null)
      : null;

  const filteredSessions = useMemo(() => {
    return sessions
      .filter((s) => !s.archived)
      .filter(
        (s) =>
          !searchText ||
          s.taskName.toLowerCase().includes(searchText.toLowerCase()),
      )
      .filter((s) => !statusFilter || s.status === statusFilter)
      .filter((s) => !tagFilter || s.tags?.includes(tagFilter))
      .filter(
        (s) => activeProjectId !== null && s.project_id === activeProjectId,
      );
  }, [sessions, searchText, statusFilter, tagFilter, activeProjectId]);

  const availableTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const s of sessions) {
      for (const tag of s.tags ?? []) tagSet.add(tag);
    }
    return [...tagSet].sort();
  }, [sessions]);

  const filtersActive = Boolean(searchText || statusFilter || tagFilter);

  function clearFilters() {
    setSearchText('');
    setStatusFilter(null);
    setTagFilter(null);
  }

  const runningCount = filteredSessions.filter((s) =>
    ['running', 'starting', 'needs_permission'].includes(s.status),
  ).length;
  const doneCount = filteredSessions.filter((s) =>
    ['done', 'error', 'killed'].includes(s.status),
  ).length;

  const activeSessions = useMemo(
    () =>
      sessions.filter(
        (s) =>
          !s.archived &&
          activeProjectId !== null &&
          s.project_id === activeProjectId,
      ),
    [sessions, activeProjectId],
  );

  const totalTokens = useMemo(
    () =>
      activeSessions.reduce(
        (sum, s) =>
          sum + (s.totalInputTokens ?? 0) + (s.totalOutputTokens ?? 0),
        0,
      ),
    [activeSessions],
  );

  const totalCost = useMemo(
    () =>
      activeSessions.reduce(
        (sum, s) =>
          sum +
          calculateCost(
            s.totalInputTokens ?? 0,
            s.totalOutputTokens ?? 0,
            s.model,
          ),
        0,
      ),
    [activeSessions],
  );

  const autoLaunchRunningCount = useMemo(
    () =>
      sessions.filter(
        (s) =>
          !s.archived &&
          s.project_id === activeProjectId &&
          (s.sessionType ?? 'standard') === 'standard' &&
          (s.status === 'running' || s.status === 'needs_permission'),
      ).length,
    [sessions, activeProjectId],
  );

  // taskViews is already fetched scoped to activeProjectId + activeBoardId;
  // both are listed in the dep array to make the milestone scope explicit.
  const autoLaunchQueuedCount = useMemo(
    () =>
      taskViews.filter(
        (t) =>
          t.displayStatus === 'ready' &&
          t.taskType === '💻 Code' &&
          !t.blocked &&
          !t.pauseReason,
      ).length,
    [taskViews, activeProjectId, activeBoardId],
  );

  // Keyboard navigation: sorted active sessions (same order as SessionGrid)
  const kbSortedSessions = [...filteredSessions].sort((a, b) => {
    const statusOrder: Record<string, number> = {
      needs_permission: 0,
      running: 1,
      starting: 2,
      done: 3,
      error: 3,
      killed: 3,
    };
    const rank = (statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99);
    if (rank !== 0) return rank;
    return (b.started_at ?? 0) - (a.started_at ?? 0);
  });
  const keyboardHighlightedId =
    selectedSessionIndex >= 0
      ? (kbSortedSessions[selectedSessionIndex]?.sessionId ?? null)
      : null;

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;

  const anyDragging = isDragging;

  useNotifications(
    sessions,
    lastPrReviewEvent,
    lastReviewFailed,
    lastApiOverloadedPaused,
    lastCiBillingBlockedEvent,
  );

  useEffect(() => {
    function onSelectSession(e: Event) {
      const detail = (e as CustomEvent<{ sessionId: string }>).detail;
      if (detail?.sessionId) {
        setTopView('sessions');
        setSelectedId(detail.sessionId);
      }
    }
    function onNavigateToPRs() {
      setTopView('prs');
    }
    window.addEventListener('selectSession', onSelectSession);
    window.addEventListener('navigateToPRs', onNavigateToPRs);
    return () => {
      window.removeEventListener('selectSession', onSelectSession);
      window.removeEventListener('navigateToPRs', onNavigateToPRs);
    };
  }, []);

  useKeyboardShortcuts({
    onOpenDispatch: () => setShowModal(true),
    onDismiss: () => {
      if (showModal) {
        setShowModal(false);
      } else if (selectedTaskId || selectedId) {
        window.history.back();
      } else if (filtersActive) {
        clearFilters();
        searchInputRef.current?.blur();
      } else if (activeView !== 'sessions') {
        setActiveView('sessions');
      }
    },
    onSelectNext: () =>
      setSelectedSessionIndex((i) =>
        kbSortedSessions.length > 0
          ? i < 0
            ? 0
            : (i + 1) % kbSortedSessions.length
          : -1,
      ),
    onSelectPrev: () =>
      setSelectedSessionIndex((i) =>
        kbSortedSessions.length > 0
          ? i < 0
            ? kbSortedSessions.length - 1
            : (i - 1 + kbSortedSessions.length) % kbSortedSessions.length
          : -1,
      ),
    onConfirmSelection: () => {
      if (keyboardHighlightedId) setSelectedId(keyboardHighlightedId);
    },
    onSwitchView: (view) => {
      if (view === 'tasks') setTopView('tasks');
      else if (view === 'sessions') setTopView('sessions');
      else if (view === 'prs') setTopView('prs');
      else if (view === 'analytics') setTopView('analytics');
      else if (view === 'settings') setTopView('settings');
    },
    onFocusSearch: () => {
      searchInputRef.current?.focus();
    },
  });

  if (setupNeeded) {
    return (
      <SetupWizard
        onComplete={(goToSettings) => {
          setSetupNeeded(false);
          if (goToSettings) setWizardGoToSettings(true);
        }}
      />
    );
  }

  return (
    <div
      className={`${styles.appContainer}${anyDragging ? ` ${styles.dragging}` : ''}`}
    >
      <ErrorBoundary
        name="Header"
        fallback={(_error, reset) => (
          <div className={styles.headerError} role="alert">
            Header failed to render.{' '}
            <button type="button" onClick={reset}>
              Retry
            </button>
          </div>
        )}
      >
        <Header
          projects={projects}
          activeProjectId={activeProjectId}
          onProjectChange={handleProjectChange}
          activeBoardId={activeBoardId}
          onBoardChange={handleBoardChange}
          activeView={topView}
          onViewChange={handleViewChange}
          totalTokens={totalTokens}
          totalCost={totalCost}
          tasks={taskViews}
          incompleteReviewCount={incompleteReviews.length}
          onAutoLaunchToggle={handleAutoLaunchToggle}
          autoLaunchRunningCount={autoLaunchRunningCount}
          autoLaunchCap={autoLaunchCap}
          autoLaunchQueuedCount={autoLaunchQueuedCount}
          autoLaunchPollIntervalMs={autoLaunchPollIntervalMs}
        />
      </ErrorBoundary>
      {updateInfo && (
        <UpdateBanner
          version={updateInfo.version}
          releaseNotesUrl={updateInfo.releaseNotesUrl}
          onDismiss={() => setUpdateInfo(null)}
        />
      )}
      {rateLimitInfo && !rateLimitDismissed && (
        <RateLimitBanner
          resetAt={rateLimitInfo.resetAt}
          onDismiss={() => setRateLimitDismissed(true)}
        />
      )}
      <div className={styles.mainArea}>
        {topView === 'tasks' && (
          <ErrorBoundary name="TasksView">
            <div
              className={`${styles.contentArea}${selectedTaskId ? ` ${styles.contentAreaHasDetail}` : ''}`}
            >
              <div className={styles.leftPanel}>
                <TaskList
                  activeProjectId={activeProjectId}
                  boardId={activeBoardId}
                  selectedTaskId={selectedTaskId}
                  onSelectTask={handleSelectTask}
                  tasks={taskViews}
                  loading={taskViewsLoading}
                  onOptimisticDispatch={handleTaskOptimisticDispatch}
                  onForceRefetch={handleForceRefetch}
                  reviewRefreshTrigger={taskListRefreshTrigger}
                  send={send}
                  project={activeProject}
                />
              </div>

              <div
                className={styles.resizeHandle}
                onMouseDown={handleResizeMouseDown}
              />

              {selectedTaskId && (
                <div
                  className={styles.mobileBackdrop}
                  onClick={() => history.back()}
                  aria-hidden="true"
                  data-testid="task-mobile-backdrop"
                />
              )}

              <div
                className={styles.rightPanel}
                style={isMobile ? undefined : { width: `${detailWidthPct}%` }}
              >
                {(() => {
                  if (!selectedTaskId) {
                    return (
                      <div className={styles.detailPlaceholder}>
                        <p>Select a task to view details</p>
                      </div>
                    );
                  }
                  const selectedTask = taskViews.find(
                    (t) => t.taskId === selectedTaskId,
                  );
                  if (selectedTask) {
                    return (
                      <ErrorBoundary name="TaskDetail">
                        <TaskDetail
                          task={selectedTask}
                          send={send}
                          sessions={sessions}
                          onClose={() => history.back()}
                          projectId={activeProjectId ?? undefined}
                          project={
                            projects.find((p) => p.id === activeProjectId) ??
                            null
                          }
                          isLocalOnly={
                            projects.find((p) => p.id === activeProjectId)
                              ?.gitMode === 'local-only'
                          }
                          autoMergeEnabled={
                            projects.find((p) => p.id === activeProjectId)
                              ?.autoMergeEnabled ?? false
                          }
                          setSessionArchived={setSessionArchived}
                          setSessionFavorited={setSessionFavorited}
                        />
                      </ErrorBoundary>
                    );
                  }
                  if (
                    process.env.NODE_ENV !== 'production' &&
                    !taskViewsLoading
                  ) {
                    console.warn(
                      `[TaskDetail] selectedTaskId "${selectedTaskId}" not found in taskViews (${taskViews.length} tasks). Possible state drift.`,
                    );
                  }
                  return (
                    <div
                      className={styles.detailPlaceholder}
                      data-testid="task-detail-loading"
                    >
                      <p>Loading task details…</p>
                    </div>
                  );
                })()}
              </div>
            </div>
          </ErrorBoundary>
        )}

        {topView === 'sessions' && (
          <ErrorBoundary name="SessionsView">
            <div
              className={`${styles.contentArea}${selectedSession ? ` ${styles.contentAreaHasDetail}` : ''}`}
            >
              <div className={styles.leftPanel}>
                <div className={styles.sessionsHeader}>
                  <span className={styles.sessionsCount}>
                    {runningCount > 0 && <span>{runningCount} running</span>}
                    {runningCount > 0 && doneCount > 0 && <span> · </span>}
                    {doneCount > 0 && <span>{doneCount} done</span>}
                    {runningCount === 0 && doneCount === 0 && (
                      <span>0 sessions</span>
                    )}
                    {readyCount > 0 && <span> · {readyCount} ready</span>}
                    {blockedCount > 0 && (
                      <span style={{ color: 'var(--color-subtext0, #a6adc8)' }}>
                        {' '}
                        · {blockedCount} blocked
                      </span>
                    )}
                  </span>
                  <div className={styles.sessionsActions}>
                    <button
                      type="button"
                      onClick={() =>
                        setActiveView((v) =>
                          v === 'history' ? 'sessions' : 'history',
                        )
                      }
                    >
                      {activeView === 'history' ? 'Hide History' : '🕑 History'}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setActiveView((v) =>
                          v === 'denials' ? 'sessions' : 'denials',
                        )
                      }
                    >
                      {activeView === 'denials' ? 'Hide Denials' : '📋 Denials'}
                    </button>
                    <button type="button" onClick={() => setShowModal(true)}>
                      + New Session
                    </button>
                  </div>
                </div>

                {activeView === 'history' ? (
                  <HistoryGrid onSelect={setSelectedId} />
                ) : activeView === 'denials' ? (
                  <PermissionEventLog />
                ) : (
                  <>
                    <SessionFilterBar
                      searchText={searchText}
                      onSearchChange={setSearchText}
                      statusFilter={statusFilter}
                      onStatusChange={setStatusFilter}
                      tagFilter={tagFilter}
                      onTagChange={setTagFilter}
                      availableTags={availableTags}
                      resultCount={filteredSessions.length}
                      searchInputRef={searchInputRef}
                    />
                    <SessionGrid
                      sessions={filteredSessions}
                      projects={projects}
                      selectedId={selectedId}
                      keyboardSelectedId={keyboardHighlightedId}
                      onSelect={handleSelectSession}
                      synced={synced}
                      onArchiveAll={handleArchiveAll}
                      filtersActive={filtersActive}
                      onClearFilters={clearFilters}
                      onResumeAll={handleResumeAll}
                      onResume={handleResume}
                      onToggleFavorite={(sessionId, favorited) =>
                        setSessionFavorited(sessionId, favorited)
                      }
                      cardPreviewLines={cardPreviewLines}
                      sessionMode={sessionMode}
                    />
                  </>
                )}
              </div>

              <div
                className={styles.resizeHandle}
                onMouseDown={handleResizeMouseDown}
              />

              {selectedSession && (
                <div
                  className={styles.mobileBackdrop}
                  onClick={() => history.back()}
                  aria-hidden="true"
                  data-testid="session-mobile-backdrop"
                />
              )}

              <div
                className={styles.rightPanel}
                style={isMobile ? undefined : { width: `${detailWidthPct}%` }}
              >
                {selectedSession ? (
                  <ErrorBoundary name="SessionDetail">
                    <SessionDetail
                      session={selectedSession}
                      send={send}
                      onClose={() => history.back()}
                      setSessionArchived={setSessionArchived}
                      setSessionFavorited={setSessionFavorited}
                      onDeleted={(sessionId) => {
                        deleteSession(sessionId);
                        window.history.back();
                      }}
                      onResume={handleResume}
                      sessionMode={sessionMode}
                      project={
                        projects.find(
                          (p) => p.id === selectedSession?.project_id,
                        ) ?? null
                      }
                    />
                  </ErrorBoundary>
                ) : (
                  <div className={styles.detailPlaceholder}>
                    <p>Select a session to view details</p>
                  </div>
                )}
              </div>
            </div>
          </ErrorBoundary>
        )}

        {topView === 'prs' && (
          <ErrorBoundary name="PRsView">
            <div className={styles.prFullView}>
              <PRPanel
                activeProjectId={activeProjectId}
                onViewSession={(sessionId) => {
                  setTopView('sessions');
                  setSelectedId(sessionId);
                }}
                onCollapse={() => setTopView('sessions')}
                refreshTrigger={prRefreshTrigger}
                prReviewEvent={lastPrReviewEvent}
                prMergedEvent={lastPrMergedEvent}
                prClosedEvent={lastPrClosedEvent}
                prStateChangedEvent={lastPrStateChangedEvent}
                prMergeabilityChangedEvent={lastPrMergeabilityChangedEvent}
                autofixEvent={lastAutofixEvent}
                reviewStartedEvent={lastReviewStartedEvent}
              />
            </div>
          </ErrorBoundary>
        )}

        {topView === 'analytics' && (
          <ErrorBoundary name="AnalyticsView">
            <div className={styles.analyticsView}>
              <AnalyticsPanel activeProjectId={activeProjectId} />
            </div>
          </ErrorBoundary>
        )}

        {topView === 'settings' && (
          <ErrorBoundary name="SettingsView">
            <div className={styles.settingsView}>
              <Settings
                initialTab={settingsInitialTab}
                onProjectsChanged={handleProjectsChanged}
              />
            </div>
          </ErrorBoundary>
        )}
      </div>

      {showModal && activeProject && activeBoardId && (
        <ErrorBoundary name="DispatchModal" onReset={() => setShowModal(false)}>
          <DispatchModal
            tasks={tasks}
            tasksReady={tasksReady}
            send={send}
            resetTasks={resetTasks}
            project={activeProject}
            milestoneId={activeBoardId}
            onClose={() => setShowModal(false)}
          />
        </ErrorBoundary>
      )}

      <Notifications
        notifications={notifications}
        onDismiss={dismissNotification}
      />
      <ShortcutHint />

      {hasConnectedOnce && connectionState !== 'connected' && (
        <div className={styles.connectionBanner}>Reconnecting...</div>
      )}
      {showReconnected && (
        <div
          className={`${styles.connectionBanner} ${styles.connectionBannerReconnected}`}
        >
          Reconnected
        </div>
      )}

      {needsEnrollment && (
        <EnrollmentFlow
          onEnrolled={() => {
            setNeedsEnrollment(false);
            window.location.reload();
          }}
        />
      )}
    </div>
  );
}
