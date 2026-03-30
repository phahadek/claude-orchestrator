import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import http from 'http';
import path from 'path';
import dotenv from 'dotenv';
import { runMigrations } from './db/schema';
import { SessionManager } from './session/SessionManager';
import { NotionClient } from './notion/NotionClient';
import { handleMessage } from './ws/router';
import { JsonlReader, DEFAULT_SESSIONS_DIR } from './session/JsonlReader';
import type { ServerMessage } from './ws/types';
import configRouter from './routes/config';

dotenv.config();
runMigrations();

const sessionsDir = process.env.SESSIONS_DIR ?? DEFAULT_SESSIONS_DIR;
const jsonlReader = new JsonlReader(sessionsDir);

const notionClient = new NotionClient();
const sessionManager = new SessionManager(notionClient);

const PORT = parseInt(process.env.PORT ?? '3000');

const app = express();
app.use(express.json());
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
