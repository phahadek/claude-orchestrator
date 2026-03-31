import './bootstrap';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import http from 'http';
import path from 'path';
import os from 'os';
import { runMigrations } from './db/schema';
import { SessionManager } from './session/SessionManager';
import { NotionClient } from './notion/NotionClient';
import { handleMessage } from './ws/router';
import { JsonlReader, DEFAULT_SESSIONS_DIR } from './session/JsonlReader';
import type { ServerMessage } from './ws/types';
import { rulesRouter } from './routes/rules';
import configRouter from './routes/config';
import { getAllSessions } from './db/queries';

runMigrations();

const rawSessionsDir = process.env.SESSIONS_DIR ?? DEFAULT_SESSIONS_DIR;
const sessionsDir = rawSessionsDir.replace(/^~/, os.homedir());
const jsonlReader = new JsonlReader(sessionsDir);

const notionClient = new NotionClient();
const sessionManager = new SessionManager(notionClient);

const PORT = parseInt(process.env.PORT ?? '3000');

const app = express();
app.use(express.json());
app.use('/api/rules', rulesRouter);
app.use('/api', configRouter);
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Broadcast all session events to every connected WS client
sessionManager.on('message', (msg: ServerMessage) => {
  const json = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(json);
  });
});

wss.on('connection', (ws) => {
  console.log('[WS] client connected');

  // Send existing sessions to the new client so the UI populates on load
  for (const s of getAllSessions()) {
    ws.send(JSON.stringify({
      type: 'session_started',
      sessionId: s.session_id,
      taskName: s.notion_task_url ?? s.session_id.slice(0, 8),
      notionTaskUrl: s.notion_task_url ?? '',
      ...(s.started_at != null && { started_at: s.started_at }),
      ...(s.ended_at != null && { ended_at: s.ended_at }),
    } satisfies ServerMessage));
    ws.send(JSON.stringify({
      type: 'session_status',
      sessionId: s.session_id,
      status: s.status,
    } satisfies ServerMessage));
  }

  ws.on('message', (data) => handleMessage(ws, data.toString(), sessionManager, notionClient));
  ws.on('close', () => console.log('[WS] client disconnected'));
});

jsonlReader.importAll().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] listening on port ${PORT}`);
    console.log('[server] LAN access enabled — no authentication');
  });
}).catch((err: unknown) => {
  console.error('[server] JSONL import failed:', err);
  process.exit(1);
});

process.on('SIGTERM', async () => {
  console.log('[server] SIGTERM received — shutting down');
  await sessionManager.shutdownAll();
  server.close(() => process.exit(0));
});
