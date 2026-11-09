import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  getSession: vi.fn(),
  getOpenPRBySessionId: vi.fn(),
  hasQueuedOrRunningTestRunForSession: vi.fn(),
  hasPendingReviewDisputeForPR: vi.fn(),
  hasActiveCapabilityRequestForSession: vi.fn(),
  setSessionPauseReason: vi.fn(),
  recordEvent: vi.fn(),
  heldIntent: undefined as unknown,
  attributionRow: undefined as unknown,
}));

vi.mock('../../db/db', () => ({
  db: {
    prepare: (sql: string) => ({
      get: () =>
        sql.includes('FROM staged_intent') ? m.heldIntent : m.attributionRow,
    }),
  },
}));
vi.mock('../../db/queries', () => ({
  getSession: m.getSession,
  getOpenPRBySessionId: m.getOpenPRBySessionId,
  hasQueuedOrRunningTestRunForSession: m.hasQueuedOrRunningTestRunForSession,
  hasPendingReviewDisputeForPR: m.hasPendingReviewDisputeForPR,
  hasActiveCapabilityRequestForSession: m.hasActiveCapabilityRequestForSession,
  setSessionPauseReason: m.setSessionPauseReason,
}));
vi.mock('../../config/settings', () => ({
  typedGetSetting: () => 120,
}));
vi.mock('../../audit/AuditLog', () => ({ recordEvent: m.recordEvent }));
vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  turnEndWakeCheck,
  handleTurnEnd,
  TURN_END_CONTINUE_DIRECTIVE,
} from '../turnEndWakeCheck';

const openPr = (over: Record<string, unknown> = {}) => ({
  pr_number: 7,
  repo: 'o/r',
  review_result: null,
  pause_reason: null,
  merge_state: 'clean',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  m.heldIntent = undefined;
  m.attributionRow = undefined;
  m.getSession.mockReturnValue({
    session_type: 'standard',
    project_id: 'p',
    task_id: 't',
  });
  m.getOpenPRBySessionId.mockReturnValue(null);
  m.hasQueuedOrRunningTestRunForSession.mockReturnValue(false);
  m.hasPendingReviewDisputeForPR.mockReturnValue(false);
  m.hasActiveCapabilityRequestForSession.mockReturnValue(false);
});

describe('turnEndWakeCheck predicates', () => {
  it('returns null with nothing pending', () => {
    expect(turnEndWakeCheck('s')).toBeNull();
  });

  it('(a) queued/running test run is a wake', () => {
    m.hasQueuedOrRunningTestRunForSession.mockReturnValue(true);
    expect(turnEndWakeCheck('s')).toBe('test_run');
  });

  it('(b) held test.request / override staged intent is a wake', () => {
    m.heldIntent = { one: 1 };
    expect(turnEndWakeCheck('s')).toBe('staged_intent');
  });

  it('(b) active capability request is a wake', () => {
    m.hasActiveCapabilityRequestForSession.mockReturnValue(true);
    expect(turnEndWakeCheck('s')).toBe('capability_request');
  });

  it('(b) pending review.dispute on the open PR is a wake', () => {
    m.getOpenPRBySessionId.mockReturnValue(
      openPr({ review_result: JSON.stringify({ verdict: 'needs_changes' }) }),
    );
    m.hasPendingReviewDisputeForPR.mockReturnValue(true);
    expect(turnEndWakeCheck('s')).toBe('pr_in_flight');
  });

  it('(c) live attribution-wait deadline is a wake; expired one is not', () => {
    const now = 10_000_000_000;
    m.attributionRow = { awaiting_disposition_at: now - 60_000 };
    expect(turnEndWakeCheck('s', now)).toBe('attribution_wait');
    m.attributionRow = { awaiting_disposition_at: now - 121 * 60_000 };
    expect(turnEndWakeCheck('s', now)).toBeNull();
  });

  it('(d) in-flight PR is a wake', () => {
    m.getOpenPRBySessionId.mockReturnValue(openPr());
    expect(turnEndWakeCheck('s')).toBe('pr_in_flight');
  });

  it('(d) PR in gate_failed does not count', () => {
    m.getOpenPRBySessionId.mockReturnValue(
      openPr({ review_result: JSON.stringify({ verdict: 'verify_failed' }) }),
    );
    expect(turnEndWakeCheck('s')).toBeNull();
  });

  it('(d) PR parked on analyze_failing does not count', () => {
    m.getOpenPRBySessionId.mockReturnValue(
      openPr({ pause_reason: 'analyze_failing' }),
    );
    expect(turnEndWakeCheck('s')).toBeNull();
  });
});

describe('handleTurnEnd', () => {
  it('enqueues exactly one directive and audits turn_end_no_wake', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const state = { consecutiveNoWake: 0 };
    expect(await handleTurnEnd('s', state, enqueue)).toBe('resumed');
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      's',
      expect.any(String),
      TURN_END_CONTINUE_DIRECTIVE,
    );
    expect(m.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'turn_end_no_wake' }),
    );
  });

  it('does not enqueue when a wake is pending', async () => {
    m.hasQueuedOrRunningTestRunForSession.mockReturnValue(true);
    const enqueue = vi.fn();
    expect(await handleTurnEnd('s', { consecutiveNoWake: 1 }, enqueue)).toBe(
      'wake_pending',
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('second consecutive no-wake surfaces once and a third does nothing', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const state = { consecutiveNoWake: 0 };
    await handleTurnEnd('s', state, enqueue);
    expect(await handleTurnEnd('s', state, enqueue)).toBe('surfaced');
    expect(await handleTurnEnd('s', state, enqueue)).toBe('skipped');
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(m.setSessionPauseReason).toHaveBeenCalledTimes(1);
    expect(
      m.recordEvent.mock.calls.filter(
        (c) => c[0].event_type === 'task_orphan_surfaced',
      ),
    ).toHaveLength(1);
  });

  it.each(['review', 'depth_review', 'groom', 'design', 'ops'])(
    'never fires for %s sessions',
    async (type) => {
      m.getSession.mockReturnValue({ session_type: type });
      const enqueue = vi.fn();
      expect(await handleTurnEnd('s', { consecutiveNoWake: 0 }, enqueue)).toBe(
        'skipped',
      );
      expect(enqueue).not.toHaveBeenCalled();
    },
  );
});
