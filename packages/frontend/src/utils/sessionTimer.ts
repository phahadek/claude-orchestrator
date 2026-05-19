const TERMINAL_STATUSES = new Set(["done", "error", "killed"]);

export type TimerSession = {
  status: string;
  started_at?: number | null;
  ended_at?: number | null;
  events: { timestamp: number }[];
};

/**
 * Returns elapsed milliseconds for a session, or null if not computable.
 *
 * Terminal sessions (done/error/killed) return a fixed duration:
 *   - ended_at - started_at  (preferred — both are server timestamps)
 *   - last_event_ts - started_at  (fallback when ended_at is absent)
 *   - last_event_ts - first_event_ts  (fallback when started_at also absent)
 *
 * Running sessions return a live duration against Date.now().
 *
 * Never uses Date.now() as the end timestamp for a completed session, which
 * would cause the displayed time to keep growing on every re-render.
 */
export function calcElapsedMs(session: TimerSession): number | null {
  const isTerminal = TERMINAL_STATUSES.has(session.status);

  if (session.started_at != null) {
    if (isTerminal) {
      const endTs = session.ended_at ?? session.events.at(-1)?.timestamp;
      return endTs != null ? endTs - session.started_at : null;
    }
    return Date.now() - session.started_at;
  }

  // No started_at — fall back to event timestamps
  if (session.events.length > 0) {
    const startTs = session.events[0].timestamp;
    const endTs = isTerminal
      ? session.events[session.events.length - 1].timestamp
      : Date.now();
    return endTs - startTs;
  }

  return null;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return "< 1s";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

export function formatElapsed(session: TimerSession): string {
  const ms = calcElapsedMs(session);
  return ms != null ? formatDuration(ms) : "—";
}
