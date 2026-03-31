import { useState, useEffect } from 'react';
import { useSessionStore } from './hooks/useSessionStore';
import { useWebSocket } from './hooks/useWebSocket';
import { SessionGrid } from './components/SessionGrid';
import { SessionDetail } from './components/SessionDetail';
import { DispatchModal } from './components/DispatchModal';
import { PermissionRules } from './components/PermissionRules';

export default function App() {
  const { sessions, tasks, tasksReady, dispatch, deleteSession } = useSessionStore();
  const { send } = useWebSocket(dispatch);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [boardId, setBoardId] = useState('');

  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((projects: { boardId: string }[]) => {
        if (projects.length > 0) setBoardId(projects[0].boardId);
      })
      .catch(() => {/* leave boardId empty — DispatchModal handles the empty case */});
  }, []);

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
    </div>
  );
}
