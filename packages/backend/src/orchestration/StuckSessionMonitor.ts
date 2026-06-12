import type { SessionManager } from '../session/SessionManager';
import { runtimeSettings } from '../config';
import {
  getPRBySessionId,
  setPauseReason,
  insertPauseInterval,
  closePauseInterval,
  upsertStuckSessionTimer,
  deleteStuckSessionTimer,
  getAllStuckSessionTimers,
  getStuckResultSessionRows,
  markSessionDone,
  markSessionIdle,
} from '../db/queries';
import type { ServerMessage } from '../ws/types';
import type { GitHubClient } from '../github/GitHubClient';
import { getTaskBackend } from '../tasks/TaskBackend';
import { recoverSession } from '../session/sessionRecovery';

interface TimerState {
  taskName: string;
  notifyTimer: NodeJS.Timeout | null;
  pauseTimer: NodeJS.Timeout | null;
  hardStopTimer: NodeJS.Timeout | null;
  /** Absolute ms timestamps; valid while the corresponding timer is active. 0 = not active. */
  notifyDeadline: number;
  pauseDeadline: number;
  hardStopDeadline: number;
  /** Populated when a rate-limit pause saves the remaining time for resume. */
  notifyRemainingMs: number | null;
  pauseRemainingMs: number | null;
  hardStopRemainingMs: number | null;
  /** When true, a tool_use within hardStopDeadline triggers a hard-stop. */
  hardStopArmed: boolean;
}

const PAUSE_MESSAGE =
  'Pause your work — supervisor flagged this task as exceeding expected duration. ' +
  'Stop running tools and wait for further instructions.';

/**
 * Per-session timer that escalates when a session runs too long without
 * producing review activity. Three escalating responses:
 *
 *   1. Notify threshold — emit a toast (orchestration continues).
 *   2. Pause threshold — inject a pause message, set pause_reason on the PR,
 *      arm a hard-stop window.
 *   3. Hard-stop — if any tool_use arrives within the hard-stop window after
 *      pause, force-kill the session process.
 *
 * Timers pause when the session opens a PR (pr_created / push_detected) and
 * only re-arm when a review verdict requests changes. Rate-limit interruptions
 * also pause timers, but preserve the remaining time so the session is judged
 * against the original wall-clock budget after resume.
 *
 * Timer state is persisted to the stuck_session_timers DB table on every state
 * change. rehydrate() restores in-memory state from the DB on backend restart.
 */
/** Age guard for periodic scan: only recover sessions older than 5 minutes. */
const PERIODIC_MIN_AGE_MS = 5 * 60 * 1000;
/** Default cadence for the periodic stuck-session scan. */
const DEFAULT_SCAN_INTERVAL_MS = 60 * 1000;

export class StuckSessionMonitor {
  private timers = new Map<string, TimerState>();
  private scanTimer: NodeJS.Timeout | null = null;
  private scanStopped = true;
  private scanRunning = false;

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly broadcast: (msg: ServerMessage) => void,
    private readonly githubClient?: GitHubClient,
  ) {
    sessionManager.on('message', (msg: ServerMessage) => this.onMessage(msg));
  }

  /**
   * Start the periodic stuck-session scan. Runs at the given interval (or
   * DEFAULT_SCAN_INTERVAL_MS) and calls recoverSession() for any session
   * still at status='running' whose last event is 'result'.
   */
  startScan(intervalMs?: number): void {
    if (!this.scanStopped) return;
    this.scanStopped = false;
    this.scheduleNextScan(intervalMs ?? DEFAULT_SCAN_INTERVAL_MS);
  }

  /** Cancel all in-flight timers. Used on shutdown and from tests. */
  stop(): void {
    this.scanStopped = true;
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    for (const sessionId of [...this.timers.keys()]) {
      this.clear(sessionId);
    }
  }

  private scheduleNextScan(intervalMs: number): void {
    if (this.scanStopped) return;
    this.scanTimer = setTimeout(() => {
      void this.scanForStuckSessions().finally(() =>
        this.scheduleNextScan(intervalMs),
      );
    }, intervalMs);
    this.scanTimer.unref?.();
  }

  async scanForStuckSessions(): Promise<void> {
    if (this.scanRunning) return;
    this.scanRunning = true;
    try {
      const rows = getStuckResultSessionRows(PERIODIC_MIN_AGE_MS);
      for (const row of rows) {
        // If the session already has an open PR, transition to idle and notify the
        // operator rather than marking done — the task is still in review.
        // Check pull_requests table directly to catch the race where handlePRBodyMarker
        // has already called upsertPullRequest but markSessionIdle hasn't run yet
        // (so sessions.pr_url is still null).
        const pr = getPRBySessionId(row.session_id);
        if (pr && (pr.state === 'open' || pr.state === 'draft')) {
          const prUrl = row.pr_url ?? pr.pr_url;
          markSessionIdle(row.session_id, row.last_ts, prUrl);
          this.broadcast({
            type: 'stuck_session_idle_open_pr',
            sessionId: row.session_id,
            taskId: row.task_id ?? null,
            prUrl,
          });
          continue;
        }

        // Guard: if the subprocess is still alive in-memory, the session is not
        // truly done — it's idle (result arrived but process hasn't been cleaned
        // up yet, or the pr_body upsert failed leaving no PR row). Route to idle
        // so the operator can nudge via the composer per Task 10.
        if (this.sessionManager.isAlive(row.session_id)) {
          markSessionIdle(row.session_id, row.last_ts, row.pr_url ?? null);
          this.broadcast({
            type: 'stuck_session_idle_open_pr',
            sessionId: row.session_id,
            taskId: row.task_id ?? null,
            prUrl: row.pr_url ?? null,
          });
          continue;
        }

        markSessionDone(
          row.session_id,
          row.last_ts,
          row.pr_url ?? null,
          'stuck_session_no_pr_periodic',
        );
        let taskBackend;
        try {
          taskBackend = row.project_id ? getTaskBackend(row.project_id) : null;
        } catch {
          taskBackend = null;
        }
        if (!taskBackend) continue;
        await recoverSession(row.session_id, {
          scope: 'periodic',
          prUrl: row.pr_url ?? undefined,
          prDetectedLive: false,
          sessionType: row.session_type || 'standard',
          taskId: row.task_id || '',
          projectId: row.project_id || '',
          worktreePath: row.worktree_path || '',
          taskUrl: row.task_url || '',
          projectContextUrl: row.project_context_url || '',
          githubClient: this.githubClient,
          taskBackend,
          sessionManager: this.sessionManager,
          broadcast: this.broadcast,
          emitPrOpened: () => {},
        }).catch((e) =>
          console.error(
            `[StuckSessionMonitor] recoverSession failed for ${row.session_id}: ${e}`,
          ),
        );
      }
    } catch (e) {
      console.error(`[StuckSessionMonitor] scanForStuckSessions error: ${e}`);
    } finally {
      this.scanRunning = false;
    }
  }

  /** Returns true if the monitor is currently tracking the given session. Test hook. */
  isTracking(sessionId: string): boolean {
    return this.timers.has(sessionId);
  }

  /**
   * Restore timer state from the DB after a backend restart. Reads all rows
   * from stuck_session_timers and re-arms setTimeout for each active deadline.
   * Deadlines already elapsed fire their corresponding action immediately.
   * Called from server.ts after resumeOrphanSessions().
   */
  rehydrate(): void {
    const rows = getAllStuckSessionTimers();
    const now = Date.now();

    for (const row of rows) {
      if (this.timers.has(row.session_id)) continue;

      const state: TimerState = {
        taskName: row.task_name,
        notifyTimer: null,
        pauseTimer: null,
        hardStopTimer: null,
        notifyDeadline: row.notify_deadline,
        pauseDeadline: row.pause_deadline,
        hardStopDeadline: row.hard_stop_deadline,
        notifyRemainingMs: row.notify_remaining_ms,
        pauseRemainingMs: row.pause_remaining_ms,
        hardStopRemainingMs: row.hard_stop_remaining_ms,
        hardStopArmed: row.hard_stop_armed !== 0,
      };
      this.timers.set(row.session_id, state);

      // Re-arm notify: remainders take priority (rate-limit was active at restart)
      if (state.notifyRemainingMs !== null) {
        const remaining = state.notifyRemainingMs;
        state.notifyDeadline = now + remaining;
        state.notifyRemainingMs = null;
        if (remaining <= 0) {
          this.fireNotify(row.session_id);
        } else {
          state.notifyTimer = setTimeout(
            () => this.fireNotify(row.session_id),
            remaining,
          );
          state.notifyTimer.unref?.();
        }
      } else if (state.notifyDeadline > 0) {
        const remaining = state.notifyDeadline - now;
        if (remaining <= 0) {
          this.fireNotify(row.session_id);
        } else {
          state.notifyTimer = setTimeout(
            () => this.fireNotify(row.session_id),
            remaining,
          );
          state.notifyTimer.unref?.();
        }
      }

      // Re-arm pause
      if (state.pauseRemainingMs !== null) {
        const remaining = state.pauseRemainingMs;
        state.pauseDeadline = now + remaining;
        state.pauseRemainingMs = null;
        if (remaining <= 0) {
          this.firePause(row.session_id);
        } else {
          state.pauseTimer = setTimeout(
            () => this.firePause(row.session_id),
            remaining,
          );
          state.pauseTimer.unref?.();
        }
      } else if (state.pauseDeadline > 0) {
        const remaining = state.pauseDeadline - now;
        if (remaining <= 0) {
          this.firePause(row.session_id);
        } else {
          state.pauseTimer = setTimeout(
            () => this.firePause(row.session_id),
            remaining,
          );
          state.pauseTimer.unref?.();
        }
      }

      // Re-arm hard-stop disarm window (only re-arm if still in the future)
      if (state.hardStopArmed) {
        const remainingMs = state.hardStopRemainingMs;
        state.hardStopRemainingMs = null;
        const deadline =
          remainingMs !== null ? now + remainingMs : state.hardStopDeadline;
        const remaining = deadline - now;
        if (remaining <= 0) {
          // Window expired while server was down — disarm and persist
          state.hardStopArmed = false;
          state.hardStopDeadline = 0;
          this.persistTimerState(row.session_id);
        } else {
          state.hardStopDeadline = deadline;
          state.hardStopTimer = setTimeout(() => {
            const s = this.timers.get(row.session_id);
            if (s) {
              s.hardStopArmed = false;
              s.hardStopTimer = null;
            }
          }, remaining);
          state.hardStopTimer.unref?.();
        }
      }
    }
  }

  private onMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'session_started':
        this.startTracking(msg.sessionId, msg.taskName);
        return;
      case 'session_ended':
        this.clear(msg.sessionId);
        return;
      case 'pr_created':
        this.pauseTimers(msg.sessionId, false);
        return;
      case 'push_detected':
        this.pauseTimers(msg.sessionId, false);
        return;
      case 'pr_review_complete':
      case 'review_verdict': {
        if (msg.verdict !== 'needs_changes') return;
        const sessionId = this.findSessionByPr(msg.prNumber, msg.repo);
        if (sessionId) this.resetThresholds(sessionId);
        return;
      }
      case 'session_event': {
        if (msg.eventType === 'tool_use') {
          this.checkHardStop(msg.sessionId);
          return;
        }
        if (msg.eventType === 'other') {
          this.handleSystemEvent(msg.sessionId, msg.content);
          return;
        }
        return;
      }
      default:
        return;
    }
  }

  private handleSystemEvent(sessionId: string, content: string): void {
    let payload: unknown;
    try {
      payload = JSON.parse(content);
    } catch {
      return;
    }
    if (!payload || typeof payload !== 'object') return;
    const obj = payload as Record<string, unknown>;
    if (obj.type !== 'rate_limit_event') return;
    const info = obj.rate_limit_info as Record<string, unknown> | undefined;
    if (!info) return;
    if (info.status === 'rate_limited') {
      insertPauseInterval(sessionId, 'rate_limit');
      this.pauseTimers(sessionId, true);
    } else if (info.status === 'resumed') {
      closePauseInterval(sessionId);
      this.resumeTimers(sessionId);
    }
  }

  private startTracking(sessionId: string, taskName: string): void {
    if (this.timers.has(sessionId)) return;
    const state: TimerState = {
      taskName,
      notifyTimer: null,
      pauseTimer: null,
      hardStopTimer: null,
      notifyDeadline: 0,
      pauseDeadline: 0,
      hardStopDeadline: 0,
      notifyRemainingMs: null,
      pauseRemainingMs: null,
      hardStopRemainingMs: null,
      hardStopArmed: false,
    };
    this.timers.set(sessionId, state);
    this.scheduleNotifyAndPause(sessionId, state);
  }

  private scheduleNotifyAndPause(sessionId: string, state: TimerState): void {
    const notifyMs = runtimeSettings.session_notify_threshold_seconds * 1000;
    const pauseMs = runtimeSettings.session_pause_threshold_seconds * 1000;
    const now = Date.now();

    if (notifyMs > 0) {
      state.notifyDeadline = now + notifyMs;
      state.notifyTimer = setTimeout(
        () => this.fireNotify(sessionId),
        notifyMs,
      );
      state.notifyTimer.unref?.();
    }
    if (pauseMs > 0) {
      state.pauseDeadline = now + pauseMs;
      state.pauseTimer = setTimeout(() => this.firePause(sessionId), pauseMs);
      state.pauseTimer.unref?.();
    }
    this.persistTimerState(sessionId);
  }

  private resetThresholds(sessionId: string): void {
    const state = this.timers.get(sessionId);
    if (!state) return;
    this.pauseTimers(sessionId, false);
    this.scheduleNotifyAndPause(sessionId, state);
  }

  /**
   * Cancel any active notify / pause / hard-stop timers for the session.
   * When savingRemainder is true (rate-limit pause), record remaining ms for
   * each active timer so resumeTimers can restore them. When false (PR pause
   * or threshold reset), clear timers and drop any saved remainders.
   */
  private pauseTimers(sessionId: string, savingRemainder: boolean): void {
    const state = this.timers.get(sessionId);
    if (!state) return;
    const now = Date.now();

    if (savingRemainder) {
      if (state.notifyTimer) {
        state.notifyRemainingMs = Math.max(0, state.notifyDeadline - now);
        clearTimeout(state.notifyTimer);
        state.notifyTimer = null;
      }
      if (state.pauseTimer) {
        state.pauseRemainingMs = Math.max(0, state.pauseDeadline - now);
        clearTimeout(state.pauseTimer);
        state.pauseTimer = null;
      }
      if (state.hardStopTimer) {
        state.hardStopRemainingMs = Math.max(0, state.hardStopDeadline - now);
        clearTimeout(state.hardStopTimer);
        state.hardStopTimer = null;
      }
      this.persistTimerState(sessionId);
      return;
    }

    if (state.notifyTimer) clearTimeout(state.notifyTimer);
    if (state.pauseTimer) clearTimeout(state.pauseTimer);
    if (state.hardStopTimer) clearTimeout(state.hardStopTimer);
    state.notifyTimer = null;
    state.pauseTimer = null;
    state.hardStopTimer = null;
    state.notifyDeadline = 0;
    state.pauseDeadline = 0;
    state.hardStopDeadline = 0;
    state.notifyRemainingMs = null;
    state.pauseRemainingMs = null;
    state.hardStopRemainingMs = null;
    state.hardStopArmed = false;
    this.persistTimerState(sessionId);
  }

  /**
   * Restore timers from saved remainders after a rate-limit resume. No-op if
   * no remainders were saved (e.g. rate-limit fired while already paused).
   */
  private resumeTimers(sessionId: string): void {
    const state = this.timers.get(sessionId);
    if (!state) return;
    const now = Date.now();

    if (state.notifyRemainingMs !== null) {
      const remaining = state.notifyRemainingMs;
      state.notifyDeadline = now + remaining;
      state.notifyTimer = setTimeout(
        () => this.fireNotify(sessionId),
        remaining,
      );
      state.notifyTimer.unref?.();
      state.notifyRemainingMs = null;
    }
    if (state.pauseRemainingMs !== null) {
      const remaining = state.pauseRemainingMs;
      state.pauseDeadline = now + remaining;
      state.pauseTimer = setTimeout(() => this.firePause(sessionId), remaining);
      state.pauseTimer.unref?.();
      state.pauseRemainingMs = null;
    }
    if (state.hardStopRemainingMs !== null) {
      const remaining = state.hardStopRemainingMs;
      state.hardStopDeadline = now + remaining;
      state.hardStopTimer = setTimeout(() => {
        const s = this.timers.get(sessionId);
        if (s) {
          s.hardStopArmed = false;
          s.hardStopTimer = null;
        }
      }, remaining);
      state.hardStopTimer.unref?.();
      state.hardStopRemainingMs = null;
    }
    this.persistTimerState(sessionId);
  }

  private fireNotify(sessionId: string): void {
    const state = this.timers.get(sessionId);
    if (!state) return;
    state.notifyTimer = null;
    state.notifyDeadline = 0;
    this.persistTimerState(sessionId);
    const message = `⚠️ ${state.taskName} exceeding expected duration — possible grooming gap`;
    this.broadcast({
      type: 'stuck_session_notified',
      sessionId,
      taskName: state.taskName,
      message,
    });
  }

  private firePause(sessionId: string): void {
    const state = this.timers.get(sessionId);
    if (!state) return;
    state.pauseTimer = null;
    state.pauseDeadline = 0;

    const pr = getPRBySessionId(sessionId);
    if (pr) {
      setPauseReason(pr.pr_number, pr.repo, 'stuck_timeout');
    }
    insertPauseInterval(sessionId, 'stuck_timeout');

    try {
      this.sessionManager.send(sessionId, PAUSE_MESSAGE);
    } catch (err) {
      console.warn(
        `[StuckSessionMonitor] send failed for ${sessionId}: ${(err as Error).message}`,
      );
    }

    // Arm the hard-stop window. If a tool_use arrives within this window we
    // force-kill the session; otherwise we just leave the session paused.
    const windowMs = runtimeSettings.session_hard_stop_window_seconds * 1000;
    state.hardStopArmed = true;
    state.hardStopDeadline = Date.now() + windowMs;
    if (state.hardStopTimer) clearTimeout(state.hardStopTimer);
    state.hardStopTimer = setTimeout(() => {
      const s = this.timers.get(sessionId);
      if (s) {
        s.hardStopArmed = false;
        s.hardStopTimer = null;
      }
    }, windowMs);
    state.hardStopTimer.unref?.();
    this.persistTimerState(sessionId);

    this.broadcast({
      type: 'stuck_session_paused',
      sessionId,
      taskName: state.taskName,
      ...(pr ? { prNumber: pr.pr_number, repo: pr.repo } : {}),
    });
  }

  private checkHardStop(sessionId: string): void {
    const state = this.timers.get(sessionId);
    if (!state) return;
    if (!state.hardStopArmed) return;
    if (Date.now() > state.hardStopDeadline) return;

    console.warn(
      `[StuckSessionMonitor] hard-stopping session ${sessionId.slice(0, 8)} — tool_use within hard-stop window after pause`,
    );
    // Disarm immediately so a flurry of tool_use events doesn't spawn parallel kills.
    state.hardStopArmed = false;
    if (state.hardStopTimer) clearTimeout(state.hardStopTimer);
    state.hardStopTimer = null;

    this.broadcast({
      type: 'stuck_session_killed',
      sessionId,
      taskName: state.taskName,
    });
    this.sessionManager
      .kill(sessionId)
      .catch((err: unknown) =>
        console.warn(
          `[StuckSessionMonitor] kill failed for ${sessionId}: ${(err as Error).message}`,
        ),
      );
  }

  private clear(sessionId: string): void {
    const state = this.timers.get(sessionId);
    if (!state) return;
    if (state.notifyTimer) clearTimeout(state.notifyTimer);
    if (state.pauseTimer) clearTimeout(state.pauseTimer);
    if (state.hardStopTimer) clearTimeout(state.hardStopTimer);
    this.timers.delete(sessionId);
    deleteStuckSessionTimer(sessionId);
  }

  /**
   * Look up which tracked session corresponds to a given PR. Used to translate
   * PR-keyed review events back to a sessionId. Returns the first match.
   */
  private findSessionByPr(prNumber: number, repo: string): string | undefined {
    for (const sessionId of this.timers.keys()) {
      const pr = getPRBySessionId(sessionId);
      if (pr && pr.pr_number === prNumber && pr.repo === repo) return sessionId;
    }
    return undefined;
  }

  private persistTimerState(sessionId: string): void {
    const state = this.timers.get(sessionId);
    if (!state) return;
    upsertStuckSessionTimer(
      sessionId,
      state.taskName,
      state.notifyDeadline,
      state.pauseDeadline,
      state.hardStopDeadline,
      state.hardStopArmed,
      state.notifyRemainingMs,
      state.pauseRemainingMs,
      state.hardStopRemainingMs,
    );
  }
}
