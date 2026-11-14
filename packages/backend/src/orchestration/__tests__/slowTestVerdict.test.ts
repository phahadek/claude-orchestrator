import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

const loadConfigMock = vi.hoisted(() => vi.fn());
vi.mock('../../session/orchestrator-config.js', () => ({
  loadOrchestratorConfig: loadConfigMock,
}));
vi.mock('../../config', async (orig) => ({
  ...(await orig<object>()),
  getProjectById: () => ({ projectDir: '/base/checkout' }),
}));
vi.mock('../../session/test-runner.js', () => ({
  isTestIdTouchedByChangedFiles: (
    testId: string,
    _n: string,
    files: string[],
  ) => ({
    touched: files.includes(testId.split('::')[0]),
    confident: true,
  }),
}));

import { db } from '../../db/db.js';
import { insertTestRequestRun } from '../../db/queries.js';
import {
  evaluateSlowTestVerdict,
  evaluateLatestCleanSlowTestVerdict,
  loadSlowTestConfig,
  type SlowTestConfig,
} from '../slowTestVerdict.js';
import { buildSlowTestsSection } from '../../github/PRReviewService.js';
import { appendSlowTestNotice } from '../../session/testResultDigest.js';

const CFG: SlowTestConfig = { slow_test_ceiling_sec: 5, slow_test_allow: [] };
const FILE = 'src/a.test.ts';
let seq = 0;

function addRun(
  id: string,
  session: string | null,
  opts: {
    concurrent?: number;
    foreign?: number;
    oom?: boolean;
    reason?: string;
    kind?: 'full' | 'targeted';
    startedAt?: number;
  } = {},
): void {
  insertTestRequestRun(
    id,
    'p1',
    `h-${id}`,
    session,
    opts.startedAt ?? Date.now(),
    opts.concurrent ?? 0,
    null,
    null,
    'passed',
    opts.kind ?? 'full',
    null,
    '/wt',
  );
  db.prepare(
    `UPDATE test_request_runs SET foreign_concurrent_run_count = ?, oom_killed = ?, failure_reason = ?, started_at = ? WHERE id = ?`,
  ).run(
    opts.foreign ?? 0,
    opts.oom ? 1 : 0,
    opts.reason ?? null,
    opts.startedAt ?? Date.now(),
    id,
  );
}

function sample(
  testId: string,
  runId: string | null,
  durationMs: number,
  outcome: 'P' | 'F' = 'P',
): void {
  db.prepare(
    `INSERT INTO test_sample (test_id, project_id, run_id, sequenced_at, outcome, duration_ms, content_hash)
     VALUES (?, 'p1', ?, ?, ?, ?, NULL)`,
  ).run(testId, runId, ++seq, outcome, durationMs);
}

const id = (n: string) => `${FILE}::${n}`;

beforeEach(() => {
  db.exec('DELETE FROM test_sample; DELETE FROM test_request_runs;');
  loadConfigMock.mockReset();
});

describe('evaluateSlowTestVerdict', () => {
  it('flags a test with no pre-session samples as new with its full duration', () => {
    addRun('r1', 's1');
    sample(id('new'), 'r1', 9000);
    sample(id('fast'), 'r1', 4000);
    expect(evaluateSlowTestVerdict('r1', 's1', [], CFG)).toEqual({
      status: 'clean',
      flagged: [{ testId: id('new'), kind: 'new', addedMs: 9000 }],
    });
  });

  it("counts a test whose only samples are the same session's earlier runs as new", () => {
    addRun('r0', 's1');
    addRun('r1', 's1');
    sample(id('t'), 'r0', 9000);
    sample(id('t'), 'r1', 9000);
    expect(evaluateSlowTestVerdict('r1', 's1', [], CFG).flagged).toEqual([
      { testId: id('t'), kind: 'new', addedMs: 9000 },
    ]);
  });

  it('flags a touched test only when slower than its pre-session median by more than the ceiling', () => {
    addRun('old', 's0');
    addRun('r1', 's1');
    sample(id('slowBefore'), 'old', 20000);
    sample(id('slowBefore'), 'r1', 22000);
    sample(id('regressed'), null, 1000);
    sample(id('regressed'), 'r1', 8000);
    const v = evaluateSlowTestVerdict('r1', 's1', [FILE], CFG);
    expect(v.flagged).toEqual([
      { testId: id('regressed'), kind: 'touched', addedMs: 7000 },
    ]);
  });

  it('never flags an untouched test that regresses', () => {
    addRun('old', 's0');
    addRun('r1', 's1');
    sample(id('t'), 'old', 1000);
    sample(id('t'), 'r1', 30000);
    expect(
      evaluateSlowTestVerdict('r1', 's1', ['src/other.ts'], CFG).flagged,
    ).toEqual([]);
  });

  it.each([
    ['peer', { concurrent: 1 }],
    ['foreign peer', { foreign: 1 }],
    ['oom', { oom: true }],
    ['timeout', { reason: 'timeout' }],
    ['targeted', { kind: 'targeted' as const }],
  ])('flags nothing on a %s run', (_n, opts) => {
    addRun('r1', 's1', opts);
    sample(id('t'), 'r1', 9000);
    expect(evaluateSlowTestVerdict('r1', 's1', [], CFG)).toEqual({
      status: 'contended',
      flagged: [],
    });
  });

  it('does not judge failed results, honors the allow-list, and ceiling 0 disables', () => {
    addRun('r1', 's1');
    sample(id('failed'), 'r1', 9000, 'F');
    sample(id('allowed'), 'r1', 9000);
    const allow = { ...CFG, slow_test_allow: [id('allowed')] };
    expect(evaluateSlowTestVerdict('r1', 's1', [], allow).flagged).toEqual([]);
    expect(
      evaluateSlowTestVerdict('r1', 's1', [], {
        ...CFG,
        slow_test_ceiling_sec: 0,
      }),
    ).toEqual({ status: 'disabled', flagged: [] });
  });
});

describe('baseline prefilter', () => {
  const baselineSql = (spy: ReturnType<typeof vi.spyOn>) =>
    spy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes('LEFT JOIN test_request_runs r'));

  it('issues no baseline query when every passed test is at or below the ceiling', () => {
    addRun('r1', 's1');
    sample(id('a'), 'r1', 5000);
    sample(id('b'), 'r1', 100);
    const spy = vi.spyOn(db, 'prepare');
    expect(evaluateSlowTestVerdict('r1', 's1', [FILE], CFG)).toEqual({
      status: 'clean',
      flagged: [],
    });
    expect(baselineSql(spy)).toHaveLength(0);
    spy.mockRestore();
  });

  it('fetches baselines only for tests above the ceiling', () => {
    addRun('old', 's0');
    addRun('r1', 's1');
    sample(id('fast'), 'old', 100);
    sample(id('fast'), 'r1', 4000);
    sample(id('slow'), 'old', 1000);
    sample(id('slow'), 'r1', 8000);
    const spy = vi.spyOn(db, 'prepare');
    const v = evaluateSlowTestVerdict('r1', 's1', [FILE], CFG);
    expect(v.flagged).toEqual([
      { testId: id('slow'), kind: 'touched', addedMs: 7000 },
    ]);
    const stmts = spy.mock.calls.filter((c) =>
      String(c[0]).includes('LEFT JOIN test_request_runs r'),
    );
    expect(stmts).toHaveLength(1);
    spy.mockRestore();
  });

  it('plans the per-run sample lookup as a SEARCH on the run_id index', () => {
    const spy = vi.spyOn(db, 'prepare');
    addRun('r1', 's1');
    evaluateSlowTestVerdict('r1', 's1', [], CFG);
    const sql = spy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes('s.run_id = ?'));
    spy.mockRestore();
    expect(sql).toBeDefined();
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all('r1', 5000) as { detail: string }[];
    const sampleStep = plan.find((p) => p.detail.includes('test_sample'));
    expect(sampleStep?.detail).toMatch(/SEARCH.*idx_test_sample_run_id/);
  });
});

describe('loadSlowTestConfig', () => {
  it('reads from the project base checkout', () => {
    loadConfigMock.mockReturnValue({
      slow_test_ceiling_sec: 7,
      slow_test_allow: ['x'],
    });
    expect(loadSlowTestConfig('p1')).toEqual({
      slow_test_ceiling_sec: 7,
      slow_test_allow: ['x'],
    });
    expect(loadConfigMock).toHaveBeenCalledWith('/base/checkout');
  });
});

describe('reviewer evidence', () => {
  it('uses the newest earlier clean run when the latest is contended', () => {
    addRun('clean', 's1', { startedAt: 1000 });
    addRun('busy', 's1', { concurrent: 2, startedAt: 2000 });
    sample(id('t'), 'clean', 9000);
    sample(id('t'), 'busy', 9000);
    const v = evaluateLatestCleanSlowTestVerdict('p1', 's1', '/wt', [], CFG);
    expect(v?.flagged).toHaveLength(1);
    const section = buildSlowTestsSection(v, CFG);
    expect(section).toContain(`- ${id('t')} (new) — added 9.0s, ceiling 5s`);
    expect(section).toContain('slow_test_allow');
  });

  it("renders 'not evaluated' with no clean run and 'None' with nothing flagged", () => {
    addRun('busy', 's1', { concurrent: 2 });
    const none = evaluateLatestCleanSlowTestVerdict('p1', 's1', '/wt', [], CFG);
    expect(none).toBeNull();
    expect(buildSlowTestsSection(none, CFG)).toContain(
      'no clean run on this tree; slow-test check not evaluated',
    );
    expect(
      buildSlowTestsSection({ status: 'clean', flagged: [] }, CFG),
    ).toContain('None');
  });
});

describe('appendSlowTestNotice', () => {
  it('adds one line per flag, a skipped line when contended, nothing when disabled', () => {
    const flagged = {
      status: 'clean' as const,
      flagged: [{ testId: 'a', addedMs: 6500 }],
    };
    expect(appendSlowTestNotice('D', flagged, 5)).toBe(
      'D\n\nSlow test: `a` added 6.5s (ceiling 5s)',
    );
    expect(
      appendSlowTestNotice('D', { status: 'contended', flagged: [] }, 5),
    ).toContain('skipped (contended run)');
    expect(
      appendSlowTestNotice('D', { status: 'disabled', flagged: [] }, 5),
    ).toBe('D');
  });
});
