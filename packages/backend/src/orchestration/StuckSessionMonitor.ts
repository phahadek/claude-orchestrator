import { logger } from '../logger';
import type { SessionManager } from '../session/SessionManager';
import { runtimeSettings } from '../config';
import { recordEvent } from '../audit/AuditLog';
import type { Scheduler } from './Scheduler';
import {
  getPRBySessionId,
  setPauseReason,
  insertPauseInterval,
  closePauseInterval,
  upsertStuckSessionTimer,
  deleteStuckSessionTimer,
  getAllStuckSessionTimers,
  getStuckResultSessionRows,
  getStuckAliveSubprocessParkRows,
  type StuckAliveSubprocessParkRow,
  markSessionDone,
  markSessionIdle,
  getSession,
  getProjectRowById,
} from '../db/queries';
import type { ServerMessage } from '../ws/types';
import type { GitHubClient } from '../github/GitHubClient';
import { getTaskBackend } from '../tasks/TaskBackend';
import { recoverSession } from '../session/sessionRecovery';
import { getCurrentBranch, hasNonEmptyDiff } from './localBranchHelpers';
import { submitLocalBranch } from './localBranchSubmission';
import { sessionIsLive } from '../session/sessionLifecycle';
import { isSessionProcessAlive } from '../session/processLiveness';

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
  /**
   * True while notify/pause are cancelled for a code session's PR review
   * (pr_created / push_detected). While suspended, session activity must
   * not re-arm the timers — only a needs_changes verdict (resetThresholds)
   * does that.
   */
  suspended: boolean;
  /** ms epoch of the last activity (or timer arm), used to compute the
   * observed event-gap recorded alongside both the notify and the
   * explicit did-not-notify audit rows. */
  lastActivityAt: number;
  /**
   * Count of tool_use session_events seen with no matching tool_result yet.
   * Incremented on tool_use, decremented (floored at 0) on tool_result.
   * While > 0 the intra-tool heartbeat sweep (see runHeartbeatSweep) treats
   * the session as busy inside a tool call rather than idle, and keeps
   * resetting the notify/pause deadlines as long as the OS process is still
   * alive — without this, a single long tool call (e.g. a lengthy Bash
   * build/test run) emits nothing between its tool_use and tool_result and
   * would otherwise be misread as a hang. Not persisted across restarts —
   * purely in-memory, rebuilt from the next tool_use/tool_result pair.
   */
  pendingToolUseCount: number;
  /**
   * Last flagged value recorded to the audit log for stuck_session_notify_checked.
   * Starts false (a freshly tracked session is not flagged). Used to make
   * that event edge-triggered: a row is only written when this value
   * actually changes, not on every check — see recordNotifyChecked.
   */
  lastNotifyCheckedFlagged: boolean;
}

const PAUSE_MESSAGE =
  'Pause your work — supervisor flagged this task as exceeding expected duration. ' +
  'Stop running tools and wait for further instructions.';

/**
 * Session statuses that mean the session has concluded for good, by any
 * path — not just the session_ended broadcast clear() was previously keyed
 * on exclusively. Mirrors db/queries.ts's TERMINAL_SESSION_STATUSES plus
 * 'superseded'; defined locally (rather than imported) so this module's own
 * terminal check doesn't depend on every test that mocks db/queries.js also
 * re-exporting the constant.
 */
const TERMINAL_SESSION_STATUSES: ReadonlySet<string> = new Set([
  'done',
  'error',
  'killed',
  'superseded',
]);

function isSessionTerminal(status: string | null | undefined): boolean {
  return status != null && TERMINAL_SESSION_STATUSES.has(status);
}

/**
 * Per-session timer that escalates when a session goes too long without any
 * activity. Three escalating responses:
 *
 *   1. Notify threshold — emit a toast (orchestration continues).
 *   2. Pause threshold — inject a pause message, set pause_reason on the PR,
 *      arm a hard-stop window.
 *   3. Hard-stop — if any tool_use arrives within the hard-stop window after
 *      pause, force-kill the session process.
 *
 * Both thresholds measure time since the session's most recent activity, not
 * time since launch: every session_event (of any kind — tool_use, text,
 * result, etc.) reschedules the notify/pause deadlines from "now", so a
 * session that is actively working never trips either threshold regardless
 * of how long it has been running. This covers planning sessions (groom /
 * design / ops) the same way as code sessions, since it doesn't depend on
 * any PR-shaped event they can't produce.
 *
 * Timers are additionally suspended when a code session opens a PR
 * (pr_created / push_detected) and only re-arm when a review verdict
 * requests changes — while suspended, activity does not re-arm them. This
 * PR-review suspension is orthogonal to the activity reset. Rate-limit
 * interruptions also pause timers, but preserve the remaining time so the
 * session is judged against the same budget after resume.
 *
 * Timer state is persisted to the stuck_session_timers DB table on every state
 * change. rehydrate() restores in-memory state from the DB on backend restart.
 */
/** Age guard for periodic scan: only recover sessions older than 5 minutes. */
const PERIODIC_MIN_AGE_MS = 5 * 60 * 1000;
/** Default cadence for the periodic stuck-session scan. */
const DEFAULT_SCAN_INTERVAL_MS = 60 * 1000;
/**
 * Cadence for the intra-tool heartbeat sweep. Bounded well under the
 * default notify threshold (3600s) so it always resets the deadline before
 * it would otherwise elapse, while staying coarse enough that it doesn't
 * invoke isSessionProcessAlive's ps scan too often under load — the sweep
 * does one ps check per distinct session with an in-flight tool_use, not
 * one per tool call.
 */
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

export class StuckSessionMonitor {
  private timers = new Map<string, TimerState>();

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly broadcast: (msg: ServerMessage) => void,
    private readonly githubClient?: GitHubClient,
  ) {
    sessionManager.on('message', (msg: ServerMessage) => this.onMessage(msg));
  }

  register(scheduler: Scheduler): void {
    scheduler.register({
      name: 'stuck_session_monitor',
      intervalMs: DEFAULT_SCAN_INTERVAL_MS,
      concurrency: 'skip-if-running',
      run: async () => {
        this.reapTerminalTimers();
        await this.scanForStuckSessions();
        await this.scanForStuckAliveSubprocessParks();
      },
    });
    scheduler.register({
      name: 'stuck_session_heartbeat',
      intervalMs: HEARTBEAT_INTERVAL_MS,
      concurrency: 'skip-if-running',
      run: async () => {
        this.runHeartbeatSweep();
      },
    });
  }

  /**
   * Reset notify/pause deadlines for every tracked session that currently
   * has an in-flight tool_use (see pendingToolUseCount) and whose OS
   * process is still alive per isSessionProcessAlive — the intra-tool
   * heartbeat. Reuses recordActivity, the same code path a real
   * session_event already drives, so a long-running tool call is treated
   * identically to continuous activity.
   *
   * A session with no in-flight tool_use, or whose process has actually
   * exited mid-call, is left untouched here — its notify/pause/hard-stop
   * timers keep running exactly as they do today, so a genuinely hung
   * session still escalates.
   */
  private runHeartbeatSweep(): void {
    for (const [sessionId, state] of this.timers) {
      if (state.suspended) continue;
      if (state.pendingToolUseCount <= 0) continue;
      if (!isSessionProcessAlive(sessionId)) continue;
      this.recordActivity(sessionId);
      recordEvent({
        event_type: 'stuck_session_heartbeat_tick',
        actor_type: 'system',
        actor_id: sessionId,
        payload: {
          session_id: sessionId,
          pending_tool_use_count: state.pendingToolUseCount,
        },
      });
    }
  }

  /**
   * Sweep every tracked timer and clear any whose session row has already
   * reached a terminal status through a path other than the session_ended
   * broadcast (a watcher-driven transition such as pr_merge_watcher /
   * auto_merger, or an external actor writing the row directly) — clear()
   * previously fired only on that one broadcast, so a session finishing by
   * any other route kept a live timer indefinitely. Runs on the same
   * cadence as scanForStuckSessions so a stray timer is cleared within one
   * scan interval of the session going terminal.
   */
  private reapTerminalTimers(): void {
    for (const sessionId of [...this.timers.keys()]) {
      const session = getSession(sessionId);
      if (isSessionTerminal(session?.status)) {
        this.clear(sessionId);
      }
    }
  }

  /** Clear all per-session timers. Called on shutdown. */
  stop(): void {
    for (const sessionId of [...this.timers.keys()]) {
      this.clear(sessionId);
    }
  }

  async scanForStuckSessions(): Promise<void> {
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
          markSessionIdle(
            row.session_id,
            row.last_ts,
            prUrl,
            'stuck_session_open_pr',
          );
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
          markSessionIdle(
            row.session_id,
            row.last_ts,
            row.pr_url ?? null,
            'stuck_session_alive_subprocess',
          );
          this.broadcast({
            type: 'stuck_session_idle_open_pr',
            sessionId: row.session_id,
            taskId: row.task_id ?? null,
            prUrl: row.pr_url ?? null,
          });
          if (row.project_id && row.task_id && row.worktree_path) {
            try {
              const project = getProjectRowById(row.project_id);
              if (project?.git_mode === 'local-only') {
                const baseBranch = project.base_branch || 'dev';
                const branchName = await getCurrentBranch(row.worktree_path);
                const hasDiff =
                  !!branchName && branchName !== baseBranch
                    ? await hasNonEmptyDiff(
                        row.worktree_path,
                        baseBranch,
                        branchName,
                      )
                    : false;
                const taskBackend = getTaskBackend(row.project_id);
                submitLocalBranch({
                  projectId: row.project_id,
                  sessionId: row.session_id,
                  taskId: row.task_id,
                  featureBranchName: branchName ?? undefined,
                  baseBranch,
                  hasDiff,
                  taskBackend,
                  // Route through sessionManager's internal 'message' bus (not
                  // the WS-only this.broadcast) so ReviewOrchestrator, which
                  // subscribes to sessionManager.on('message', ...), actually
                  // receives local_branch_submitted. server.ts still relays
                  // this to WS clients via sessionManager.on('message', broadcast).
                  broadcast: (msg) => this.sessionManager.emit('message', msg),
                });
              }
            } catch (e) {
              logger.error(
                `[StuckSessionMonitor] local branch submission failed for ${row.session_id}: ${e}`,
              );
            }
          }
          continue;
        }

        markSessionDone(
          row.session_id,
          row.last_ts,
          row.pr_url ?? null,
          'stuck_session_no_pr_periodic',
          // Already confirmed via isAlive() above that no live process exists
          // for this session — safe to bypass the in-flight guard.
          { skipInFlightGuard: true },
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
          // See comment above submitLocalBranch call in scanForStuckSessions:
          // recoverSession forwards this into submitLocalBranch, which must
          // reach sessionManager's internal 'message' bus, not just WS clients.
          broadcast: (msg) => this.sessionManager.emit('message', msg),
          emitPrOpened: () => {},
        }).catch((e) =>
          logger.error(
            `[StuckSessionMonitor] recoverSession failed for ${row.session_id}: ${e}`,
          ),
        );
      }
    } catch (e) {
      logger.error(`[StuckSessionMonitor] scanForStuckSessions error: ${e}`);
    }
  }

  /**
   * Bounds the stuck_session_alive_subprocess park: getStuckResultSessionRows
   * only matches status='running', so once scanForStuckSessions parks a
   * session there (subprocess alive, result already arrived) it drops out of
   * that query forever and nothing revisits it — the park was meant to be a
   * transient "operator can nudge it" state, not a silent, unbounded one.
   * This re-finds exactly those parks (see getStuckAliveSubprocessParkRows's
   * doc for why it can't accidentally match the legitimately long-lived
   * stuck_session_open_pr park) and, once one has sat past the configured
   * bound with no new session_events, escalates it to teardown rather than
   * leaving it to hold a resident process and a memory-admission slot
   * indefinitely.
   *
   * The escalation never fires on elapsed time alone: it requires both the
   * bound to have passed AND the OS process to still be alive right now
   * (isSessionProcessAlive, the same ground-truth signal used elsewhere) —
   * per procedures.md's rule against a terminal action on status/age alone.
   */
  private async scanForStuckAliveSubprocessParks(): Promise<void> {
    try {
      const boundMs =
        runtimeSettings.session_alive_park_escalation_seconds * 1000;
      if (boundMs <= 0) return;
      const rows = getStuckAliveSubprocessParkRows();
      const now = Date.now();
      for (const row of rows) {
        // A new event since the park means the session is genuinely active
        // again (e.g. a late-arriving event, or a respawn) — not a persistent
        // park, regardless of how much time has passed.
        const hasNewEvent =
          row.latest_event_ts != null &&
          row.latest_event_ts > row.last_known_event_ts;
        if (hasNewEvent) continue;

        const parkAgeMs = now - row.parked_at;
        if (parkAgeMs < boundMs) continue;

        if (!isSessionProcessAlive(row.session_id)) continue;

        await this.escalateStuckAliveSubprocessPark(row, parkAgeMs);
      }
    } catch (e) {
      logger.error(
        `[StuckSessionMonitor] scanForStuckAliveSubprocessParks error: ${e}`,
      );
    }
  }

  /**
   * Terminate a session that has sat parked at stuck_session_alive_subprocess
   * past the configured bound. Marks the row terminal first (endSession()
   * refuses to escalate against a non-terminal row — it exists precisely to
   * avoid killing a live/legitimately-idle session), then reuses
   * SessionManager.endSession's graceful-close-then-verify-and-escalate
   * teardown — the same path that emits session_teardown_escalated when the
   * graceful close doesn't land in time — so this never bypasses that
   * safety net with an immediate force-kill.
   */
  private async escalateStuckAliveSubprocessPark(
    row: StuckAliveSubprocessParkRow,
    parkAgeMs: number,
  ): Promise<void> {
    logger.warn(
      `[StuckSessionMonitor] escalating stuck_session_alive_subprocess park for ${row.session_id.slice(0, 8)} — ` +
        `parked ${Math.round(parkAgeMs / 1000)}s with subprocess still alive and no new events`,
    );
    this.sessionManager.markSessionErrored(
      row.session_id,
      'killed',
      'stuck_session_alive_subprocess_park_escalated',
      `subprocess still alive ${Math.round(parkAgeMs / 1000)}s after park with no new events`,
    );
    this.sessionManager.endSession(row.session_id);
    recordEvent({
      event_type: 'stuck_session_alive_park_escalated',
      actor_type: 'system',
      actor_id: row.session_id,
      project_id: row.project_id,
      task_id: row.task_id,
      payload: {
        session_id: row.session_id,
        session_type: row.session_type,
        park_age_ms: parkAgeMs,
        outcome: 'teardown_initiated',
      },
    });
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
        suspended: row.suspended !== 0,
        lastActivityAt: now,
        pendingToolUseCount: 0,
        lastNotifyCheckedFlagged: false,
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
        this.suspendForReview(msg.sessionId);
        return;
      case 'push_detected':
        this.suspendForReview(msg.sessionId);
        return;
      case 'pr_review_complete':
      case 'review_verdict': {
        if (msg.verdict !== 'needs_changes') return;
        const sessionId = this.findSessionByPr(msg.prNumber, msg.repo);
        if (sessionId) this.resetThresholds(sessionId);
        return;
      }
      case 'session_event': {
        // A rate_limit_event is the absence of activity (the session got cut
        // off externally), not evidence of it — it must not reset the
        // activity deadline before pauseTimers(savingRemainder=true) reads
        // it, or the remainder saved would always be a full fresh threshold
        // instead of what was actually left when the rate limit hit.
        const rateLimitStatus =
          msg.eventType === 'other'
            ? this.parseRateLimitStatus(msg.content)
            : null;
        if (rateLimitStatus) {
          this.handleRateLimitEvent(msg.sessionId, rateLimitStatus);
          return;
        }
        this.recordActivity(msg.sessionId);
        if (msg.eventType === 'tool_use') {
          this.checkHardStop(msg.sessionId);
          this.markToolUseStarted(msg.sessionId);
        } else if (msg.eventType === 'tool_result') {
          this.markToolUseFinished(msg.sessionId);
        }
        return;
      }
      default:
        return;
    }
  }

  /** Marks the start of an in-flight tool_use for the intra-tool heartbeat. */
  private markToolUseStarted(sessionId: string): void {
    const state = this.timers.get(sessionId);
    if (!state) return;
    state.pendingToolUseCount += 1;
  }

  /** Marks the end of an in-flight tool_use for the intra-tool heartbeat. */
  private markToolUseFinished(sessionId: string): void {
    const state = this.timers.get(sessionId);
    if (!state) return;
    state.pendingToolUseCount = Math.max(0, state.pendingToolUseCount - 1);
  }

  private parseRateLimitStatus(content: string): string | null {
    let payload: unknown;
    try {
      payload = JSON.parse(content);
    } catch {
      return null;
    }
    if (!payload || typeof payload !== 'object') return null;
    const obj = payload as Record<string, unknown>;
    if (obj.type !== 'rate_limit_event') return null;
    const info = obj.rate_limit_info as Record<string, unknown> | undefined;
    if (!info) return null;
    return typeof info.status === 'string' ? info.status : null;
  }

  private handleRateLimitEvent(sessionId: string, status: string): void {
    if (status === 'rate_limited') {
      insertPauseInterval(sessionId, 'rate_limit');
      this.pauseTimers(sessionId, true);
    } else if (status === 'resumed') {
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
      suspended: false,
      lastActivityAt: Date.now(),
      pendingToolUseCount: 0,
      lastNotifyCheckedFlagged: false,
    };
    this.timers.set(sessionId, state);
    this.scheduleNotifyAndPause(sessionId, state);
  }

  /**
   * Edge-triggered write of stuck_session_notify_checked: records a row only
   * when the flagged state actually differs from the last recorded value for
   * this session, instead of on every check. A session starts with an
   * implicit lastNotifyCheckedFlagged of false, so a session that never
   * flags never gets a row, and one that flags gets exactly one row per
   * transition (false->true, true->false).
   */
  private recordNotifyChecked(
    sessionId: string,
    state: TimerState,
    flagged: boolean,
    observedGapMs: number,
    thresholdMs: number,
  ): void {
    if (state.lastNotifyCheckedFlagged === flagged) return;
    state.lastNotifyCheckedFlagged = flagged;
    recordEvent({
      event_type: 'stuck_session_notify_checked',
      actor_type: 'system',
      actor_id: sessionId,
      payload: {
        session_id: sessionId,
        observed_gap_ms: observedGapMs,
        threshold_ms: thresholdMs,
        flagged,
      },
    });
  }

  /**
   * Reschedule notify/pause from "now" in response to session activity
   * (any session_event). No-op while suspended for PR review — a review
   * verdict, not activity, is what re-arms a suspended session. Deliberately
   * leaves hard-stop state untouched: hard-stop is a distinct mechanism keyed
   * off tool_use within its own window, and must not be cleared just because
   * that same tool_use also counts as activity.
   */
  private recordActivity(sessionId: string): void {
    const state = this.timers.get(sessionId);
    if (!state || state.suspended) return;
    // Activity always means "not flagged" as of now — whether it arrived
    // while the notify timer was still pending (never fired) or after a
    // notification already fired (the true->false recovery). recordNotifyChecked
    // only writes a row when this differs from the last recorded value, so
    // steady unflagged activity stays silent while an actual recovery from a
    // firing is captured.
    {
      const thresholdMs =
        runtimeSettings.session_notify_threshold_seconds * 1000;
      this.recordNotifyChecked(
        sessionId,
        state,
        false,
        Date.now() - state.lastActivityAt,
        thresholdMs,
      );
    }
    if (state.notifyTimer) clearTimeout(state.notifyTimer);
    if (state.pauseTimer) clearTimeout(state.pauseTimer);
    state.notifyTimer = null;
    state.pauseTimer = null;
    state.notifyDeadline = 0;
    state.pauseDeadline = 0;
    state.notifyRemainingMs = null;
    state.pauseRemainingMs = null;
    state.lastActivityAt = Date.now();
    this.scheduleNotifyAndPause(sessionId, state);
  }

  /** Cancel notify/pause for a code session's PR review and mark it suspended
   * so that subsequent activity does not re-arm them. */
  private suspendForReview(sessionId: string): void {
    const state = this.timers.get(sessionId);
    if (!state) return;
    this.pauseTimers(sessionId, false);
    state.suspended = true;
    this.persistTimerState(sessionId);
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
    state.suspended = false;
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
    const thresholdMs = runtimeSettings.session_notify_threshold_seconds * 1000;
    const observedGapMs = Date.now() - state.lastActivityAt;
    state.notifyTimer = null;
    state.notifyDeadline = 0;
    // Defense-in-depth: the canonical liveness check (sessionIsLive) should
    // already agree with the timer here — recordActivity clears the pending
    // timer synchronously on every session_event, so this only trips on a
    // genuine race (e.g. a rehydrate landing between a persisted deadline
    // and the activity that should have superseded it). Reschedule from
    // "now" instead of notifying on stale state.
    if (sessionIsLive(sessionId)) {
      this.scheduleNotifyAndPause(sessionId, state);
      return;
    }
    // Cheap guard mirroring the missing-row bail below: if the session
    // already reached a terminal status via a path that didn't clear this
    // timer in time (see reapTerminalTimers), degrade to silence instead of
    // alerting on work that's already finished.
    if (isSessionTerminal(getSession(sessionId)?.status)) {
      this.clear(sessionId);
      return;
    }
    this.persistTimerState(sessionId);
    this.recordNotifyChecked(
      sessionId,
      state,
      true,
      observedGapMs,
      thresholdMs,
    );
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
    const session = getSession(sessionId);
    if (!session) {
      // Parent row is gone (e.g. session deleted before the timer fired) —
      // nothing to pause. Clean up the orphaned timer state and bail before
      // any DB write, which would otherwise violate the FK to sessions.
      this.timers.delete(sessionId);
      return;
    }
    // Same terminal-status guard as fireNotify: a session that already
    // finished via a path that didn't clear this timer in time must not be
    // paused as if it were still stuck.
    if (isSessionTerminal(session.status)) {
      this.clear(sessionId);
      return;
    }
    state.pauseTimer = null;
    state.pauseDeadline = 0;

    // Same race guard as fireNotify — sessionIsLive should already agree
    // with the timer; reschedule from "now" instead of pausing on stale
    // state.
    if (sessionIsLive(sessionId)) {
      this.scheduleNotifyAndPause(sessionId, state);
      return;
    }

    const pr = getPRBySessionId(sessionId);
    if (pr) {
      setPauseReason(pr.pr_number, pr.repo, 'stuck_timeout');
    }
    insertPauseInterval(sessionId, 'stuck_timeout');

    try {
      const delivered = this.sessionManager.send(sessionId, PAUSE_MESSAGE);
      if (!delivered) {
        logger.warn(
          `[StuckSessionMonitor] pause nudge not confirmed delivered for ${sessionId}`,
        );
        recordEvent({
          event_type: 'stuck_session_pause_delivery_failed',
          actor_type: 'system',
          actor_id: sessionId,
          payload: { session_id: sessionId },
        });
      }
    } catch (err) {
      logger.warn(
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

    logger.warn(
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
        logger.warn(
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
    try {
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
        state.suspended,
      );
    } catch (err) {
      logger.warn(
        `[StuckSessionMonitor] persistTimerState skipped for ${sessionId.slice(0, 8)}: ${err}`,
      );
    }
  }
}
