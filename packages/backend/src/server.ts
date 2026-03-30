import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import path from 'path';
import dotenv from 'dotenv';
import { runMigrations } from './db/schema';
import { SessionManager } from './session/SessionManager';
import { NotionClient } from './notion/NotionClient';
import { handleMessage } from './ws/router';
import { JsonlReader, DEFAULT_SESSIONS_DIR } from './session/JsonlReader';

dotenv.config();
runMigrations();

const sessionsDir = process.env.SESSIONS_DIR ?? DEFAULT_SESSIONS_DIR;
const jsonlReader = new JsonlReader(sessionsDir);

const sessionManager = new SessionManager();
const notionClient = new NotionClient();

const PORT = parseInt(process.env.PORT ?? '3000');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

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
