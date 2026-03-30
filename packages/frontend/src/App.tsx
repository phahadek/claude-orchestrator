import { useState } from 'react';
import { useSessionStore } from './hooks/useSessionStore';
import { useWebSocket } from './hooks/useWebSocket';
import { SessionGrid } from './components/SessionGrid';
import { SessionDetail } from './components/SessionDetail';

export default function App() {
  const { sessions, tasks, dispatch } = useSessionStore();
  const { send } = useWebSocket(dispatch);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selectedSession = selectedId != null
    ? (sessions.find((s) => s.sessionId === selectedId) ?? null)
    : null;

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
        <h1>Claude Code Dashboard</h1>
        <p>{sessions.length} sessions · {tasks.length} tasks ready</p>
        <button type="button" onClick={() => send({ type: 'fetch_tasks', boardId: '' })}>
          Fetch tasks
        </button>
        <SessionGrid
          sessions={sessions}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      </div>
      {selectedSession && (
        <div style={{ width: '480px', flexShrink: 0 }}>
          <SessionDetail
            session={selectedSession}
            send={send}
            onClose={() => setSelectedId(null)}
          />
        </div>
      )}
    </div>
  );
}
