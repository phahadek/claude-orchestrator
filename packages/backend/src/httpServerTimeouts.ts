import type http from 'http';
import type express from 'express';

// Chromium ignores the Keep-Alive header and holds idle sockets ~300 s, so the
// server's real idle timeout must exceed that to never close first.
export const KEEP_ALIVE_ACTUAL_MS = 310_000;
export const KEEP_ALIVE_ADVERTISED_S = 300;
const REQUEST_TIMEOUT_MS = 300_000;

export function applyHttpServerTimeouts(
  server: http.Server,
  keepAliveMs: number = KEEP_ALIVE_ACTUAL_MS,
): void {
  server.keepAliveTimeout = keepAliveMs;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = Math.min(60_000, REQUEST_TIMEOUT_MS);
}

// Node 20 can only advertise keepAliveTimeout itself; setting Connection
// explicitly makes Node skip its own Keep-Alive header so ours is the only one.
export function advertiseKeepAlive(
  advertisedSeconds: number = KEEP_ALIVE_ADVERTISED_S,
): express.RequestHandler {
  return (_req, res, next) => {
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Keep-Alive', `timeout=${advertisedSeconds}`);
    next();
  };
}
