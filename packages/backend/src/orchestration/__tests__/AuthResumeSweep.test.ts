import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/queries', () => ({
  listAuthParkedSessionIds: vi.fn(),
  getAllSessionsForTask: vi.fn(),
  getSession: vi.fn(),
  getEventsBySession: vi.fn(),
  getPauseIntervalsBySession: vi.fn(),
  closePauseInterval: vi.fn(),
  TERMINAL_SESSION_STATUSES: new Set(['done', 'error', 'killed']),
}));
vi.mock('../../tasks/TaskStatusEngine', () => ({
  deriveDisplayStatusFromDb: vi.fn(),
}));
const { settings, warn } = vi.hoisted(() => ({
  settings: {} as Record<string, number>,
  warn: vi.fn(),
}));
vi.mock('../../config', () => ({ runtimeSettings: settings }));
vi.mock('../../logger', () => ({
  logger: { warn, info: vi.fn(), error: vi.fn() },
}));

import {
  runAuthResumeSweep,
  runAuthResumeSweepOnRestore,
  evaluateAuthResumeEligibility,
  type AuthResumeSweepDeps,
  type ResumeInitOutcome,
  type SkipReason,
} from '../AuthResumeSweep';
import { AUTH_RESUME_NOTICE } from '../../db/pauseReason';
import { computeHasNewerSessionForTask } from '../../session/sessionStatusDeriver';
import * as queries from '../../db/queries';
import { deriveDisplayStatusFromDb } from '../../tasks/TaskStatusEngine';

function makeDeps(
  ids: string[],
  opts: {
    ineligible?: Record<string, SkipReason>;
    outcomes?: Record<string, ResumeInitOutcome>;
  } = {},
) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const texts: string[] = [];
  let lapsed = false;
  const surfaced: string[][] = [];
  const deps: AuthResumeSweepDeps = {
    listParkedSessionIds: () => ids,
    ineligibleReason: (id) => opts.ineligible?.[id] ?? null,
    resume: async (id, text) => {
      calls.push(id);
      texts.push(text);
      return id;
    },
    awaitInit: async (id) => opts.outcomes?.[id] ?? 'ok',
    clearPark: vi.fn(),
    markLapsed: () => {
      lapsed = true;
    },
    isLapsed: () => lapsed,
    surfaceSkipped: (_l, s) => surfaced.push(s.map((x) => x.sessionId)),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    batchSize: () => 2,
    batchSpacingMs: () => 500,
  };
  return { deps, calls, sleeps, texts, surfaced, isLapsed: () => lapsed };
}

describe('runAuthResumeSweep', () => {
  it('resumes only eligible sessions, skips others and surfaces them', async () => {
    const t = makeDeps(['a', 'b', 'c'], {
      ineligible: { b: 'superseded', c: 'task_terminal' },
    });
    const r = await runAuthResumeSweep('lapse1', t.deps);
    expect(t.calls).toEqual(['a']);
    expect(r.skipped.map((s) => s.sessionId)).toEqual(['b', 'c']);
    expect(t.surfaced).toEqual([['b', 'c']]);
    expect(t.deps.clearPark).toHaveBeenCalledTimes(1);
    expect(t.deps.clearPark).toHaveBeenCalledWith('a');
  });

  it('runs a single canary then batches of the configured size with spacing', async () => {
    const t = makeDeps(['1', '2', '3', '4', '5']);
    const r = await runAuthResumeSweep('l', t.deps);
    expect(t.calls).toEqual(['1', '2', '3', '4', '5']);
    expect(t.sleeps).toEqual([500, 500]);
    expect(r.stoppedReason).toBe('completed');
  });

  it('does not start batches when the canary fails on auth, and sets lapsed', async () => {
    const t = makeDeps(['1', '2', '3'], { outcomes: { '1': 'auth_failed' } });
    const r = await runAuthResumeSweep('l', t.deps);
    expect(t.calls).toEqual(['1']);
    expect(t.isLapsed()).toBe(true);
    expect(r.stoppedReason).toBe('auth_failed_again');
    expect(t.deps.clearPark).not.toHaveBeenCalled();
  });

  it('stops after a batch containing an auth failure', async () => {
    const t = makeDeps(['1', '2', '3', '4', '5'], {
      outcomes: { '3': 'auth_failed' },
    });
    await runAuthResumeSweep('l', t.deps);
    expect(t.calls).toEqual(['1', '2', '3']);
    expect(t.isLapsed()).toBe(true);
  });

  it('sends exactly the fixed notice on every resume', async () => {
    const t = makeDeps(['1', '2', '3']);
    await runAuthResumeSweep('l', t.deps);
    expect(t.texts).toEqual(Array(3).fill(AUTH_RESUME_NOTICE));
  });

  it('stops when a deferred resume returns null', async () => {
    const t = makeDeps(['1', '2']);
    t.deps.resume = async () => null;
    const r = await runAuthResumeSweep('l', t.deps);
    expect(r.stoppedReason).toBe('resume_failed');
    expect(t.deps.clearPark).not.toHaveBeenCalled();
  });
});

describe('canary rule', () => {
  it('promotes the next session to canary when the first goes ineligible at resume time', async () => {
    const t = makeDeps(['1', '2', '3', '4']);
    let calls = 0;
    t.deps.ineligibleReason = (id) => {
      calls++;
      // '1' passes the initial scan, then is superseded before its resume.
      return id === '1' && calls > 4 ? 'superseded' : null;
    };
    const inflight: number[] = [];
    let live = 0;
    t.deps.resume = async (id) => {
      live++;
      inflight.push(live);
      await new Promise((r) => setTimeout(r, 1));
      live--;
      t.calls.push(id);
      return id;
    };
    await runAuthResumeSweep('l', t.deps);
    expect(t.calls).toEqual(['2', '3', '4']);
    // canary ran alone: first resume never overlapped another
    expect(inflight[0]).toBe(1);
    expect(inflight[1]).toBe(1);
  });
});

describe('runAuthResumeSweepOnRestore (production wiring)', () => {
  const rowFor = (id: string, session_type: string) => ({
    session_id: id,
    task_id: null,
    status: 'idle',
    started_at: 1,
    session_type,
  });

  function setup(rows: Record<string, ReturnType<typeof rowFor> | undefined>) {
    vi.mocked(queries.listAuthParkedSessionIds).mockReturnValue(
      Object.keys(rows),
    );
    vi.mocked(queries.getSession).mockImplementation(
      (id: string) => rows[id] as never,
    );
    vi.mocked(queries.getPauseIntervalsBySession).mockReturnValue([]);
    vi.mocked(queries.getEventsBySession).mockReturnValue([
      {
        event_type: 'text',
        payload: '{}',
        timestamp: Date.now() + 1_000_000,
      },
    ] as never);
    vi.mocked(queries.closePauseInterval).mockClear();
  }

  it('resumes groom and design sessions through sendOrResume with the fixed notice', async () => {
    setup({ g1: rowFor('g1', 'groom'), d1: rowFor('d1', 'design') });
    settings.auth_resume_batch_size = 3;
    settings.auth_resume_batch_spacing_ms = 0;
    const sendOrResume = vi.fn(async (id: string) => id);
    await runAuthResumeSweepOnRestore('lapseG', {
      sendOrResume,
      markLapsed: vi.fn(),
      isLapsed: () => false,
    });
    expect(sendOrResume.mock.calls).toEqual([
      ['g1', AUTH_RESUME_NOTICE],
      ['d1', AUTH_RESUME_NOTICE],
    ]);
    expect(queries.closePauseInterval).toHaveBeenCalledWith('g1');
    expect(queries.closePauseInterval).toHaveBeenCalledWith('d1');
  });

  it('batch size is unaffected by concurrency-cap and human_reserve settings', async () => {
    const ids = ['1', '2', '3', '4', '5'];
    setup(Object.fromEntries(ids.map((i) => [i, rowFor(i, 'standard')])));
    settings.max_concurrent_code_sessions = 1;
    settings.human_reserve = 99;
    settings.auth_resume_batch_size = 2;
    settings.auth_resume_batch_spacing_ms = 0;
    let live = 0;
    let peak = 0;
    const sendOrResume = vi.fn(async (id: string) => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 1));
      live--;
      return id;
    });
    const r = await runAuthResumeSweepOnRestore('lapseC', {
      sendOrResume,
      markLapsed: vi.fn(),
      isLapsed: () => false,
    });
    expect(r?.resumed).toEqual(ids);
    expect(peak).toBe(2);
  });

  it('surfaces skipped sessions once per lapse, not once per pass', async () => {
    setup({ gone: undefined });
    warn.mockClear();
    const hooks = {
      sendOrResume: vi.fn(async (id: string) => id),
      markLapsed: vi.fn(),
      isLapsed: () => false,
    };
    await runAuthResumeSweepOnRestore('lapseA', hooks);
    await runAuthResumeSweepOnRestore('lapseA', hooks);
    expect(warn).toHaveBeenCalledTimes(1);
    await runAuthResumeSweepOnRestore('lapseB', hooks);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(hooks.sendOrResume).not.toHaveBeenCalled();
  });
});

describe('evaluateAuthResumeEligibility', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    session_id: 's1',
    task_id: 't1',
    status: 'idle',
    started_at: 100,
    session_type: 'groom',
    ...over,
  });

  it('is eligible for a current non-terminal session', () => {
    vi.mocked(queries.getSession).mockReturnValue(row() as never);
    vi.mocked(deriveDisplayStatusFromDb).mockReturnValue('in_progress');
    vi.mocked(queries.getAllSessionsForTask).mockReturnValue([row()] as never);
    expect(evaluateAuthResumeEligibility('s1')).toBeNull();
  });

  it('skips terminal row, terminal task, and superseded sessions', () => {
    vi.mocked(queries.getSession).mockReturnValue(
      row({ status: 'done' }) as never,
    );
    expect(evaluateAuthResumeEligibility('s1')).toBe('row_terminal');

    vi.mocked(queries.getSession).mockReturnValue(row() as never);
    vi.mocked(deriveDisplayStatusFromDb).mockReturnValue('done');
    expect(evaluateAuthResumeEligibility('s1')).toBe('task_terminal');

    vi.mocked(deriveDisplayStatusFromDb).mockReturnValue('in_progress');
    vi.mocked(queries.getAllSessionsForTask).mockReturnValue([
      row(),
      row({ session_id: 's2', started_at: 200, status: 'running' }),
    ] as never);
    expect(evaluateAuthResumeEligibility('s1')).toBe('superseded');
  });
});

describe('computeHasNewerSessionForTask', () => {
  it('ignores newer sessions still in starting', () => {
    const s = { session_id: 'a', started_at: 1 };
    expect(
      computeHasNewerSessionForTask(s, [
        { session_id: 'b', started_at: 2, status: 'starting' },
      ]),
    ).toBe(false);
    expect(
      computeHasNewerSessionForTask(s, [
        { session_id: 'b', started_at: 2, status: 'idle' },
      ]),
    ).toBe(true);
  });
});
