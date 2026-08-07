import {
  getUsageDeferral,
  setUsageDeferral,
  type UsageDeferralWindow,
} from '../db/queries';
import type { PlanUsage, UsageWindow } from '../ws/types';

/**
 * Usage-admission gate: an independent check consulted before a launch,
 * resume, or dispatch — deliberately not folded into flow_arm or
 * max_concurrent_planning_sessions accounting (those govern concurrency,
 * this governs whether the account has room at all). Global by design:
 * plan-usage limits are account-wide, so a deferred groom session does not
 * free capacity for a deferred code session, and vice versa.
 */
export interface UsageAdmissionResult {
  allowed: boolean;
  /** Present when allowed is false — the ms timestamp admission reopens. */
  deferredUntil?: number;
  window?: UsageDeferralWindow;
  /**
   * Present when allowed is false — a uniform reason tag shared with the
   * other admission gates (memory, capacity) so callers like AutoLauncher's
   * sustained-block signal don't need gate-specific branching.
   */
  reason?: 'usage_deferral';
}

const WINDOW_ORDER: UsageDeferralWindow[] = ['five_hour', 'seven_day'];

/** A window counts as exhausted at 100%+ utilization or an explicit 'exceeded' severity from the API. */
function isExhausted(window: UsageWindow | undefined): boolean {
  if (!window) return false;
  return window.percent >= 100 || window.severity === 'exceeded';
}

/**
 * Result of the configurable soft-threshold check — distinct from
 * UsageAdmissionResult's hard-exhaustion 'usage_deferral' reason so callers
 * (and operators reading AutoLauncher's surfaced reason string) can tell a
 * proactive threshold pause from a real plan-exhaustion block. Unlike the
 * hard gate, this is not persisted as a deferral: it is re-evaluated from
 * the live poller snapshot on every admission check, so it clears itself
 * the moment the polled percent drops back under the configured threshold.
 */
export interface UsageThresholdResult {
  allowed: boolean;
  window?: UsageDeferralWindow;
  percent?: number;
  thresholdPercent?: number;
  reason?: 'usage_threshold_paused';
}

/** Parses a settings percent field ('' = disabled) into a number, or null when disabled/invalid. */
export function parseThresholdPercent(raw: string): number | null {
  if (raw === '') return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

/**
 * Pure soft-threshold check: pauses admission once a window's live polled
 * percent reaches the configured threshold, ahead of the hard 100%
 * exhaustion gate in checkUsageAdmission. Either threshold may be null
 * (disabled) independently of the other.
 */
export function checkUsageThresholdAdmission(
  usage: PlanUsage,
  hourlyThresholdPercent: number | null,
  weeklyThresholdPercent: number | null,
): UsageThresholdResult {
  if (!usage.available) return { allowed: true };

  const windows: Array<
    [UsageDeferralWindow, UsageWindow | undefined, number | null]
  > = [
    ['five_hour', usage.fiveHour, hourlyThresholdPercent],
    ['seven_day', usage.weekly, weeklyThresholdPercent],
  ];

  for (const [window, snapshot, thresholdPercent] of windows) {
    if (thresholdPercent == null || !snapshot) continue;
    if (snapshot.percent >= thresholdPercent) {
      return {
        allowed: false,
        window,
        percent: snapshot.percent,
        thresholdPercent,
        reason: 'usage_threshold_paused',
      };
    }
  }

  return { allowed: true };
}

/**
 * Convenience wrapper: checkUsageThresholdAdmission against the registered
 * poller's live snapshot and the configured settings thresholds.
 */
export function isUsageThresholdAdmitted(
  hourlyThresholdPercent: number | null,
  weeklyThresholdPercent: number | null,
): UsageThresholdResult {
  const usage = _poller?.getCache() ?? { available: false };
  return checkUsageThresholdAdmission(
    usage,
    hourlyThresholdPercent,
    weeklyThresholdPercent,
  );
}

function fallbackDeferralMs(): number {
  // No parseable resets_at — defer a short, bounded interval rather than
  // blocking indefinitely; the next admission check will re-evaluate.
  return Date.now() + 5 * 60_000;
}

/**
 * Checks whether a launch/resume/dispatch may proceed right now. Consults
 * the persisted deferral first (so a restart doesn't reopen admission
 * early), then the poller's live snapshot; a newly observed exhausted
 * window is recorded as a deferral before returning not-allowed.
 */
export function checkUsageAdmission(usage: PlanUsage): UsageAdmissionResult {
  const now = Date.now();

  for (const window of WINDOW_ORDER) {
    const deferredUntil = getUsageDeferral(window);
    if (deferredUntil != null && deferredUntil > now) {
      return {
        allowed: false,
        deferredUntil,
        window,
        reason: 'usage_deferral',
      };
    }
  }

  if (!usage.available) return { allowed: true };

  const windows: Array<[UsageDeferralWindow, UsageWindow | undefined]> = [
    ['five_hour', usage.fiveHour],
    ['seven_day', usage.weekly],
  ];

  for (const [window, snapshot] of windows) {
    if (isExhausted(snapshot)) {
      const parsed = snapshot ? Date.parse(snapshot.resetsAt) : NaN;
      const deferredUntil = Number.isNaN(parsed)
        ? fallbackDeferralMs()
        : parsed;
      setUsageDeferral(window, deferredUntil);
      return {
        allowed: false,
        deferredUntil,
        window,
        reason: 'usage_deferral',
      };
    }
  }

  return { allowed: true };
}

/**
 * Module-level singleton wiring so admission callers (AutoLauncher,
 * DispatchTriggerEvaluator, SessionManager) don't need PlanUsagePoller
 * threaded through their constructors — mirrors routes/planUsage.ts's
 * setPlanUsagePoller registration. server.ts registers the live poller once
 * at boot; tests can register a stub via the same function.
 */
let _poller: { getCache(): PlanUsage } | null = null;

export function registerUsagePoller(poller: { getCache(): PlanUsage }): void {
  _poller = poller;
}

/** Convenience wrapper: checkUsageAdmission against the registered poller's live snapshot. */
export function isUsageAdmitted(): UsageAdmissionResult {
  const usage = _poller?.getCache() ?? { available: false };
  return checkUsageAdmission(usage);
}

// Matches the CLI's own limit-result message, e.g.
// "You've hit your session limit · resets 6:10pm (UTC)". No date is given,
// only a time-of-day — the nearest future occurrence of that UTC clock time
// is the best available estimate of resets_at.
const CLI_RESET_TIME_REGEX = /resets?\s+(\d{1,2}):(\d{2})\s*(am|pm)\s*\(UTC\)/i;

function parseCliResetTime(message: string): number | undefined {
  const match = message.match(CLI_RESET_TIME_REGEX);
  if (!match) return undefined;
  const meridiem = match[3].toLowerCase();
  let hour = parseInt(match[1], 10) % 12;
  if (meridiem === 'pm') hour += 12;
  const minute = parseInt(match[2], 10);
  const now = new Date();
  let candidate = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hour,
    minute,
    0,
    0,
  );
  if (candidate <= Date.now()) candidate += 24 * 60 * 60 * 1000;
  return candidate;
}

/** The CLI's own limit message names "session limit" for the 5h window; anything else is treated as the weekly window. */
function inferWindowFromMessage(message: string): UsageDeferralWindow {
  return /weekly/i.test(message) ? 'seven_day' : 'five_hour';
}

/**
 * Records a deferral observed directly from a terminating CLI event
 * (api_error_status: 429), rather than from the periodic plan-usage poller
 * snapshot. The poller may not have caught up yet by the time the CLI
 * itself reports the limit — this is ground truth and should gate
 * admission immediately, independent of checkUsageAdmission's snapshot path.
 */
export function recordObservedUsageLimit(
  resultMessage?: string,
): UsageAdmissionResult {
  const window = resultMessage
    ? inferWindowFromMessage(resultMessage)
    : 'five_hour';
  const parsed = resultMessage ? parseCliResetTime(resultMessage) : undefined;
  const deferredUntil = parsed ?? fallbackDeferralMs();
  setUsageDeferral(window, deferredUntil);
  return { allowed: false, deferredUntil, window, reason: 'usage_deferral' };
}
