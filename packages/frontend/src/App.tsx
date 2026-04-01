import { useState, useEffect, useRef, useCallback } from 'react';
import { useSessionStore } from './hooks/useSessionStore';
import { useWebSocket } from './hooks/useWebSocket';
import { SessionGrid } from './components/SessionGrid';
import { SessionDetail } from './components/SessionDetail';
import { DispatchModal } from './components/DispatchModal';
import { PermissionRules } from './components/PermissionRules';
import { Notifications } from './components/Notifications';
import type { NotificationItem } from './components/Notifications';
import type { ClientMessage } from '@claude-dashboard/backend/src/ws/types';

export default function App() {
  const { sessions, tasks, tasksReady, synced, dispatch, deleteSession } = useSessionStore();
  const boardIdRef = useRef('');
  const { send } = useWebSocket(dispatch, (sendNow: (msg: ClientMessage) => void) => {
    // Called each time the WS (re)connects — fetch tasks if boardId is already known
    if (boardIdRef.current) {
      sendNow({ type: 'fetch_tasks', boardId: boardIdRef.current });
    }
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [boardId, setBoardId] = useState('');
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const notifiedRef = useRef<Set<string>>(new Set());

  const dismissNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((projects: { boardId: string }[]) => {
        if (projects.length > 0) {
          boardIdRef.current = projects[0].boardId;
          setBoardId(projects[0].boardId);
          // If WS is already open by the time config arrives, send immediately
          send({ type: 'fetch_tasks', boardId: projects[0].boardId });
        }
      })
      .catch(() => {/* leave boardId empty — DispatchModal handles the empty case */});
  }, []);

  useEffect(() => {
    for (const session of sessions) {
      if (
        (session.status === 'done' || session.status === 'error') &&
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

  const selectedSession = selectedId != null
    ? (sessions.find((s) => s.sessionId === selectedId) ?? null)
    : null;

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
          <h1 style={{ margin: 0, flex: 1 }}>Claude Code Dashboard</h1>
          <button type="button" onClick={() => setShowRules((v) => !v)}>
            {showRules ? 'Hide Rules' : '⚙️ Rules'}
          </button>
          <button type="button" onClick={() => setShowModal(true)}>
            + New Session
          </button>
        </div>
        <p>{sessions.length} sessions · {tasks.length} tasks ready</p>

        {showRules ? (
          <PermissionRules />
        ) : (
          <SessionGrid
            sessions={sessions}
            selectedId={selectedId}
            onSelect={setSelectedId}
            synced={synced}
          />
        )}
      </div>

      {selectedSession && !showRules && (
        <div style={{ width: '480px', flexShrink: 0 }}>
          <SessionDetail
            session={selectedSession}
            send={send}
            onClose={() => setSelectedId(null)}
            onDelete={(sessionId) => {
              deleteSession(sessionId);
              setSelectedId(null);
            }}
          />
        </div>
      )}

      {showModal && (
        <DispatchModal
          tasks={tasks}
          tasksReady={tasksReady}
          send={send}
          boardId={boardId}
          onClose={() => setShowModal(false)}
        />
      )}

      <Notifications notifications={notifications} onDismiss={dismissNotification} />
    </div>
  );
}
