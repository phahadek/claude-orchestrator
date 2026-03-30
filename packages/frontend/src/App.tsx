import { useSessionStore } from './hooks/useSessionStore';
import { useWebSocket } from './hooks/useWebSocket';

export default function App() {
  const { sessions, tasks, dispatch } = useSessionStore();
  const { send } = useWebSocket(dispatch);

  return (
    <div>
      <h1>Claude Code Dashboard</h1>
      <p>{sessions.length} sessions · {tasks.length} tasks ready</p>
      <button type="button" onClick={() => send({ type: 'fetch_tasks', boardId: '' })}>
        Fetch tasks
      </button>
    </div>
  );
}
