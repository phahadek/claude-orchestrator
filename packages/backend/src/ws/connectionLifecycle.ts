import { randomUUID } from 'node:crypto';
import { logger } from '../logger';

interface LifecycleSocket {
  on(event: 'close', cb: (code: number, reason: Buffer) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
}

export function attachWsLifecycleLogging(
  ws: LifecycleSocket,
  peer: string | undefined,
  nowFn: () => number = Date.now,
): string {
  const id = randomUUID().slice(0, 8);
  const peerStr = peer ?? 'unknown';
  const connectedAt = nowFn();
  logger.info(`[WS] client connected id=${id} peer=${peerStr}`);
  ws.on('close', (code, reason) => {
    const lifetimeMs = Math.max(0, nowFn() - connectedAt);
    logger.info(
      `[WS] client disconnected id=${id} peer=${peerStr} code=${code} reason=${JSON.stringify(reason?.toString() ?? '')} lifetimeMs=${lifetimeMs}`,
    );
  });
  ws.on('error', (err) => {
    logger.warn(
      `[WS] client error id=${id} peer=${peerStr} message=${err?.message ?? String(err)}`,
    );
  });
  return id;
}
