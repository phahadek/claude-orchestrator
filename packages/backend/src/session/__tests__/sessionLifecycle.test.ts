import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config.js', () => ({
  runtimeSettings: {
    session_notify_threshold_seconds: 3600,
    session_pause_threshold_seconds: 72000,
  },
}));

vi.mock('../../db/queries.js', () => ({
  getSession: vi.fn(),
  getSessionLastActivityMs: vi.fn(),
  getPRBySessionId: vi.fn(),
  getLocalBranchBySession: vi.fn(),
  listStagedIntentsBySession: vi.fn(),
  getOpsJournalEntry: vi.fn(),
}));

import {
  getSession,
  getSessionLastActivityMs,
  getPRBySessionId,
  getLocalBranchBySession,
  listStagedIntentsBySession,
  getOpsJournalEntry,
} from '../../db/queries.js';
import { sessionIsLive, sessionDidWork } from '../sessionLifecycle.js';

const NOTIFY_MS = 3600 * 1000;

function session(overrides: Record<string, unknown> = {}) {
  return {
    session_id: 'sess-1',
    task_id: 'notion:abc',
    session_type: 'standard',
    ...overrides,
  } as unknown as ReturnType<typeof getSession>;
}

describe('sessionIsLive', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns false when the session has no recorded activity', () => {
    vi.mocked(getSessionLastActivityMs).mockReturnValue(null);
    expect(sessionIsLive('sess-1')).toBe(false);
  });

  it('returns true when the last activity is more recent than the notify threshold', () => {
    vi.mocked(getSessionLastActivityMs).mockReturnValue(
      Date.now() - (NOTIFY_MS - 1000),
    );
    expect(sessionIsLive('sess-1')).toBe(true);
  });

  it('returns false when the last activity is older than the notify threshold', () => {
    vi.mocked(getSessionLastActivityMs).mockReturnValue(
      Date.now() - (NOTIFY_MS + 1000),
    );
    expect(sessionIsLive('sess-1')).toBe(false);
  });
});

describe('sessionDidWork', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPRBySessionId).mockReturnValue(null);
    vi.mocked(getLocalBranchBySession).mockReturnValue(undefined);
    vi.mocked(listStagedIntentsBySession).mockReturnValue([]);
    vi.mocked(getOpsJournalEntry).mockReturnValue(undefined);
  });

  it('returns false when the session row is missing', () => {
    vi.mocked(getSession).mockReturnValue(undefined);
    expect(sessionDidWork('sess-1')).toBe(false);
  });

  describe('standard (PR-opening) sessions', () => {
    it('returns true for a merged PR', () => {
      vi.mocked(getSession).mockReturnValue(
        session({ session_type: 'standard' }),
      );
      vi.mocked(getPRBySessionId).mockReturnValue({ state: 'merged' } as never);
      expect(sessionDidWork('sess-1')).toBe(true);
    });

    it('returns true for a closed PR', () => {
      vi.mocked(getSession).mockReturnValue(
        session({ session_type: 'standard' }),
      );
      vi.mocked(getPRBySessionId).mockReturnValue({ state: 'closed' } as never);
      expect(sessionDidWork('sess-1')).toBe(true);
    });

    it('returns false for a still-open PR', () => {
      vi.mocked(getSession).mockReturnValue(
        session({ session_type: 'standard' }),
      );
      vi.mocked(getPRBySessionId).mockReturnValue({ state: 'open' } as never);
      expect(sessionDidWork('sess-1')).toBe(false);
    });

    it('returns true for a merged local branch (local-only mode)', () => {
      vi.mocked(getSession).mockReturnValue(
        session({ session_type: 'standard' }),
      );
      vi.mocked(getLocalBranchBySession).mockReturnValue({
        status: 'merged',
      } as never);
      expect(sessionDidWork('sess-1')).toBe(true);
    });

    it('returns false when nothing was ever opened', () => {
      vi.mocked(getSession).mockReturnValue(
        session({ session_type: 'standard' }),
      );
      expect(sessionDidWork('sess-1')).toBe(false);
    });
  });

  describe('stage-only sessions (groom/design/split)', () => {
    for (const sessionType of ['groom', 'design', 'split']) {
      it(`${sessionType}: returns true once a staged intent exists`, () => {
        vi.mocked(getSession).mockReturnValue(
          session({ session_type: sessionType }),
        );
        vi.mocked(listStagedIntentsBySession).mockReturnValue([
          { id: 'i1', state: 'staged' },
        ] as never);
        expect(sessionDidWork('sess-1')).toBe(true);
      });

      it(`${sessionType}: returns true once an approved intent exists`, () => {
        vi.mocked(getSession).mockReturnValue(
          session({ session_type: sessionType }),
        );
        vi.mocked(listStagedIntentsBySession).mockReturnValue([
          { id: 'i1', state: 'approved' },
        ] as never);
        expect(sessionDidWork('sess-1')).toBe(true);
      });

      it(`${sessionType}: returns true once an intent has committed`, () => {
        vi.mocked(getSession).mockReturnValue(
          session({ session_type: sessionType }),
        );
        vi.mocked(listStagedIntentsBySession).mockReturnValue([
          { id: 'i1', state: 'committed' },
        ] as never);
        expect(sessionDidWork('sess-1')).toBe(true);
      });

      it(`${sessionType}: returns false when the only intent was superseded`, () => {
        vi.mocked(getSession).mockReturnValue(
          session({ session_type: sessionType }),
        );
        vi.mocked(listStagedIntentsBySession).mockReturnValue([
          { id: 'i1', state: 'superseded' },
        ] as never);
        expect(sessionDidWork('sess-1')).toBe(false);
      });

      it(`${sessionType}: returns false when the only intent was withdrawn`, () => {
        vi.mocked(getSession).mockReturnValue(
          session({ session_type: sessionType }),
        );
        vi.mocked(listStagedIntentsBySession).mockReturnValue([
          { id: 'i1', state: 'withdrawn' },
        ] as never);
        expect(sessionDidWork('sess-1')).toBe(false);
      });

      it(`${sessionType}: returns false when the only intent was rejected`, () => {
        vi.mocked(getSession).mockReturnValue(
          session({ session_type: sessionType }),
        );
        vi.mocked(listStagedIntentsBySession).mockReturnValue([
          { id: 'i1', state: 'rejected' },
        ] as never);
        expect(sessionDidWork('sess-1')).toBe(false);
      });

      it(`${sessionType}: returns false with no staged_intent rows`, () => {
        vi.mocked(getSession).mockReturnValue(
          session({ session_type: sessionType }),
        );
        expect(sessionDidWork('sess-1')).toBe(false);
      });
    }
  });

  describe('ops (non gate-verify) sessions', () => {
    it('returns true when it staged a decision, journal still pending', () => {
      vi.mocked(getSession).mockReturnValue(
        session({ session_type: 'ops', task_id: 'notion:abc' }),
      );
      vi.mocked(listStagedIntentsBySession).mockReturnValue([
        { id: 'i1', state: 'staged' },
      ] as never);
      vi.mocked(getOpsJournalEntry).mockReturnValue({
        state: 'pending',
      } as never);
      expect(sessionDidWork('sess-1')).toBe(true);
    });

    it('returns true when nothing staged but ops_journal advanced past pending', () => {
      vi.mocked(getSession).mockReturnValue(
        session({ session_type: 'ops', task_id: 'notion:abc' }),
      );
      vi.mocked(getOpsJournalEntry).mockReturnValue({
        state: 'candidate',
      } as never);
      expect(sessionDidWork('sess-1')).toBe(true);
    });

    it('returns false when nothing staged and the journal is still pending or missing', () => {
      vi.mocked(getSession).mockReturnValue(
        session({ session_type: 'ops', task_id: 'notion:abc' }),
      );
      vi.mocked(getOpsJournalEntry).mockReturnValue(undefined);
      expect(sessionDidWork('sess-1')).toBe(false);

      vi.mocked(getOpsJournalEntry).mockReturnValue({
        state: 'pending',
      } as never);
      expect(sessionDidWork('sess-1')).toBe(false);
    });
  });

  describe('gate-verify sessions (ops sub-case)', () => {
    it('returns true once it staged something, ignoring ops_journal entirely', () => {
      vi.mocked(getSession).mockReturnValue(
        session({ session_type: 'ops', task_id: 'gate-item:123' }),
      );
      vi.mocked(listStagedIntentsBySession).mockReturnValue([
        { id: 'i1', state: 'staged' },
      ] as never);
      expect(sessionDidWork('sess-1')).toBe(true);
    });

    it('returns false with nothing staged even if an ops_journal entry exists', () => {
      vi.mocked(getSession).mockReturnValue(
        session({ session_type: 'ops', task_id: 'gate-item:123' }),
      );
      vi.mocked(getOpsJournalEntry).mockReturnValue({
        state: 'candidate',
      } as never);
      expect(sessionDidWork('sess-1')).toBe(false);
    });
  });

  describe('docs sessions', () => {
    it('checks PR outcome first when it opened one', () => {
      vi.mocked(getSession).mockReturnValue(session({ session_type: 'docs' }));
      vi.mocked(getPRBySessionId).mockReturnValue({ state: 'merged' } as never);
      expect(sessionDidWork('sess-1')).toBe(true);
    });

    it('returns false for a docs session with a still-open PR, even with staged intents', () => {
      vi.mocked(getSession).mockReturnValue(session({ session_type: 'docs' }));
      vi.mocked(getPRBySessionId).mockReturnValue({ state: 'open' } as never);
      vi.mocked(listStagedIntentsBySession).mockReturnValue([
        { id: 'i1', state: 'staged' },
      ] as never);
      expect(sessionDidWork('sess-1')).toBe(false);
    });

    it('falls back to the staged-decision check when no PR was ever opened', () => {
      vi.mocked(getSession).mockReturnValue(session({ session_type: 'docs' }));
      vi.mocked(listStagedIntentsBySession).mockReturnValue([
        { id: 'i1', state: 'staged' },
      ] as never);
      expect(sessionDidWork('sess-1')).toBe(true);
    });

    it('returns false with no PR and nothing staged', () => {
      vi.mocked(getSession).mockReturnValue(session({ session_type: 'docs' }));
      expect(sessionDidWork('sess-1')).toBe(false);
    });
  });

  describe('review sessions', () => {
    it('is explicitly not applicable — returns false via its own branch', () => {
      vi.mocked(getSession).mockReturnValue(
        session({ session_type: 'review' }),
      );
      // Even with artifacts present that would satisfy other branches, review
      // must take its own explicit branch rather than fall through to one.
      vi.mocked(getPRBySessionId).mockReturnValue({ state: 'merged' } as never);
      vi.mocked(listStagedIntentsBySession).mockReturnValue([
        { id: 'i1', state: 'staged' },
      ] as never);
      expect(sessionDidWork('sess-1')).toBe(false);
    });
  });
});
