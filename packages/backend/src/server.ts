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
import { rulesRouter, permissionEventsRouter } from './routes/rules';
import configRouter from './routes/config';
import { sessionsRouter, setBroadcast } from './routes/sessions';
import { createPrsRouter } from './routes/prs';
import { GitHubClient } from './github/GitHubClient';
import { PRReviewService } from './github/PRReviewService';
import { PRSyncJob } from './github/PRSyncJob';
import { getActiveSessions, getEventsBySession, getDenialsBySession } from './db/queries';

runMigrations();

const rawSessionsDir = process.env.SESSIONS_DIR ?? DEFAULT_SESSIONS_DIR;
const sessionsDir = rawSessionsDir.replace(/^~/, os.homedir());
const jsonlReader = new JsonlReader(sessionsDir);

const notionClient = new NotionClient();
const sessionManager = new SessionManager(notionClient);
const githubClient = new GitHubClient();
const prReviewService = new PRReviewService(githubClient, notionClient, sessionManager);

const PORT = parseInt(process.env.PORT ?? '3000');

const app = express();
app.use(express.json());
app.use('/api/rules', rulesRouter);
app.use('/api/permission-events', permissionEventsRouter);
app.use('/api/sessions', sessionsRouter);
app.use('/api', createPrsRouter(githubClient, prReviewService, sessionManager));
app.use('/api', configRouter);
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(msg: ServerMessage) {
  const json = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(json);
  });
}

// Wire broadcast into the sessions router (for PATCH note/tags)
setBroadcast(broadcast);

// Broadcast all session events to every connected WS client
sessionManager.on('message', broadcast);

wss.on('connection', (ws) => {
  console.log('[WS] client connected');

  // Send existing active (non-archived) sessions to the new client so the UI populates on load
  for (const s of getActiveSessions()) {
    const tags = s.tags ? (() => { try { return JSON.parse(s.tags) as string[]; } catch { return undefined; } })() : undefined;
    ws.send(JSON.stringify({
      type: 'session_started',
      sessionId: s.session_id,
      taskName: s.notion_task_url ?? s.session_id.slice(0, 8),
      notionTaskUrl: s.notion_task_url ?? '',
      ...(s.started_at != null && { started_at: s.started_at }),
      ...(s.ended_at != null && { ended_at: s.ended_at }),
      archived: s.archived === 1,
      project_id: s.project_id,
      sessionType: s.session_type,
      note: s.note ?? null,
      tags,
    } satisfies ServerMessage));
    ws.send(JSON.stringify({
      type: 'session_status',
      sessionId: s.session_id,
      status: s.status,
    } satisfies ServerMessage));

    // Send stored events so the transcript populates
    for (const ev of getEventsBySession(s.session_id)) {
      ws.send(JSON.stringify({
        type: 'session_event',
        sessionId: s.session_id,
        eventType: ev.event_type as 'text' | 'tool_use' | 'tool_result' | 'system' | 'user_message',
        content: ev.payload,
      } satisfies ServerMessage));
    }

    // Send stored permission denials so SessionDetail shows them after reconnect
    const denials = getDenialsBySession(s.session_id);
    if (denials.length > 0) {
      ws.send(JSON.stringify({
        type: 'permission_denials',
        sessionId: s.session_id,
        denials: denials.map((d) => ({
          tool_name: d.tool_name,
          tool_use_id: d.tool_use_id,
          tool_input: JSON.parse(d.tool_input) as Record<string, unknown>,
        })),
      } satisfies ServerMessage));
    }
  }

  ws.on('message', (data) => handleMessage(ws, data.toString(), sessionManager, notionClient));
  ws.on('close', () => console.log('[WS] client disconnected'));
});

jsonlReader.importAll().then(async () => {
  const prSyncJob = new PRSyncJob(githubClient);
  await prSyncJob.run().catch((err: unknown) =>
    console.warn('[server] PR sync failed (check GITHUB_TOKEN):', (err as Error).message)
  );

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
