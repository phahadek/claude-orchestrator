import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { ConnectionState } from './hooks/useWebSocket';
import { useSessionStore } from './hooks/useSessionStore';
import { useWebSocket } from './hooks/useWebSocket';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { Header } from './components/Header';
import { SessionGrid } from './components/SessionGrid';
import { HistoryGrid } from './components/HistoryGrid';
import { SessionDetail } from './components/SessionDetail';
import { PRPanel } from './components/PRPanel';
import { DispatchModal } from './components/DispatchModal';
import { PermissionEventLog } from './components/PermissionEventLog';
import { Notifications } from './components/Notifications';
import { ShortcutHint } from './components/ShortcutHint';
import { SessionFilterBar } from './components/SessionFilterBar';
import type { NotificationItem } from './components/Notifications';
import type { ClientMessage } from '@claude-dashboard/backend/src/ws/types';
import type { ProjectConfig } from '@claude-dashboard/backend/src/config';
import styles from './App.module.css';

const DEFAULT_DETAIL_WIDTH = 40;
const MIN_DETAIL_WIDTH = 20;
const MAX_DETAIL_WIDTH = 80;

const DEFAULT_PR_PANEL_HEIGHT = 30;
const MIN_PR_PANEL_HEIGHT = 20;
const MAX_PR_PANEL_HEIGHT = 60;

const ACTIVE_PROJECT_KEY = 'activeProjectId';

export default function App() {
  const { sessions, tasks, tasksReady, synced, readyCount, blockedCount, dispatch, resetTasks, deleteSession, setSessionArchived, setSessionFavorited, dismissedDenialIds, dismissDenial, dismissAllDenials } = useSessionStore();
  const [projects, setProjects] = useState<ProjectConfig[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const activeProjectIdRef = useRef<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const { send, connectionState } = useWebSocket(dispatch, (sendNow: (msg: ClientMessage) => void) => {
    // Called each time the WS (re)connects — fetch tasks if projectId is already known
    if (activeProjectIdRef.current) {
      sendNow({ type: 'fetch_tasks', projectId: activeProjectIdRef.current });
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

  const [detailWidthPct, setDetailWidthPct] = useState<number>(() => {
    const saved = localStorage.getItem('sessionDetailWidth');
    if (saved) {
      const n = Number(saved);
      if (n >= MIN_DETAIL_WIDTH && n <= MAX_DETAIL_WIDTH) return n;
    }
    return DEFAULT_DETAIL_WIDTH;
  });
  const [isDragging, setIsDragging] = useState(false);
  const detailWidthRef = useRef(detailWidthPct);

  const [prPanelVisible, setPrPanelVisible] = useState<boolean>(() => {
    const saved = localStorage.getItem('prPanelVisible');
    return saved !== null ? saved === 'true' : true;
  });

  const [prPanelHeightPct, setPrPanelHeightPct] = useState<number>(() => {
    const saved = localStorage.getItem('prPanelHeightPct');
    if (saved) {
      const n = Number(saved);
      if (n >= MIN_PR_PANEL_HEIGHT && n <= MAX_PR_PANEL_HEIGHT) return n;
    }
    return DEFAULT_PR_PANEL_HEIGHT;
  });
  const [isPrDragging, setIsPrDragging] = useState(false);
  const prPanelHeightRef = useRef(prPanelHeightPct);

  useEffect(() => {
    detailWidthRef.current = detailWidthPct;
  }, [detailWidthPct]);

  useEffect(() => {
    prPanelHeightRef.current = prPanelHeightPct;
  }, [prPanelHeightPct]);

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
    fetch('/api/config')
      .then((r) => r.json())
      .then((loaded: ProjectConfig[]) => {
        if (loaded.length === 0) return;
        setProjects(loaded);

        // Restore from localStorage, validate against current project list
        const stored = localStorage.getItem(ACTIVE_PROJECT_KEY);
        const valid = stored && loaded.some((p) => p.id === stored) ? stored : loaded[0].id;

        activeProjectIdRef.current = valid;
        setActiveProjectId(valid);
        send({ type: 'fetch_tasks', projectId: valid });
      })
      .catch(() => {/* leave projects empty — DispatchModal handles the empty case */});
  }, []);

  const handleProjectChange = useCallback((id: string) => {
    localStorage.setItem(ACTIVE_PROJECT_KEY, id);
    activeProjectIdRef.current = id;
    setActiveProjectId(id);
    send({ type: 'fetch_tasks', projectId: id });
  }, [send]);

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

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);

    const onMove = (ev: MouseEvent) => {
      const pct = 100 - ((ev.clientX / window.innerWidth) * 100);
      const clamped = Math.min(MAX_DETAIL_WIDTH, Math.max(MIN_DETAIL_WIDTH, pct));
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

  const handlePrResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsPrDragging(true);

    const onMove = (ev: MouseEvent) => {
      const pct = ((window.innerHeight - ev.clientY) / window.innerHeight) * 100;
      const clamped = Math.min(MAX_PR_PANEL_HEIGHT, Math.max(MIN_PR_PANEL_HEIGHT, pct));
      prPanelHeightRef.current = clamped;
      setPrPanelHeightPct(clamped);
    };

    const onUp = () => {
      setIsPrDragging(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      localStorage.setItem('prPanelHeightPct', String(Math.round(prPanelHeightRef.current)));
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  const togglePrPanel = useCallback(() => {
    setPrPanelVisible((v) => {
      const next = !v;
      localStorage.setItem('prPanelVisible', String(next));
      return next;
    });
  }, []);

  const [selectedSessionIndex, setSelectedSessionIndex] = useState(-1);

  // Reset keyboard selection index when active project changes
  useEffect(() => {
    setSelectedSessionIndex(-1);
  }, [activeProjectId]);

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

  const anyDragging = isDragging || isPrDragging;

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
      if (view === 'sessions') setActiveView('sessions');
      else if (view === 'prs') togglePrPanel();
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
        prPanelVisible={prPanelVisible}
        onTogglePrPanel={togglePrPanel}
      />
      <div className={styles.mainArea}>
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
                dismissedDenials={dismissedDenialIds.get(selectedSession.sessionId) ?? new Set()}
                onDismissDenial={(toolUseId) => dismissDenial(selectedSession.sessionId, toolUseId)}
                onDismissAllDenials={(toolUseIds) => dismissAllDenials(selectedSession.sessionId, toolUseIds)}
              />
            ) : (
              <div className={styles.detailPlaceholder}>
                <p>Select a session to view details</p>
              </div>
            )}
          </div>
        </div>

        {prPanelVisible && (
          <>
            <div
              className={styles.horizontalResizeHandle}
              onMouseDown={handlePrResizeMouseDown}
            />
            <div
              className={styles.prPanelSection}
              style={{ height: `${prPanelHeightPct}vh` }}
            >
              <PRPanel
                activeProjectId={activeProjectId}
                onFixSession={(sessionId) => {
                  setActiveView('sessions');
                  setSelectedId(sessionId);
                }}
                onCollapse={togglePrPanel}
              />
            </div>
          </>
        )}
      </div>

      {showModal && activeProject && (
        <DispatchModal
          tasks={tasks}
          tasksReady={tasksReady}
          send={send}
          resetTasks={resetTasks}
          project={activeProject}
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
