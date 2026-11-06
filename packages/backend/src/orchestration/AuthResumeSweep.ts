import { AUTH_RESUME_NOTICE } from '../db/pauseReason';
import { computeHasNewerSessionForTask } from '../session/sessionStatusDeriver';
import { isAuthFailureEvent } from '../session/eventKind';
import {
  listAuthParkedSessionIds,
  getAllSessionsForTask,
  getSession,
  getEventsBySession,
  getPauseIntervalsBySession,
  closePauseInterval,
  TERMINAL_SESSION_STATUSES,
} from '../db/queries';
import { deriveDisplayStatusFromDb } from '../tasks/TaskStatusEngine';
import { runtimeSettings } from '../config';
import { logger } from '../logger';

export type ResumeInitOutcome = 'ok' | 'auth_failed' | 'timeout';

export type SkipReason =
  | 'session_gone'
  | 'row_terminal'
  | 'task_terminal'
  | 'superseded';

export interface AuthResumeSweepDeps {
  listParkedSessionIds(): string[];
  /** Why a parked session may not be resumed, or null if still current. */
  ineligibleReason(sessionId: string): SkipReason | null;
  /** Resumes in place; null when the resume was deferred or failed to spawn. */
  resume(sessionId: string, text: string): Promise<string | null>;
  /** Resolves once the resumed session passed init, or failed on auth again. */
  awaitInit(sessionId: string, resumedAt: number): Promise<ResumeInitOutcome>;
  clearPark(sessionId: string): void;
  markLapsed(): void;
  isLapsed(): boolean;
  surfaceSkipped(
    lapseId: string,
    skipped: Array<{ sessionId: string; reason: SkipReason }>,
  ): void;
  sleep(ms: number): Promise<void>;
  batchSize(): number;
  batchSpacingMs(): number;
}

export interface AuthResumeSweepResult {
  resumed: string[];
  skipped: Array<{ sessionId: string; reason: SkipReason }>;
  stoppedReason: 'completed' | 'auth_failed_again' | 'lapsed' | 'resume_failed';
}

export function evaluateAuthResumeEligibility(
  sessionId: string,
): SkipReason | null {
  const row = getSession(sessionId);
  if (!row) return 'session_gone';
  if (TERMINAL_SESSION_STATUSES.has(row.status)) return 'row_terminal';
  if (row.task_id && deriveDisplayStatusFromDb(row.task_id) === 'done') {
    return 'task_terminal';
  }
  if (
    row.task_id &&
    computeHasNewerSessionForTask(row, getAllSessionsForTask(row.task_id))
  ) {
    return 'superseded';
  }
  return null;
}

export async function runAuthResumeSweep(
  lapseId: string,
  deps: AuthResumeSweepDeps,
): Promise<AuthResumeSweepResult> {
  const result: AuthResumeSweepResult = {
    resumed: [],
    skipped: [],
    stoppedReason: 'completed',
  };
  const eligible: string[] = [];
  for (const sessionId of deps.listParkedSessionIds()) {
    const reason = deps.ineligibleReason(sessionId);
    if (reason) result.skipped.push({ sessionId, reason });
    else eligible.push(sessionId);
  }
  if (result.skipped.length > 0) deps.surfaceSkipped(lapseId, result.skipped);

  // 'skipped' means the session turned ineligible before any resume was sent.
  const resumeOne = async (
    sessionId: string,
  ): Promise<'resumed' | 'skipped' | 'stop'> => {
    const reason = deps.ineligibleReason(sessionId);
    if (reason) {
      const skip = { sessionId, reason };
      result.skipped.push(skip);
      deps.surfaceSkipped(lapseId, [skip]);
      return 'skipped';
    }
    const resumedAt = Date.now();
    const resumedId = await deps.resume(sessionId, AUTH_RESUME_NOTICE);
    if (resumedId === null) {
      result.stoppedReason = 'resume_failed';
      return 'stop';
    }
    const outcome = await deps.awaitInit(sessionId, resumedAt);
    if (outcome === 'auth_failed') {
      deps.markLapsed();
      result.stoppedReason = 'auth_failed_again';
      return 'stop';
    }
    if (outcome === 'timeout') {
      result.stoppedReason = 'resume_failed';
      return 'stop';
    }
    deps.clearPark(sessionId);
    result.resumed.push(sessionId);
    return 'resumed';
  };

  // Canary: exactly one actual resume; a candidate that went ineligible is
  // skipped and the next one becomes the canary.
  let next = 0;
  let canary: 'resumed' | 'skipped' | 'stop' = 'skipped';
  while (canary === 'skipped' && next < eligible.length) {
    canary = await resumeOne(eligible[next++]!);
  }
  if (canary !== 'resumed') return result;

  const size = Math.max(1, deps.batchSize());
  const rest = eligible.slice(next);
  for (let i = 0; i < rest.length; i += size) {
    await deps.sleep(deps.batchSpacingMs());
    if (deps.isLapsed()) {
      result.stoppedReason = 'lapsed';
      return result;
    }
    const batch = rest.slice(i, i + size);
    const outcomes = await Promise.all(batch.map((id) => resumeOne(id)));
    if (outcomes.includes('stop')) return result;
  }
  return result;
}

const surfacedByLapse = new Map<string, Set<string>>();

function surfaceSkippedOncePerLapse(
  lapseId: string,
  skipped: Array<{ sessionId: string; reason: SkipReason }>,
): void {
  let seen = surfacedByLapse.get(lapseId);
  if (!seen) {
    // Only the current lapse needs remembering.
    surfacedByLapse.clear();
    seen = new Set();
    surfacedByLapse.set(lapseId, seen);
  }
  const fresh = skipped.filter((s) => !seen.has(s.sessionId));
  if (fresh.length === 0) return;
  for (const s of fresh) seen.add(s.sessionId);
  logger.warn(
    `[AuthResumeSweep] ${fresh.length} auth-parked session(s) not resumed after auth restoration (kept parked, not terminalized): ${fresh
      .map((s) => `${s.sessionId.slice(0, 8)}(${s.reason})`)
      .join(', ')}`,
  );
}

const INIT_POLL_MS = 2_000;
const INIT_TIMEOUT_MS = 120_000;

async function awaitResumedSessionInit(
  sessionId: string,
  resumedAt: number,
): Promise<ResumeInitOutcome> {
  const deadline = Date.now() + INIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const reParked = getPauseIntervalsBySession(sessionId).some(
      (p) =>
        p.pause_reason.reason === 'auth_failed' && p.paused_at >= resumedAt,
    );
    if (reParked) return 'auth_failed';
    const fresh = getEventsBySession(sessionId).filter(
      (e) => e.timestamp >= resumedAt && e.event_type !== 'user_message',
    );
    for (const e of fresh) {
      try {
        if (
          isAuthFailureEvent(JSON.parse(e.payload) as Record<string, unknown>)
        )
          return 'auth_failed';
      } catch {
        // unparseable payload carries no auth signal
      }
    }
    if (fresh.length > 0) return 'ok';
    await new Promise((r) => setTimeout(r, INIT_POLL_MS));
  }
  return 'timeout';
}

let sweepInFlight = false;

/** Production wiring; called with the restored event's lapse id. */
export async function runAuthResumeSweepOnRestore(
  lapseId: string,
  hooks: {
    sendOrResume(sessionId: string, text: string): Promise<string | null>;
    markLapsed(): void;
    isLapsed(): boolean;
  },
): Promise<AuthResumeSweepResult | null> {
  if (sweepInFlight) return null;
  sweepInFlight = true;
  try {
    return await runAuthResumeSweep(lapseId, {
      listParkedSessionIds: listAuthParkedSessionIds,
      ineligibleReason: evaluateAuthResumeEligibility,
      resume: hooks.sendOrResume,
      awaitInit: awaitResumedSessionInit,
      clearPark: closePauseInterval,
      markLapsed: hooks.markLapsed,
      isLapsed: hooks.isLapsed,
      surfaceSkipped: surfaceSkippedOncePerLapse,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      batchSize: () => runtimeSettings.auth_resume_batch_size,
      batchSpacingMs: () => runtimeSettings.auth_resume_batch_spacing_ms,
    });
  } finally {
    sweepInFlight = false;
  }
}
