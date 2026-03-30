import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import path from 'path';
import dotenv from 'dotenv';
import { runMigrations } from './db/schema';

dotenv.config();
runMigrations();

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
  ws.on('close', () => console.log('[WS] client disconnected'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] listening on port ${PORT}`);
  console.log('[server] LAN access enabled — no authentication');
});

process.on('SIGTERM', () => {
  console.log('[server] SIGTERM received — shutting down');
  server.close(() => process.exit(0));
});
