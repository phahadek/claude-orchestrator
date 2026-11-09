/**
 * The declared nothing-exercised marker: settle-time persistence, the
 * squat-guard escape in the passed-row readers, the hold check, and the
 * outcome accessor.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

const { mockLoadOrchestratorConfig } = vi.hoisted(() => ({
  mockLoadOrchestratorConfig: vi.fn(() => ({ test_report_glob: '' })),
}));

vi.mock('../../session/test-runner', () => ({
  runTestCommands: vi.fn(),
  collectStructuredTestResultOffMainThread: vi.fn(() => null),
  collectTestReportDeclaration: vi.fn(),
  clearReportFiles: vi.fn(),
}));

vi.mock('../../session/orchestrator-config', () => ({
  resolvePreGrantCapabilities: vi.fn(() => []),
  loadOrchestratorConfig: mockLoadOrchestratorConfig,
}));

const { hashState } = vi.hoisted(() => ({ hashState: { current: '' } }));

vi.mock('../../session/analyzeGating', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../session/analyzeGating')>();
  return {
    ...actual,
    computeWholeTreeContentHash: vi.fn(async () => hashState.current),
  };
});

import { db } from '../../db/db';
import {
  insertProject,
  getLatestTestRequestRun,
  listSettledPassedTestRequestRunsForCoverage,
  insertTestRequestRun,
  completeTestRequestRun,
  getTestRequestRunById,
} from '../../db/queries';
import {
  runProjectTestRequest,
  setTestRequestRunnerExecutor,
  checkTestRequestHold,
  resolveNothingExercised,
  __resetProjectSemaphoresForTest,
} from '../testRequestLane';
import { readRunTestOutcomes } from '../runTestOutcomes';
import type { RunnerResultPackage } from '../runnerResultPackage';

function pkg(over: Partial<RunnerResultPackage> = {}): RunnerResultPackage {
  return {
    passed: true,
    output: 'ok',
    commandResults: [{ command: 'npm test', passed: true }],
    oomKilled: false,
    startedAt: 1000,
    finishedAt: 2000,
    runnerConcurrentRunCount: 0,
    structuredResult: null,
    ...over,
  };
}

function spec(contentHash: string, changedFiles?: string[]) {
  hashState.current = contentHash;
  return {
    projectId: 'proj-1',
    contentHash,
    worktreePath: '/tmp/wt',
    commands: ['npm test'],
    changedFiles,
    timeoutSec: 60,
    maxRssMb: 0,
    sessionId: null,
    runOrigin: null,
    producer: 'session_request' as const,
  };
}

function rawRow(contentHash: string) {
  return db
    .prepare(
      `SELECT nothing_exercised, unclaimed_paths FROM test_request_runs WHERE content_hash = ?`,
    )
    .get(contentHash) as {
    nothing_exercised: number | null;
    unclaimed_paths: string | null;
  };
}

/** A settled passed row in the squat shape: report acquisition attempted, nothing extracted. */
function insertSquatShapedPassed(id: string, hash: string, marked: boolean) {
  insertTestRequestRun(id, 'proj-1', hash, null, Date.now());
  completeTestRequestRun(
    id,
    'passed',
    '',
    null,
    null,
    false,
    true,
    null,
    null,
    marked,
    marked ? '[]' : null,
  );
  db.prepare(`UPDATE test_request_runs SET commands = ? WHERE id = ?`).run(
    JSON.stringify(['npm test']),
    id,
  );
}

beforeEach(() => {
  mockLoadOrchestratorConfig.mockReturnValue({ test_report_glob: 'r/*.xml' });
  db.prepare('DELETE FROM test_run_results').run();
  db.prepare('DELETE FROM test_run_summaries').run();
  db.prepare('DELETE FROM test_request_runs').run();
  db.prepare('DELETE FROM test_perf_baselines').run();
  db.prepare('DELETE FROM projects').run();
  insertProject({
    id: 'proj-1',
    name: 'P',
    project_dir: '/tmp/p',
    context_url: null,
    github_repo: null,
    task_source: 'notion',
  });
  __resetProjectSemaphoresForTest();
});

afterEach(() => setTestRequestRunnerExecutor(null));

describe('resolveNothingExercised', () => {
  it('marks a run where all commands declared and none claimed a path', () => {
    expect(
      resolveNothingExercised({ allDeclared: true, claimedPaths: [] }, [
        'skills/gate/SKILL.md',
      ]),
    ).toEqual({
      nothingExercised: true,
      unclaimedPaths: JSON.stringify(['skills/gate/SKILL.md']),
    });
  });

  it('does not mark when a path was claimed, recording only the unclaimed rest', () => {
    expect(
      resolveNothingExercised(
        { allDeclared: true, claimedPaths: ['packages/backend/a.ts'] },
        ['packages/backend/a.ts', 'README.md'],
      ),
    ).toEqual({
      nothingExercised: false,
      unclaimedPaths: JSON.stringify(['README.md']),
    });
  });

  it('does not mark and leaves unclaimed_paths null when any command did not declare', () => {
    expect(
      resolveNothingExercised({ allDeclared: false, claimedPaths: [] }, ['a']),
    ).toEqual({ nothingExercised: false, unclaimedPaths: null });
    expect(resolveNothingExercised(undefined, ['a'])).toEqual({
      nothingExercised: false,
      unclaimedPaths: null,
    });
  });
});

describe('settle-time persistence', () => {
  it('writes nothing_exercised = 1 when all commands declare with zero claims', async () => {
    setTestRequestRunnerExecutor(async () =>
      pkg({ declaration: { allDeclared: true, claimedPaths: [] } }),
    );
    await runProjectTestRequest(spec('h-marked', ['docs/a.md']));
    expect(rawRow('h-marked')).toEqual({
      nothing_exercised: 1,
      unclaimed_paths: JSON.stringify(['docs/a.md']),
    });
  });

  it('writes nothing_exercised = 0 and unclaimed_paths NULL when one command did not declare', async () => {
    setTestRequestRunnerExecutor(async () =>
      pkg({ declaration: { allDeclared: false, claimedPaths: [] } }),
    );
    await runProjectTestRequest(spec('h-partial', ['docs/a.md']));
    expect(rawRow('h-partial')).toEqual({
      nothing_exercised: 0,
      unclaimed_paths: null,
    });
  });
});

describe('squat guard escape', () => {
  it('returns a marked passed row with no structured_result/summary and still hides an unmarked one', () => {
    insertSquatShapedPassed('marked', 'h1', true);
    insertSquatShapedPassed('unmarked', 'h2', false);

    expect(getLatestTestRequestRun('proj-1', 'h1', 'full')?.id).toBe('marked');
    expect(getLatestTestRequestRun('proj-1', 'h2', 'full')).toBeUndefined();

    expect(
      listSettledPassedTestRequestRunsForCoverage('proj-1', 'h1').map(
        (r) => r.id,
      ),
    ).toEqual(['marked']);
    expect(listSettledPassedTestRequestRunsForCoverage('proj-1', 'h2')).toEqual(
      [],
    );
  });

  it('checkTestRequestHold does not hold a tree whose latest run is marked', () => {
    insertSquatShapedPassed('marked-hold', 'h3', true);
    expect(
      checkTestRequestHold({
        projectId: 'proj-1',
        sessionId: null,
        contentHash: 'h3',
        runKind: 'full',
        baseSha: null,
      }),
    ).toEqual({ held: false });
  });
});

describe('readRunTestOutcomes', () => {
  it('exposes the marker', () => {
    insertSquatShapedPassed('marked-out', 'h4', true);
    insertSquatShapedPassed('unmarked-out', 'h5', false);
    const marked = getTestRequestRunById('marked-out')!;
    const unmarked = getTestRequestRunById('unmarked-out')!;
    expect(readRunTestOutcomes(marked).nothingExercised).toBe(true);
    expect(readRunTestOutcomes(unmarked).nothingExercised).toBeUndefined();
  });
});

describe('expectedReports with expanded scoped templates', () => {
  it('counts expanded test_scoped commands (tagged by template index) but not verify-only commands', async () => {
    const { runTestCommands, collectTestReportDeclaration } =
      await import('../../session/test-runner');
    mockLoadOrchestratorConfig.mockReturnValue({
      test_report_glob: 'r/*.xml',
      test: ['npm test'],
      test_scoped: [
        'node scripts/scoped-tests.mjs frontend {{changed_files}}',
        'node scripts/scoped-tests.mjs backend {{changed_files}}',
      ],
    });
    vi.mocked(runTestCommands).mockResolvedValue({
      passed: true,
      output: 'ok',
    });
    vi.mocked(collectTestReportDeclaration).mockReturnValue({
      allDeclared: true,
      claimedPaths: [],
    });
    const s = {
      ...spec('h-expanded', ['skills/ops/SKILL.md']),
      commands: [
        "node scripts/scoped-tests.mjs frontend 'skills/ops/SKILL.md'",
        "node scripts/scoped-tests.mjs backend 'skills/ops/SKILL.md'",
        'pyright',
      ],
      commandTemplateIdx: [0, 1, -1],
    };
    await runProjectTestRequest(s);
    expect(collectTestReportDeclaration).toHaveBeenCalledWith(
      '/tmp/wt',
      'r/*.xml',
      2,
      expect.anything(),
    );
    expect(rawRow('h-expanded').nothing_exercised).toBe(1);
  });

  async function runExpandedScoped(
    hash: string,
    changedFiles: string[],
    claimedPaths: string[],
  ) {
    const { runTestCommands, collectTestReportDeclaration } =
      await import('../../session/test-runner');
    mockLoadOrchestratorConfig.mockReturnValue({
      test_report_glob: 'r/*.xml',
      test: ['npm test'],
      test_scoped: ['node scripts/scoped-tests.mjs frontend {{changed_files}}'],
    });
    vi.mocked(runTestCommands).mockResolvedValue({
      passed: true,
      output: 'ok',
    });
    vi.mocked(collectTestReportDeclaration).mockReturnValue({
      allDeclared: true,
      claimedPaths,
    });
    await runProjectTestRequest({
      ...spec(hash, changedFiles),
      runKind: 'scoped' as const,
      commands: ['node scripts/scoped-tests.mjs frontend ' + changedFiles[0]],
      commandTemplateIdx: [0],
    });
  }

  it('settles a zero-suite scoped pass as visible, not held, and gate-readable as nothing-exercised', async () => {
    await runExpandedScoped('h-zero', ['skills/ops/SKILL.md'], []);

    const row = getLatestTestRequestRun('proj-1', 'h-zero', 'scoped');
    expect(row?.state).toBe('passed');
    expect(readRunTestOutcomes(row!).nothingExercised).toBe(true);
    expect(
      checkTestRequestHold({
        projectId: 'proj-1',
        sessionId: null,
        contentHash: 'h-zero',
        runKind: 'scoped',
        baseSha: null,
      }),
    ).toEqual({ held: false });
  });

  it('populates unclaimed_paths for an all-declared scoped run that exercised tests', async () => {
    await runExpandedScoped('h-claimed', ['a.ts', 'b.md'], ['a.ts']);
    expect(rawRow('h-claimed')).toEqual({
      nothing_exercised: 0,
      unclaimed_paths: JSON.stringify(['b.md']),
    });
  });
});
