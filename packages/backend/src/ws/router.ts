import { WebSocket } from 'ws';
import { ClientMessage } from './types';
import { SessionManager } from '../session/SessionManager';
import { NotionClient } from '../notion/NotionClient';

export function handleMessage(
  ws: WebSocket,
  raw: string,
  sessions: SessionManager,
  notion: NotionClient
): void {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw) as ClientMessage;
  } catch {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
    return;
  }

  switch (msg.type) {
    case 'dispatch':
      if (!Array.isArray(msg.tasks)) {
        ws.send(JSON.stringify({ type: 'error', message: 'dispatch requires tasks array' }));
        break;
      }
      msg.tasks.forEach((t) => sessions.start(t.taskUrl, t.projectContextUrl, t.taskType));
      break;
    case 'approve':
      // The claude CLI --print mode does not support mid-session permission approval.
      // Tools are pre-approved via --allowedTools at spawn time. This is a no-op.
      console.log(`[router] approve ignored — CLI does not support mid-session approval`);
      break;
    case 'deny':
      console.log(`[router] deny ignored — CLI does not support mid-session denial`);
      break;
    case 'send_message':
      sessions.send(msg.sessionId, msg.message);
      break;
    case 'kill':
      sessions.kill(msg.sessionId);
      break;
    case 'end_session':
      sessions.endSession(msg.sessionId);
      break;
    case 'fetch_tasks':
      notion
        .fetchReadyTasks(msg.boardId)
        .then((tasks) => ws.send(JSON.stringify({ type: 'tasks_ready', tasks })))
        .catch((e) => ws.send(JSON.stringify({ type: 'error', message: String(e) })));
      break;
    default: {
      const _exhaustive: never = msg;
      void _exhaustive;
      ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
    }
  }
}
