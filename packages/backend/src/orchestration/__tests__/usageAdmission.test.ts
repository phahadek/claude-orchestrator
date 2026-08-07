import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkUsageAdmission,
  registerUsagePoller,
  isUsageAdmitted,
  recordObservedUsageLimit,
  checkUsageThresholdAdmission,
  isUsageThresholdAdmitted,
  parseThresholdPercent,
} from '../usageAdmission';
import {
  getUsageDeferral,
  clearUsageDeferral,
  setUsageDeferral,
} from '../../db/queries';
import type { PlanUsage } from '../../ws/types';

const AVAILABLE: PlanUsage = { available: false };

function usage(overrides: Partial<PlanUsage>): PlanUsage {
  return { available: true, ...overrides };
}

describe('checkUsageAdmission', () => {
  beforeEach(() => {
    clearUsageDeferral('five_hour');
    clearUsageDeferral('seven_day');
  });

  it('allows admission when usage is unavailable (e.g. API key mode)', () => {
    const result = checkUsageAdmission(AVAILABLE);
    expect(result.allowed).toBe(true);
  });

  it('allows admission when both windows are under 100% utilization', () => {
    const result = checkUsageAdmission(
      usage({
        fiveHour: {
          percent: 40,
          resetsAt: '2099-01-01T00:00:00Z',
          severity: 'normal',
        },
        weekly: {
          percent: 10,
          resetsAt: '2099-01-08T00:00:00Z',
          severity: 'normal',
        },
      }),
    );
    expect(result.allowed).toBe(true);
  });

  it('blocks admission and records a deferral when the five_hour window is exhausted', () => {
    const resetsAt = new Date(Date.now() + 60_000).toISOString();
    const result = checkUsageAdmission(
      usage({
        fiveHour: { percent: 100, resetsAt, severity: 'exceeded' },
      }),
    );
    expect(result.allowed).toBe(false);
    expect(result.window).toBe('five_hour');
    expect(result.deferredUntil).toBe(Date.parse(resetsAt));

    // Persisted, not just returned in-memory.
    expect(getUsageDeferral('five_hour')).toBe(Date.parse(resetsAt));
  });

  it('blocks admission and records a deferral when the seven_day window is exhausted', () => {
    const resetsAt = new Date(Date.now() + 3600_000).toISOString();
    const result = checkUsageAdmission(
      usage({
        weekly: { percent: 100, resetsAt, severity: 'exceeded' },
      }),
    );
    expect(result.allowed).toBe(false);
    expect(result.window).toBe('seven_day');
    expect(getUsageDeferral('seven_day')).toBe(Date.parse(resetsAt));
  });

  it('treats severity "exceeded" below 100% as exhausted too', () => {
    const resetsAt = new Date(Date.now() + 60_000).toISOString();
    const result = checkUsageAdmission(
      usage({
        fiveHour: { percent: 97, resetsAt, severity: 'exceeded' },
      }),
    );
    expect(result.allowed).toBe(false);
  });

  it('a previously recorded deferral blocks admission even when the live snapshot no longer reports exhaustion', () => {
    const resetsAt = new Date(Date.now() + 60_000).toISOString();
    checkUsageAdmission(
      usage({ fiveHour: { percent: 100, resetsAt, severity: 'exceeded' } }),
    );

    // Simulate the next poll tick reporting a lower (stale/partial) percent —
    // the persisted deferral should still gate admission until it expires.
    const result = checkUsageAdmission(
      usage({ fiveHour: { percent: 50, resetsAt, severity: 'normal' } }),
    );
    expect(result.allowed).toBe(false);
    expect(result.window).toBe('five_hour');
  });

  it('becomes eligible again once the recorded reset instant has passed, and not before', () => {
    const futureResetsAt = Date.now() + 60_000;
    const blocked = checkUsageAdmission(
      usage({
        fiveHour: {
          percent: 100,
          resetsAt: new Date(futureResetsAt).toISOString(),
          severity: 'exceeded',
        },
      }),
    );
    expect(blocked.allowed).toBe(false);

    // Not yet — the reset instant hasn't passed.
    const stillBlocked = checkUsageAdmission(
      usage({
        fiveHour: {
          percent: 100,
          resetsAt: new Date(futureResetsAt).toISOString(),
          severity: 'exceeded',
        },
      }),
    );
    expect(stillBlocked.allowed).toBe(false);

    // Simulate the recorded reset instant having passed (as if this were a
    // later poll tick, well after resets_at) — the persisted deferral is
    // stale and getUsageDeferral discards it, and the caller-supplied usage
    // snapshot has also dropped back under 100%, so admission reopens.
    setUsageDeferral('five_hour', Date.now() - 1000);
    const reopened = checkUsageAdmission(
      usage({
        fiveHour: {
          percent: 5,
          resetsAt: '2099-01-01T00:00:00Z',
          severity: 'normal',
        },
      }),
    );
    expect(reopened.allowed).toBe(true);
    expect(getUsageDeferral('five_hour')).toBeNull();
  });

  it('a deferral survives being read from a fresh call (simulated restart) — persisted in the DB, not just in-memory', () => {
    const resetsAt = new Date(Date.now() + 120_000).toISOString();
    checkUsageAdmission(
      usage({ weekly: { percent: 100, resetsAt, severity: 'exceeded' } }),
    );

    // A "restart" here means: no in-memory poller/registration survives,
    // only the DB row. getUsageDeferral queries the DB directly.
    const deferredUntil = getUsageDeferral('seven_day');
    expect(deferredUntil).toBe(Date.parse(resetsAt));

    // And a fresh checkUsageAdmission call — as if from a newly booted
    // process with an UNAVAILABLE live snapshot — still honors it.
    const result = checkUsageAdmission(AVAILABLE);
    expect(result.allowed).toBe(false);
    expect(result.window).toBe('seven_day');
  });
});

describe('isUsageAdmitted (registered-poller singleton)', () => {
  beforeEach(() => {
    clearUsageDeferral('five_hour');
    clearUsageDeferral('seven_day');
  });

  it('allows admission when no poller has been registered', () => {
    registerUsagePoller({ getCache: () => AVAILABLE });
    expect(isUsageAdmitted().allowed).toBe(true);
  });

  it('reflects the registered poller live snapshot', () => {
    const resetsAt = new Date(Date.now() + 60_000).toISOString();
    registerUsagePoller({
      getCache: () =>
        usage({ fiveHour: { percent: 100, resetsAt, severity: 'exceeded' } }),
    });
    expect(isUsageAdmitted().allowed).toBe(false);
  });
});

describe('recordObservedUsageLimit', () => {
  beforeEach(() => {
    clearUsageDeferral('five_hour');
    clearUsageDeferral('seven_day');
  });

  it('persists a deferral so it survives a restart even without a poller snapshot', () => {
    const result = recordObservedUsageLimit(
      "You've hit your session limit · resets 11:59pm (UTC)",
    );
    expect(result.allowed).toBe(false);
    expect(result.window).toBe('five_hour');
    expect(getUsageDeferral('five_hour')).toBe(result.deferredUntil);
  });

  it('falls back to a bounded deferral when no message (or no parseable reset time) is given', () => {
    const before = Date.now();
    const result = recordObservedUsageLimit();
    expect(result.allowed).toBe(false);
    expect(result.window).toBe('five_hour');
    expect(result.deferredUntil).toBeGreaterThan(before);
    expect(result.deferredUntil).toBeLessThanOrEqual(before + 5 * 60_000 + 5);
    expect(getUsageDeferral('five_hour')).toBe(result.deferredUntil);
  });

  it('infers the seven_day window when the message names the weekly limit', () => {
    const result = recordObservedUsageLimit(
      "You've hit your weekly limit · resets 11:59pm (UTC)",
    );
    expect(result.window).toBe('seven_day');
    expect(getUsageDeferral('seven_day')).toBe(result.deferredUntil);
  });

  it('causes a subsequent admission check to block until the recorded instant', () => {
    recordObservedUsageLimit(
      "You've hit your session limit · resets 11:59pm (UTC)",
    );
    expect(isUsageAdmitted().allowed).toBe(false);
  });
});

describe('parseThresholdPercent', () => {
  it('returns null for the empty (disabled) string', () => {
    expect(parseThresholdPercent('')).toBeNull();
  });

  it('parses a numeric string', () => {
    expect(parseThresholdPercent('75')).toBe(75);
  });

  it('returns null for a non-numeric string', () => {
    expect(parseThresholdPercent('abc')).toBeNull();
  });
});

describe('checkUsageThresholdAdmission', () => {
  it('allows admission when usage is unavailable', () => {
    expect(checkUsageThresholdAdmission(AVAILABLE, 80, 80).allowed).toBe(true);
  });

  it('allows admission when both thresholds are disabled (null)', () => {
    const result = checkUsageThresholdAdmission(
      usage({
        fiveHour: { percent: 99, resetsAt: '2099-01-01T00:00:00Z', severity: 'normal' },
        weekly: { percent: 99, resetsAt: '2099-01-01T00:00:00Z', severity: 'normal' },
      }),
      null,
      null,
    );
    expect(result.allowed).toBe(true);
  });

  it('soft-pauses when the hourly (five_hour) percent crosses its configured threshold, independent of the weekly threshold', () => {
    const result = checkUsageThresholdAdmission(
      usage({
        fiveHour: { percent: 85, resetsAt: '2099-01-01T00:00:00Z', severity: 'normal' },
        weekly: { percent: 5, resetsAt: '2099-01-01T00:00:00Z', severity: 'normal' },
      }),
      80,
      null,
    );
    expect(result.allowed).toBe(false);
    expect(result.window).toBe('five_hour');
    expect(result.percent).toBe(85);
    expect(result.thresholdPercent).toBe(80);
    expect(result.reason).toBe('usage_threshold_paused');
  });

  it('soft-pauses when the weekly (seven_day) percent crosses its configured threshold, independent of the hourly threshold', () => {
    const result = checkUsageThresholdAdmission(
      usage({
        fiveHour: { percent: 5, resetsAt: '2099-01-01T00:00:00Z', severity: 'normal' },
        weekly: { percent: 90, resetsAt: '2099-01-01T00:00:00Z', severity: 'normal' },
      }),
      null,
      85,
    );
    expect(result.allowed).toBe(false);
    expect(result.window).toBe('seven_day');
    expect(result.percent).toBe(90);
    expect(result.thresholdPercent).toBe(85);
    expect(result.reason).toBe('usage_threshold_paused');
  });

  it('allows admission when both windows are under their configured thresholds', () => {
    const result = checkUsageThresholdAdmission(
      usage({
        fiveHour: { percent: 40, resetsAt: '2099-01-01T00:00:00Z', severity: 'normal' },
        weekly: { percent: 10, resetsAt: '2099-01-01T00:00:00Z', severity: 'normal' },
      }),
      80,
      85,
    );
    expect(result.allowed).toBe(true);
  });
});

describe('isUsageThresholdAdmitted (registered-poller singleton)', () => {
  it('reflects the registered poller live snapshot against the passed-in thresholds', () => {
    registerUsagePoller({
      getCache: () =>
        usage({
          fiveHour: {
            percent: 92,
            resetsAt: '2099-01-01T00:00:00Z',
            severity: 'normal',
          },
        }),
    });
    expect(isUsageThresholdAdmitted(90, null).allowed).toBe(false);
    expect(isUsageThresholdAdmitted(95, null).allowed).toBe(true);
  });
});
