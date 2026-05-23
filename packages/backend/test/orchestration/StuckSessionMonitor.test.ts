import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../../src/db/db.js', async () => {
  const Database = (await import('better-sqlite3')).default;
  const memDb = new Database(':memory:');
  memDb.pragma('foreign_keys = ON');
  const { applyTestSchema } = await import('../helpers/testDbSchema');
  applyTestSchema(memDb);
  return { db: memDb };
});

import { StuckSessionMonitor } from '../../src/orchestration/StuckSessionMonitor';
import type { SessionManager } from '../../src/session/SessionManager';
import type { ServerMessage } from '../../src/ws/types';
import { runtimeSettings } from '../../src/config';
import { db } from '../../src/db/db.js';

interface MockSessionManager extends SessionManager {
  send: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
}

function makeMockSessionManager(): MockSessionManager {
  const sm = new EventEmitter() as unknown as MockSessionManager;
  sm.send = vi.fn();
  sm.kill = vi.fn().mockResolvedValue(undefined);
  return sm;
}

function fireMessage(sm: SessionManager, msg: ServerMessage): void {
  sm.emit('message', msg);
}

const SESSION_ID = 'sess-1';
const TASK_NAME = 'Refactor auth';
const PR_NUMBER = 42;
const REPO = 'owner/repo';

function insertPR(sessionId: string, prNumber: number, repo: string): void {
  db.prepare(
    `
    INSERT INTO pull_requests
      (pr_number, pr_url, notion_task_id, session_id, repo, state,
       created_at, updated_at, synced_at)
    VALUES
      (@pr_number, @pr_url, NULL, @session_id, @repo, 'open',
       'now', 'now', 'now')
  `,
  ).run({
    pr_number: prNumber,
    pr_url: `https://github.com/${repo}/pull/${prNumber}`,
    session_id: sessionId,
    repo,
  });
}

function sessionStarted(
  sessionId = SESSION_ID,
  taskName = TASK_NAME,
  sessionType: 'standard' | 'review' = 'standard',
): ServerMessage {
  return {
    type: 'session_started',
    sessionId,
    taskName,
    notionTaskUrl: 'https://notion.so/x',
    sessionType,
    started_at: Date.now(),
    totalInputTokens: 0,
    totalOutputTokens: 0,
  } satisfies ServerMessage;
}

beforeEach(() => {
  vi.useFakeTimers();
  db.prepare('DELETE FROM pull_requests').run();
  runtimeSettings.session_notify_threshold_seconds = 60;
  runtimeSettings.session_pause_threshold_seconds = 120;
  runtimeSettings.session_hard_stop_window_seconds = 30;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('StuckSessionMonitor', () => {
  it('starts tracking on session_started for standard sessions', () => {
    const sm = makeMockSessionManager();
    const broadcast = vi.fn();
    const monitor = new StuckSessionMonitor(sm, broadcast);

    fireMessage(sm, sessionStarted());
    expect(monitor.isTracking(SESSION_ID)).toBe(true);
  });

  it('does not track review sessions', () => {
    const sm = makeMockSessionManager();
    const broadcast = vi.fn();
    const monitor = new StuckSessionMonitor(sm, broadcast);

    fireMessage(sm, sessionStarted(SESSION_ID, TASK_NAME, 'review'));
    expect(monitor.isTracking(SESSION_ID)).toBe(false);
  });

  it('fires stuck_session_notified at the notify threshold', () => {
    const sm = makeMockSessionManager();
    const broadcast = vi.fn();
    new StuckSessionMonitor(sm, broadcast);

    fireMessage(sm, sessionStarted());
    vi.advanceTimersByTime(60_000);

    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'stuck_session_notified',
        sessionId: SESSION_ID,
        taskName: TASK_NAME,
      }),
    );
  });

  it('resets the notify timer when a review verdict arrives', () => {
    const sm = makeMockSessionManager();
    const broadcast = vi.fn();
    new StuckSessionMonitor(sm, broadcast);

    fireMessage(sm, sessionStarted());
    insertPR(SESSION_ID, PR_NUMBER, REPO);

    vi.advanceTimersByTime(50_000);
    fireMessage(sm, {
      type: 'review_verdict',
      prNumber: PR_NUMBER,
      repo: REPO,
      verdict: 'needs_changes',
      summary: 'x',
      iteration: 1,
    });

    // Original notify would have fired at +60s; with reset it now fires at +50+60=+110s.
    vi.advanceTimersByTime(20_000); // now at 70s — past original deadline
    expect(broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stuck_session_notified' }),
    );

    vi.advanceTimersByTime(45_000); // now at 115s — past reset deadline of 110s
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stuck_session_notified' }),
    );
  });

  it('injects the pause message and sets pause_reason at the pause threshold', () => {
    const sm = makeMockSessionManager();
    const broadcast = vi.fn();
    new StuckSessionMonitor(sm, broadcast);

    fireMessage(sm, sessionStarted());
    insertPR(SESSION_ID, PR_NUMBER, REPO);
    vi.advanceTimersByTime(120_000);

    expect(sm.send).toHaveBeenCalledWith(
      SESSION_ID,
      expect.stringContaining('Pause your work'),
    );
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'stuck_session_paused',
        sessionId: SESSION_ID,
      }),
    );
    const row = db
      .prepare(
        'SELECT pause_reason FROM pull_requests WHERE pr_number = ? AND repo = ?',
      )
      .get(PR_NUMBER, REPO) as { pause_reason: string | null };
    expect(row.pause_reason).toBe('stuck_timeout');
  });

  it('hard-stops when a tool_use arrives within the hard-stop window', () => {
    const sm = makeMockSessionManager();
    const broadcast = vi.fn();
    new StuckSessionMonitor(sm, broadcast);

    fireMessage(sm, sessionStarted());
    insertPR(SESSION_ID, PR_NUMBER, REPO);
    vi.advanceTimersByTime(120_000); // pause fires

    // Tool_use within 30s should trigger hard-stop
    vi.advanceTimersByTime(10_000);
    fireMessage(sm, {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'tool_use',
      content: '',
    });

    expect(sm.kill).toHaveBeenCalledWith(SESSION_ID);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'stuck_session_killed',
        sessionId: SESSION_ID,
      }),
    );
  });

  it('does not hard-stop if no tool_use arrives within the window', () => {
    const sm = makeMockSessionManager();
    const broadcast = vi.fn();
    new StuckSessionMonitor(sm, broadcast);

    fireMessage(sm, sessionStarted());
    vi.advanceTimersByTime(120_000); // pause fires
    vi.advanceTimersByTime(31_000); // past window

    fireMessage(sm, {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'tool_use',
      content: '',
    });
    expect(sm.kill).not.toHaveBeenCalled();
  });

  it('clears state on session_ended', () => {
    const sm = makeMockSessionManager();
    const broadcast = vi.fn();
    const monitor = new StuckSessionMonitor(sm, broadcast);

    fireMessage(sm, sessionStarted());
    expect(monitor.isTracking(SESSION_ID)).toBe(true);
    fireMessage(sm, {
      type: 'session_ended',
      sessionId: SESSION_ID,
      status: 'done',
    });
    expect(monitor.isTracking(SESSION_ID)).toBe(false);

    // No timers should fire after end
    vi.advanceTimersByTime(200_000);
    expect(broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stuck_session_notified' }),
    );
  });

  it('skips pause when no PR exists yet — still injects the message', () => {
    const sm = makeMockSessionManager();
    const broadcast = vi.fn();
    new StuckSessionMonitor(sm, broadcast);

    fireMessage(sm, sessionStarted());
    vi.advanceTimersByTime(120_000);

    expect(sm.send).toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stuck_session_paused' }),
    );
  });

  it('clears the hard-stop arm when a review event arrives after pause', () => {
    const sm = makeMockSessionManager();
    const broadcast = vi.fn();
    new StuckSessionMonitor(sm, broadcast);

    fireMessage(sm, sessionStarted());
    insertPR(SESSION_ID, PR_NUMBER, REPO);
    vi.advanceTimersByTime(120_000); // pause fires

    // Review event between pause and tool_use should disarm the hard-stop
    fireMessage(sm, {
      type: 'review_verdict',
      prNumber: PR_NUMBER,
      repo: REPO,
      verdict: 'needs_changes',
      summary: 'x',
      iteration: 1,
    });

    vi.advanceTimersByTime(10_000);
    fireMessage(sm, {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'tool_use',
      content: '',
    });
    expect(sm.kill).not.toHaveBeenCalled();
  });

  it('pr_created cancels notify, pause, and hard-stop timers', () => {
    const sm = makeMockSessionManager();
    const broadcast = vi.fn();
    new StuckSessionMonitor(sm, broadcast);

    fireMessage(sm, sessionStarted());
    vi.advanceTimersByTime(30_000);
    fireMessage(sm, {
      type: 'pr_created',
      sessionId: SESSION_ID,
      prUrl: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
    });

    // Advance past both notify (60s) and pause (120s) thresholds — nothing should fire.
    vi.advanceTimersByTime(200_000);

    expect(broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stuck_session_notified' }),
    );
    expect(broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stuck_session_paused' }),
    );
    expect(sm.send).not.toHaveBeenCalled();
  });

  it('review_verdict needs_changes after pr_created re-arms notify and pause from full duration', () => {
    const sm = makeMockSessionManager();
    const broadcast = vi.fn();
    new StuckSessionMonitor(sm, broadcast);

    fireMessage(sm, sessionStarted());
    insertPR(SESSION_ID, PR_NUMBER, REPO);

    vi.advanceTimersByTime(30_000);
    fireMessage(sm, {
      type: 'pr_created',
      sessionId: SESSION_ID,
      prUrl: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
    });

    // Sit paused for a while — no broadcasts
    vi.advanceTimersByTime(300_000);
    expect(broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stuck_session_notified' }),
    );

    // needs_changes verdict re-arms from full
    fireMessage(sm, {
      type: 'review_verdict',
      prNumber: PR_NUMBER,
      repo: REPO,
      verdict: 'needs_changes',
      summary: 'x',
      iteration: 1,
    });

    vi.advanceTimersByTime(59_000);
    expect(broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stuck_session_notified' }),
    );

    vi.advanceTimersByTime(2_000); // total +61s since verdict
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stuck_session_notified' }),
    );
  });

  it.each([['approved'], ['incomplete'], ['error']])(
    'review_verdict %s after pr_created does NOT re-arm timers',
    (verdict) => {
      const sm = makeMockSessionManager();
      const broadcast = vi.fn();
      new StuckSessionMonitor(sm, broadcast);

      fireMessage(sm, sessionStarted());
      insertPR(SESSION_ID, PR_NUMBER, REPO);

      vi.advanceTimersByTime(30_000);
      fireMessage(sm, {
        type: 'pr_created',
        sessionId: SESSION_ID,
        prUrl: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
      });

      fireMessage(sm, {
        type: 'review_verdict',
        prNumber: PR_NUMBER,
        repo: REPO,
        verdict,
        summary: 'x',
        iteration: 1,
      });

      vi.advanceTimersByTime(200_000);
      expect(broadcast).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'stuck_session_notified' }),
      );
      expect(broadcast).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'stuck_session_paused' }),
      );
    },
  );

  it('push_detected after a needs_changes restart pauses timers again', () => {
    const sm = makeMockSessionManager();
    const broadcast = vi.fn();
    new StuckSessionMonitor(sm, broadcast);

    fireMessage(sm, sessionStarted());
    insertPR(SESSION_ID, PR_NUMBER, REPO);

    // PR opens, timers paused
    fireMessage(sm, {
      type: 'pr_created',
      sessionId: SESSION_ID,
      prUrl: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
    });

    // needs_changes re-arms
    fireMessage(sm, {
      type: 'review_verdict',
      prNumber: PR_NUMBER,
      repo: REPO,
      verdict: 'needs_changes',
      summary: 'x',
      iteration: 1,
    });

    // Session pushes a fix — timers should pause again
    fireMessage(sm, {
      type: 'push_detected',
      sessionId: SESSION_ID,
      prNumber: PR_NUMBER,
      repo: REPO,
    });

    vi.advanceTimersByTime(200_000);
    expect(broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stuck_session_notified' }),
    );
    expect(broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stuck_session_paused' }),
    );
  });

  it('rate-limit mid-countdown saves remainder; resumed fires at the original deadline', () => {
    const sm = makeMockSessionManager();
    const broadcast = vi.fn();
    new StuckSessionMonitor(sm, broadcast);

    fireMessage(sm, sessionStarted());

    // 55s in — 5s remaining to notify, 65s to pause
    vi.advanceTimersByTime(55_000);
    fireMessage(sm, {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'system',
      content: JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rate_limited' },
      }),
    });

    // Sit through a long rate-limit window — no broadcasts
    vi.advanceTimersByTime(30 * 60_000);
    expect(broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stuck_session_notified' }),
    );
    expect(broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stuck_session_paused' }),
    );

    // Resume
    fireMessage(sm, {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'system',
      content: JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'resumed' },
      }),
    });

    // 4s past resume — still under remainder
    vi.advanceTimersByTime(4_000);
    expect(broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stuck_session_notified' }),
    );

    // 5s past resume — notify fires at the original deadline (not a fresh 60s)
    vi.advanceTimersByTime(2_000);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stuck_session_notified' }),
    );
  });

  it('rate-limit while already PR-paused is a no-op; subsequent resumed is also a no-op', () => {
    const sm = makeMockSessionManager();
    const broadcast = vi.fn();
    new StuckSessionMonitor(sm, broadcast);

    fireMessage(sm, sessionStarted());
    fireMessage(sm, {
      type: 'pr_created',
      sessionId: SESSION_ID,
      prUrl: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
    });

    // Rate-limited while paused — no remainders to save
    fireMessage(sm, {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'system',
      content: JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rate_limited' },
      }),
    });

    // Resumed — no remainders to restore
    fireMessage(sm, {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'system',
      content: JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'resumed' },
      }),
    });

    vi.advanceTimersByTime(200_000);
    expect(broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stuck_session_notified' }),
    );
    expect(broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stuck_session_paused' }),
    );
  });

  it('ignores malformed system event payloads', () => {
    const sm = makeMockSessionManager();
    const broadcast = vi.fn();
    new StuckSessionMonitor(sm, broadcast);

    fireMessage(sm, sessionStarted());

    // Malformed JSON should not throw or affect timers
    fireMessage(sm, {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'system',
      content: 'not-json',
    });
    fireMessage(sm, {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'system',
      content: JSON.stringify({ type: 'something_else' }),
    });

    // Notify still fires on its original schedule
    vi.advanceTimersByTime(60_000);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stuck_session_notified' }),
    );
  });
});
