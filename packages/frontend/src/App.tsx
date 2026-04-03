import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { ConnectionState } from './hooks/useWebSocket';
import { useSessionStore } from './hooks/useSessionStore';
import { useWebSocket } from './hooks/useWebSocket';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useNotifications } from './hooks/useNotifications';
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
import { Notifications } from './components/Notifications';
import { ShortcutHint } from './components/ShortcutHint';
import { SessionFilterBar } from './components/SessionFilterBar';
import type { NotificationItem } from './components/Notifications';
import type { ClientMessage, ServerMessage } from '@claude-dashboard/backend/src/ws/types';
import type { ProjectConfig } from '@claude-dashboard/backend/src/config';
import type { TaskView } from '@claude-dashboard/backend/src/routes/tasks';
import styles from './App.module.css';

const DEFAULT_DETAIL_WIDTH = 40;
const MIN_DETAIL_WIDTH_PCT = 20;
const MAX_DETAIL_WIDTH_PCT = 80;
const MIN_LEFT_PANEL_PX = 300;
const MIN_RIGHT_PANEL_PX = 300;

const ACTIVE_PROJECT_KEY = 'activeProjectId';
const ACTIVE_MILESTONE_KEY_PREFIX = 'activeMilestone_';

function getMilestoneKey(projectId: string) {
  return `${ACTIVE_MILESTONE_KEY_PREFIX}${projectId}`;
}

function getDefaultBoardId(project: ProjectConfig): string {
  return project.boards?.[0]?.id ?? project.boardId;
}

function resolveActiveBoardId(project: ProjectConfig): string {
  const stored = localStorage.getItem(getMilestoneKey(project.id));
  const boards = project.boards ?? [];
  if (stored && (boards.length === 0 || boards.some((b) => b.id === stored))) {
    return stored;
  }
  return getDefaultBoardId(project);
}

export default function App() {
  const { sessions, tasks, tasksReady, synced, readyCount, blockedCount, dispatch, resetTasks, deleteSession, setSessionArchived, setSessionFavorited, prRefreshTrigger, lastPrReviewEvent, incompleteReviews, lastTaskUpdate, taskListRefreshTrigger } = useSessionStore();
  const [projects, setProjects] = useState<ProjectConfig[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const activeProjectIdRef = useRef<string | null>(null);
  const [activeBoardId, setActiveBoardId] = useState<string | null>(null);
  const activeBoardIdRef = useRef<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const { send, connectionState } = useWebSocket(dispatch, (sendNow: (msg: ClientMessage) => void) => {
    // Called each time the WS (re)connects — fetch tasks if projectId is already known
    if (activeProjectIdRef.current) {
      sendNow({ type: 'fetch_tasks', projectId: activeProjectIdRef.current, boardId: activeBoardIdRef.current ?? undefined });
    }
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [activeView, setActiveView] = useState<'sessions' | 'history' | 'denials'>('sessions');
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const notifiedRef = useRef<Set<string>>(new Set());
  const [showReconnected, setShowReconnected] = useState(false);
  const hasConnectedOnce = useRef(false);
  const prevConnectionState = useRef<ConnectionState>('disconnected');

  const [cardPreviewLines, setCardPreviewLines] = useState<number>(3);
  const [planTokenCap, setPlanTokenCap] = useState<number>(0);

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
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskViews, setTaskViews] = useState<TaskView[]>([]);
  const settingsInitialTab = 'general' as const;


  useEffect(() => {
    activeBoardIdRef.current = activeBoardId;
  }, [activeBoardId]);

  useEffect(() => {
    detailWidthRef.current = detailWidthPct;
  }, [detailWidthPct]);

  useEffect(() => {
    if (connectionState === 'connected') {
      if (hasConnectedOnce.current) {
        setShowReconnected(true);
        const timer = setTimeout(() => setShowReconnected(false), 3000);
        return () => clearTimeout(timer);
      }
      hasConnectedOnce.current = true;
    }
    prevConnectionState.current = connectionState;
  }, [connectionState]);

  const dismissNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const handleArchiveAll = useCallback(async () => {
    await fetch('/api/sessions/archive-finished', { method: 'POST' });
    for (const s of sessions) {
      if (!s.archived && ['done', 'error', 'killed'].includes(s.status)) {
        setSessionArchived(s.sessionId, true);
      }
    }
  }, [sessions, setSessionArchived]);

  const RESUME_MESSAGE = "Limits have reset. Continue where you left off.";

  const handleResume = useCallback((sessionId: string) => {
    send({ type: 'send_message', sessionId, message: RESUME_MESSAGE });
  }, [send]);

  const handleResumeAll = useCallback(() => {
    for (const s of sessions) {
      if (!s.archived && s.isRateLimited) {
        send({ type: 'send_message', sessionId: s.sessionId, message: RESUME_MESSAGE });
      }
    }
  }, [sessions, send]);

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((s: Record<string, string>) => {
        const lines = Number(s.card_preview_lines);
        if (lines > 0) setCardPreviewLines(lines);
        const cap = Number(s.plan_token_cap);
        if (cap > 0) setPlanTokenCap(cap);
      })
      .catch(() => {/* keep default */});
  }, []);

  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((loaded: ProjectConfig[]) => {
        if (loaded.length === 0) return;
        setProjects(loaded);

        // Restore from localStorage, validate against current project list
        const stored = localStorage.getItem(ACTIVE_PROJECT_KEY);
        const validProjectId = stored && loaded.some((p) => p.id === stored) ? stored : loaded[0].id;
        const project = loaded.find((p) => p.id === validProjectId)!;
        const boardId = resolveActiveBoardId(project);

        activeProjectIdRef.current = validProjectId;
        activeBoardIdRef.current = boardId;
        setActiveProjectId(validProjectId);
        setActiveBoardId(boardId);
        send({ type: 'fetch_tasks', projectId: validProjectId, boardId });
      })
      .catch(() => {/* leave projects empty — DispatchModal handles the empty case */});
  }, []);

  const handleProjectChange = useCallback((id: string) => {
    const project = projects.find((p) => p.id === id);
    const boardId = project ? resolveActiveBoardId(project) : null;
    localStorage.setItem(ACTIVE_PROJECT_KEY, id);
    activeProjectIdRef.current = id;
    activeBoardIdRef.current = boardId;
    setActiveProjectId(id);
    setActiveBoardId(boardId);
    send({ type: 'fetch_tasks', projectId: id, boardId: boardId ?? undefined });
  }, [send, projects]);

  const handleBoardChange = useCallback((boardId: string) => {
    if (!activeProjectIdRef.current) return;
    localStorage.setItem(getMilestoneKey(activeProjectIdRef.current), boardId);
    activeBoardIdRef.current = boardId;
    setActiveBoardId(boardId);
    send({ type: 'fetch_tasks', projectId: activeProjectIdRef.current, boardId });
  }, [send]);

  // Fetch TaskView list whenever tasks are ready, project/board changes, or a review session starts
  useEffect(() => {
    if (!activeProjectId) return;
    const params = new URLSearchParams({ projectId: activeProjectId });
    if (activeBoardId) params.set('boardId', activeBoardId);
    fetch(`/api/tasks/active?${params}`)
      .then((r) => r.ok ? r.json() as Promise<TaskView[]> : Promise.resolve([]))
      .then(setTaskViews)
      .catch(() => {/* non-critical */});
  }, [activeProjectId, activeBoardId, tasksReady, taskListRefreshTrigger]);

  useEffect(() => {
    for (const session of sessions) {
      if (
        (session.status === 'done' || session.status === 'error') &&
        !session.archived &&
        !notifiedRef.current.has(session.sessionId)
      ) {
        notifiedRef.current.add(session.sessionId);
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
      { id: notifId, message, status: 'review', onClick: () => setTopView('prs') },
    ]);
    setTimeout(() => dismissNotification(notifId), 10000);
  }, [lastPrReviewEvent, dismissNotification]);

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);

    const onMove = (ev: MouseEvent) => {
      const w = window.innerWidth;
      const pct = 100 - ((ev.clientX / w) * 100);
      // Left panel must be at least 300px or 25%, whichever is larger
      const leftMinPct = Math.max(25, (MIN_LEFT_PANEL_PX / w) * 100);
      // Right panel must be at least 300px or 20%, whichever is larger
      const rightMinPct = Math.max(MIN_DETAIL_WIDTH_PCT, (MIN_RIGHT_PANEL_PX / w) * 100);
      const maxDetailPct = Math.min(MAX_DETAIL_WIDTH_PCT, 100 - leftMinPct);
      const clamped = Math.min(maxDetailPct, Math.max(rightMinPct, pct));
      detailWidthRef.current = clamped;
      setDetailWidthPct(clamped);
    };

    const onUp = () => {
      setIsDragging(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      localStorage.setItem('sessionDetailWidth', String(Math.round(detailWidthRef.current)));
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
        return r.json() as Promise<{ session: any; events: any[] }>;
      })
      .then(({ session, events }) => {
        dispatch({
          type: 'session_started',
          sessionId: session.session_id,
          taskName: session.notion_task_url ?? session.session_id.slice(0, 8),
          notionTaskUrl: session.notion_task_url ?? '',
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
      .catch((err) => console.error('[App] failed to load archived session events:', err));
  }, [selectedId]);

  // Fetch session events for the selected task's code and review sessions if not yet in store.
  // Mirrors the archived-session fetch for the Sessions tab so TaskDetail always has live or
  // historical transcript data regardless of whether the session was started before page load.
  const fetchedTaskSessionsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!selectedTaskId) return;
    const task = taskViews.find((t) => t.taskId === selectedTaskId);
    if (!task) return;

    const sessionIds: string[] = [];
    if (task.codeSession?.sessionId) sessionIds.push(task.codeSession.sessionId);
    if (task.review?.sessionId) sessionIds.push(task.review.sessionId);

    for (const sessionId of sessionIds) {
      if (fetchedTaskSessionsRef.current.has(sessionId)) continue;
      if (sessions.find((s) => s.sessionId === sessionId)) continue;
      fetchedTaskSessionsRef.current.add(sessionId);
      fetch(`/api/sessions/${sessionId}/events`)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json() as Promise<{ session: any; events: any[] }>;
        })
        .then(({ session, events }) => {
          dispatch({
            type: 'session_started',
            sessionId: session.session_id,
            taskName: session.notion_task_url ?? session.session_id.slice(0, 8),
            notionTaskUrl: session.notion_task_url ?? '',
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
        .catch((err) => console.error('[App] failed to load task session events:', err));
    }
  }, [selectedTaskId, taskViews]);

  const selectedSession = selectedId != null
    ? (sessions.find((s) => s.sessionId === selectedId) ?? null)
    : null;

  const filteredSessions = useMemo(() => {
    return sessions
      .filter((s) => !s.archived)
      .filter((s) => !searchText || s.taskName.toLowerCase().includes(searchText.toLowerCase()))
      .filter((s) => !statusFilter || s.status === statusFilter)
      .filter((s) => !tagFilter || s.tags?.includes(tagFilter))
      .filter((s) => !activeProjectId || s.project_id === activeProjectId);
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

  const runningCount = filteredSessions.filter((s) => ['running', 'starting', 'needs_permission'].includes(s.status)).length;
  const doneCount = filteredSessions.filter((s) => ['done', 'error', 'killed'].includes(s.status)).length;

  const totalTokens = useMemo(() => {
    return sessions
      .filter((s) => !s.archived && (!activeProjectId || s.project_id === activeProjectId))
      .reduce((sum, s) => sum + (s.totalInputTokens ?? 0) + (s.totalOutputTokens ?? 0), 0);
  }, [sessions, activeProjectId]);

  // Keyboard navigation: sorted active sessions (same order as SessionGrid)
  const kbSortedSessions = [...filteredSessions].sort((a, b) => {
    const statusOrder: Record<string, number> = {
      needs_permission: 0, running: 1, starting: 2, done: 3, error: 3, killed: 3,
    };
    const rank = (statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99);
    if (rank !== 0) return rank;
    return (b.started_at ?? 0) - (a.started_at ?? 0);
  });
  const keyboardHighlightedId = selectedSessionIndex >= 0 ? kbSortedSessions[selectedSessionIndex]?.sessionId ?? null : null;

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;

  const anyDragging = isDragging;

  useNotifications(sessions, lastPrReviewEvent);

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
      } else if (selectedId) {
        setSelectedId(null);
      } else if (filtersActive) {
        clearFilters();
        searchInputRef.current?.blur();
      } else if (activeView !== 'sessions') {
        setActiveView('sessions');
      }
    },
    onSelectNext: () =>
      setSelectedSessionIndex((i) =>
        kbSortedSessions.length > 0 ? (i < 0 ? 0 : (i + 1) % kbSortedSessions.length) : -1,
      ),
    onSelectPrev: () =>
      setSelectedSessionIndex((i) =>
        kbSortedSessions.length > 0
          ? (i < 0 ? kbSortedSessions.length - 1 : (i - 1 + kbSortedSessions.length) % kbSortedSessions.length)
          : -1,
      ),
    onConfirmSelection: () => {
      if (keyboardHighlightedId) setSelectedId(keyboardHighlightedId);
    },
    onSwitchView: (view) => {
      if (view === 'tasks') setTopView('tasks');
      else if (view === 'sessions') setTopView('sessions');
      else if (view === 'prs') setTopView('prs');
      else if (view === 'settings') setTopView('settings');
    },
    onFocusSearch: () => {
      searchInputRef.current?.focus();
    },
  });

  return (
    <div className={`${styles.appContainer}${anyDragging ? ` ${styles.dragging}` : ''}`}>
      <Header
        projects={projects}
        activeProjectId={activeProjectId}
        onProjectChange={handleProjectChange}
        activeBoardId={activeBoardId}
        onBoardChange={handleBoardChange}
        activeView={topView}
        onViewChange={handleViewChange}
        totalTokens={totalTokens}
        planTokenCap={planTokenCap}
        tasks={tasks}
        incompleteReviewCount={incompleteReviews.length}
      />
      <div className={styles.mainArea}>
        {topView === 'tasks' && (
          <div className={styles.contentArea}>
            <div className={styles.leftPanel}>
              <TaskList
                activeProjectId={activeProjectId}
                boardId={activeBoardId}
                selectedTaskId={selectedTaskId}
                onSelectTask={setSelectedTaskId}
                lastTaskUpdate={lastTaskUpdate}
                reviewRefreshTrigger={taskListRefreshTrigger}
                send={send}
                project={activeProject}
              />
            </div>

            <div
              className={styles.resizeHandle}
              onMouseDown={handleResizeMouseDown}
            />

            <div className={styles.rightPanel} style={{ width: `${detailWidthPct}%` }}>
              {selectedTaskId && taskViews.find((t) => t.taskId === selectedTaskId) ? (
                <TaskDetail
                  task={taskViews.find((t) => t.taskId === selectedTaskId)!}
                  send={send}
                  sessions={sessions}
                  onClose={() => setSelectedTaskId(null)}
                />
              ) : (
                <div className={styles.detailPlaceholder}>
                  <p>Select a task to view details</p>
                </div>
              )}
            </div>
          </div>
        )}

        {topView === 'sessions' && (
          <div className={styles.contentArea}>
            <div className={styles.leftPanel}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                <span style={{ flex: 1 }}>
                  {runningCount > 0 && <span>{runningCount} running</span>}
                  {runningCount > 0 && doneCount > 0 && <span> · </span>}
                  {doneCount > 0 && <span>{doneCount} done</span>}
                  {runningCount === 0 && doneCount === 0 && <span>0 sessions</span>}
                  {readyCount > 0 && <span> · {readyCount} ready</span>}
                  {blockedCount > 0 && <span style={{ color: 'var(--color-subtext0, #a6adc8)' }}> · {blockedCount} blocked</span>}
                </span>
                <button type="button" onClick={() => setActiveView((v) => v === 'history' ? 'sessions' : 'history')}>
                  {activeView === 'history' ? 'Hide History' : '🕑 History'}
                </button>
                <button type="button" onClick={() => setActiveView((v) => v === 'denials' ? 'sessions' : 'denials')}>
                  {activeView === 'denials' ? 'Hide Denials' : '📋 Denials'}
                </button>
                <button type="button" onClick={() => setShowModal(true)}>
                  + New Session
                </button>
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
                    onSelect={setSelectedId}
                    synced={synced}
                    onArchiveAll={handleArchiveAll}
                    filtersActive={filtersActive}
                    onClearFilters={clearFilters}
                    onResumeAll={handleResumeAll}
                    onResume={handleResume}
                    onToggleFavorite={(sessionId, favorited) => setSessionFavorited(sessionId, favorited)}
                    cardPreviewLines={cardPreviewLines}
                    planTokenCap={planTokenCap}
                  />
                </>
              )}
            </div>

            <div
              className={styles.resizeHandle}
              onMouseDown={handleResizeMouseDown}
            />

            <div className={styles.rightPanel} style={{ width: `${detailWidthPct}%` }}>
              {selectedSession ? (
                <SessionDetail
                  session={selectedSession}
                  send={send}
                  planTokenCap={planTokenCap}
                  onClose={() => setSelectedId(null)}
                  onDelete={(sessionId) => {
                    deleteSession(sessionId);
                    setSelectedId(null);
                  }}
                  onArchive={(sessionId) => setSessionArchived(sessionId, true)}
                  onUnarchive={(sessionId) => setSessionArchived(sessionId, false)}
                  onFavorite={(sessionId) => setSessionFavorited(sessionId, true)}
                  onUnfavorite={(sessionId) => setSessionFavorited(sessionId, false)}
                  onResume={handleResume}
                />
              ) : (
                <div className={styles.detailPlaceholder}>
                  <p>Select a session to view details</p>
                </div>
              )}
            </div>
          </div>
        )}

        {topView === 'prs' && (
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
            />
          </div>
        )}

        {topView === 'settings' && (
          <div className={styles.settingsView}>
            <Settings initialTab={settingsInitialTab} projects={projects} />
          </div>
        )}
      </div>

      {showModal && activeProject && (
        <DispatchModal
          tasks={tasks}
          tasksReady={tasksReady}
          send={send}
          resetTasks={resetTasks}
          project={activeProject}
          boardId={activeBoardId ?? undefined}
          onClose={() => setShowModal(false)}
        />
      )}

      <Notifications notifications={notifications} onDismiss={dismissNotification} />
      <ShortcutHint />

      {(hasConnectedOnce.current && connectionState !== 'connected') && (
        <div className={styles.connectionBanner}>
          Reconnecting...
        </div>
      )}
      {showReconnected && (
        <div className={`${styles.connectionBanner} ${styles.connectionBannerReconnected}`}>
          Reconnected
        </div>
      )}
    </div>
  );
}
