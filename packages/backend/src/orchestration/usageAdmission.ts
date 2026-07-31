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
}

const WINDOW_ORDER: UsageDeferralWindow[] = ['five_hour', 'seven_day'];

/** A window counts as exhausted at 100%+ utilization or an explicit 'exceeded' severity from the API. */
function isExhausted(window: UsageWindow | undefined): boolean {
  if (!window) return false;
  return window.percent >= 100 || window.severity === 'exceeded';
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
      return { allowed: false, deferredUntil, window };
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
      return { allowed: false, deferredUntil, window };
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
