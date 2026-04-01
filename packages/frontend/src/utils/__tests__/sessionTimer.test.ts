import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { calcElapsedMs, formatDuration, formatElapsed } from '../sessionTimer';
import type { TimerSession } from '../sessionTimer';

function makeSession(overrides: Partial<TimerSession> = {}): TimerSession {
  return {
    status: 'running',
    started_at: undefined,
    ended_at: undefined,
    events: [],
    ...overrides,
  };
}

describe('calcElapsedMs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Terminal sessions — fixed duration ────────────────────────────

  it('returns ended_at - started_at when ended_at is defined', () => {
    const session = makeSession({ status: 'done', started_at: 1000, ended_at: 5000 });
    expect(calcElapsedMs(session)).toBe(4000);
  });

  it('returns last_event_ts - started_at when ended_at is undefined (terminal)', () => {
    const session = makeSession({
      status: 'done',
      started_at: 2000,
      ended_at: undefined,
      events: [
        { timestamp: 2500 },
        { timestamp: 6000 },
      ],
    });
    // Should use last event (6000), not Date.now() (10000)
    expect(calcElapsedMs(session)).toBe(4000);
  });

  it('returns last_event_ts - started_at when ended_at is null (terminal)', () => {
    const session = makeSession({
      status: 'error',
      started_at: 1000,
      ended_at: null,
      events: [{ timestamp: 3000 }],
    });
    expect(calcElapsedMs(session)).toBe(2000);
  });

  it('returns null for terminal session with no ended_at and no events', () => {
    const session = makeSession({ status: 'killed', started_at: 1000, ended_at: null });
    expect(calcElapsedMs(session)).toBeNull();
  });

  it('does NOT use Date.now() for a completed session', () => {
    const session = makeSession({
      status: 'done',
      started_at: 1000,
      ended_at: 5000,
    });
    vi.setSystemTime(99_999); // Far future — should have no effect
    expect(calcElapsedMs(session)).toBe(4000);
  });

  // ── Running sessions — live counter ───────────────────────────────

  it('returns Date.now() - started_at when ended_at is null (running)', () => {
    vi.setSystemTime(10_000);
    const session = makeSession({ status: 'running', started_at: 8000, ended_at: null });
    expect(calcElapsedMs(session)).toBe(2000);
  });

  it('returns Date.now() - started_at when ended_at is undefined (running)', () => {
    vi.setSystemTime(10_000);
    const session = makeSession({ status: 'running', started_at: 7000 });
    expect(calcElapsedMs(session)).toBe(3000);
  });

  // ── Event-timestamp fallbacks ─────────────────────────────────────

  it('falls back to event timestamps for terminal session with no started_at', () => {
    const session = makeSession({
      status: 'done',
      started_at: undefined,
      events: [{ timestamp: 1000 }, { timestamp: 4000 }],
    });
    expect(calcElapsedMs(session)).toBe(3000);
  });

  it('falls back to event timestamps for running session with no started_at', () => {
    vi.setSystemTime(10_000);
    const session = makeSession({
      status: 'running',
      started_at: undefined,
      events: [{ timestamp: 7000 }],
    });
    expect(calcElapsedMs(session)).toBe(3000); // Date.now() - first_event_ts
  });

  it('returns null when no started_at and no events', () => {
    const session = makeSession({ status: 'running' });
    expect(calcElapsedMs(session)).toBeNull();
  });
});

describe('formatDuration', () => {
  it('returns "< 1s" for durations under 1 second', () => {
    expect(formatDuration(0)).toBe('< 1s');
    expect(formatDuration(999)).toBe('< 1s');
  });

  it('formats seconds only when under 1 minute', () => {
    expect(formatDuration(1000)).toBe('1s');
    expect(formatDuration(59_000)).toBe('59s');
  });

  it('formats minutes and seconds for durations of 1 minute or more', () => {
    expect(formatDuration(60_000)).toBe('1m 0s');
    expect(formatDuration(125_000)).toBe('2m 5s');
    expect(formatDuration(3661_000)).toBe('61m 1s');
  });
});

describe('formatElapsed', () => {
  it('returns "—" when elapsed is not computable', () => {
    const session = makeSession({ status: 'running' });
    expect(formatElapsed(session)).toBe('—');
  });

  it('formats a terminal session duration', () => {
    const session = makeSession({ status: 'done', started_at: 0, ended_at: 65_000 });
    expect(formatElapsed(session)).toBe('1m 5s');
  });
});
