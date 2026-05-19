import type { SessionManager } from '../session/SessionManager';
import { runtimeSettings } from '../config';
import { getPRBySessionId, setPauseReason } from '../db/queries';
import type { ServerMessage } from '../ws/types';

interface TimerState {
  taskName: string;
  notifyTimer: NodeJS.Timeout | null;
  pauseTimer: NodeJS.Timeout | null;
  /** When true, a tool_use within hardStopUntil triggers a hard-stop. */
  hardStopArmed: boolean;
  hardStopUntil: number;
  hardStopTimer: NodeJS.Timeout | null;
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
 * The notify and pause timers reset whenever a review event arrives for the
 * session, so a session that keeps generating review activity never escalates.
 */
export class StuckSessionMonitor {
  private timers = new Map<string, TimerState>();

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly broadcast: (msg: ServerMessage) => void,
  ) {
    sessionManager.on('message', (msg: ServerMessage) => this.onMessage(msg));
  }

  /** Cancel all in-flight timers. Used on shutdown and from tests. */
  stop(): void {
    for (const sessionId of [...this.timers.keys()]) {
      this.clear(sessionId);
    }
  }

  /** Returns true if the monitor is currently tracking the given session. Test hook. */
  isTracking(sessionId: string): boolean {
    return this.timers.has(sessionId);
  }

  private onMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'session_started':
        if (msg.sessionType === 'review') return;
        this.startTracking(msg.sessionId, msg.taskName);
        return;
      case 'session_ended':
        this.clear(msg.sessionId);
        return;
      case 'pr_review_complete':
      case 'review_verdict': {
        const sessionId = this.findSessionByPr(msg.prNumber, msg.repo);
        if (sessionId) this.resetThresholds(sessionId);
        return;
      }
      case 'session_event': {
        if (msg.eventType !== 'tool_use') return;
        this.checkHardStop(msg.sessionId);
        return;
      }
      default:
        return;
    }
  }

  private startTracking(sessionId: string, taskName: string): void {
    if (this.timers.has(sessionId)) return;
    const state: TimerState = {
      taskName,
      notifyTimer: null,
      pauseTimer: null,
      hardStopArmed: false,
      hardStopUntil: 0,
      hardStopTimer: null,
    };
    this.timers.set(sessionId, state);
    this.scheduleNotifyAndPause(sessionId, state);
  }

  private scheduleNotifyAndPause(sessionId: string, state: TimerState): void {
    const notifyMs = runtimeSettings.session_notify_threshold_seconds * 1000;
    const pauseMs = runtimeSettings.session_pause_threshold_seconds * 1000;

    if (notifyMs > 0) {
      state.notifyTimer = setTimeout(
        () => this.fireNotify(sessionId),
        notifyMs,
      );
      state.notifyTimer.unref?.();
    }
    if (pauseMs > 0) {
      state.pauseTimer = setTimeout(() => this.firePause(sessionId), pauseMs);
      state.pauseTimer.unref?.();
    }
  }

  private resetThresholds(sessionId: string): void {
    const state = this.timers.get(sessionId);
    if (!state) return;
    if (state.notifyTimer) clearTimeout(state.notifyTimer);
    if (state.pauseTimer) clearTimeout(state.pauseTimer);
    state.notifyTimer = null;
    state.pauseTimer = null;
    // Clearing the pause arm + hard-stop. A review event implies the session
    // is producing useful output again, so the prior pause (if any) is stale.
    if (state.hardStopTimer) clearTimeout(state.hardStopTimer);
    state.hardStopTimer = null;
    state.hardStopArmed = false;
    state.hardStopUntil = 0;
    this.scheduleNotifyAndPause(sessionId, state);
  }

  private fireNotify(sessionId: string): void {
    const state = this.timers.get(sessionId);
    if (!state) return;
    state.notifyTimer = null;
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

    const pr = getPRBySessionId(sessionId);
    if (pr) {
      setPauseReason(pr.pr_number, pr.repo, 'stuck_timeout');
    }

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
    state.hardStopUntil = Date.now() + windowMs;
    if (state.hardStopTimer) clearTimeout(state.hardStopTimer);
    state.hardStopTimer = setTimeout(() => {
      const s = this.timers.get(sessionId);
      if (s) {
        s.hardStopArmed = false;
        s.hardStopTimer = null;
      }
    }, windowMs);
    state.hardStopTimer.unref?.();

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
    if (Date.now() > state.hardStopUntil) return;

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
}
