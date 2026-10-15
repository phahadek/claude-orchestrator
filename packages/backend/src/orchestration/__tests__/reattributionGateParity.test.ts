/**
 * Gate parity: for an identical run state, the lane replay
 * (reattributionService.evaluateSubject), the paused-PR re-attribution path
 * (PRMergeWatcher.reattributePausedPR) and the PreReviewPipeline verify
 * stage's filter call (filterVerifyFailureByBaseHealth) reach the same
 * excused-to-pass verdict. Kept separate from reattributionService.test.ts
 * because that file mocks the shared filter, which this test must run for real.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

const REPO = 'owner/repo';
const PROJECT = {
  id: 'proj-1',
  projectDir: '/tmp/x',
  baseBranch: 'dev',
  githubRepo: REPO,
};
vi.mock('../../config', () => ({
  getProjectById: vi.fn(() => PROJECT),
  getProjectByGithubRepo: vi.fn(() => PROJECT),
  AUTO_REVIEW_ENABLED: true,
}));

import { db } from '../../db/db';
import {
  insertSession,
  markTestRequestRunAwaitingDisposition,
  setPauseReason,
  upsertPullRequest,
} from '../../db/queries';
import { normalizeTaskId } from '../../tasks/taskId';
import { filterVerifyFailureByBaseHealth } from '../baseAttributableFilter';
import { evaluateSubject } from '../reattributionService';
import { PRMergeWatcher } from '../../github/PRMergeWatcher';
import type { ProjectConfig } from '../../config';

const TASK_A = '11111111222233334444555555555555';
const TASK_B = 'aaaaaaaabbbbccccddddeeeeeeeeeeee';
const NOW = Date.now();
const MIN = 60_000;
const PR_NUMBER = 4242;
const WT = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-wt-'));
afterAll(() => fs.rmSync(WT, { recursive: true, force: true }));

let seq = 0;
const ids = (n: number) => Array.from({ length: n }, (_, i) => `parity.t${i}`);

function setTaskStatus(taskId: string, status: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO task_cache (task_id, fetched_at, raw_json) VALUES (?, ?, ?)`,
  ).run(normalizeTaskId(taskId), NOW, JSON.stringify({ status }));
}

function addOverride(taskId: string, testIds: string[]): void {
  seq += 1;
  db.prepare(
    `INSERT INTO staged_intent
       (id, kind, payload, payload_hash, task_id, project_id, state, created_at, updated_at)
     VALUES (?, 'test.override', ?, ?, ?, 'proj-1', 'committed', ?, ?)`,
  ).run(
    `ov-${seq}`,
    JSON.stringify({ taskId, testIds }),
    `h-${seq}`,
    taskId,
    NOW - 30 * MIN,
    NOW - 30 * MIN,
  );
}

function addFailedRun(testIds: string[]): string {
  const id = 'run-parity';
  db.prepare(
    `INSERT INTO test_request_runs
       (id, project_id, content_hash, session_id, state, output, requested_at, started_at, finished_at, worktree_path, structured_result)
     VALUES (?, 'proj-1', 'hash-parity', 'SA', 'failed', '', 0, ?, ?, ?, NULL)`,
  ).run(id, NOW - MIN, NOW - MIN, WT);
  const ins = db.prepare(
    `INSERT INTO test_run_results
       (test_request_run_id, project_id, test_id, name, outcome, duration_ms, concurrent_run_count, oom_killed, created_at)
     VALUES (?, 'proj-1', ?, 'n', 'failed', 1, 0, 0, ?)`,
  );
  for (const t of testIds) ins.run(id, t, NOW - MIN);
  return id;
}

type EntryPoint = (runId: string) => Promise<boolean>;

const entryPoints: Record<string, EntryPoint> = {
  'lane replay (evaluateSubject)': async (runId) => {
    markTestRequestRunAwaitingDisposition(runId);
    return (await evaluateSubject(runId, null)) === 'woken';
  },
  'paused-PR re-attribution (PRMergeWatcher)': async () => {
    upsertPullRequest({
      pr_number: PR_NUMBER,
      pr_url: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
      task_id: TASK_A,
      session_id: 'SA',
      repo: REPO,
      title: 'feat: parity',
      body: null,
      head_branch: 'feature/parity',
      base_branch: 'dev',
      state: 'open',
      draft: 0,
      review_result: null,
      review_at: null,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
      synced_at: '2024-01-01T00:00:00Z',
      head_sha: 'sha-1',
    } as never);
    setPauseReason(PR_NUMBER, REPO, 'ci_failing');
    const watcher = new PRMergeWatcher(
      {} as never,
      { on: vi.fn() } as never,
      undefined,
      vi.fn(),
    );
    vi.spyOn(watcher as never, 'applyPassedOutcomeTail').mockResolvedValue(
      undefined as never,
    );
    return (await watcher.reattributePausedPR(PR_NUMBER, REPO)) === 'redriven';
  },
  'PreReviewPipeline verify stage (filterVerifyFailureByBaseHealth)': async (
    runId,
  ) => {
    const filtered = await filterVerifyFailureByBaseHealth(
      PROJECT as unknown as ProjectConfig,
      runId,
      null,
      { sessionId: 'SA', worktreePath: WT },
    );
    return filtered?.passed === true;
  },
};

const scenarios: Array<{
  name: string;
  setup: () => string;
  expected: boolean;
}> = [
  {
    name: 'approved override covers every failure within the threshold',
    setup: () => {
      addOverride(TASK_A, ids(3));
      return addFailedRun(ids(3));
    },
    expected: true,
  },
  {
    name: 'mass-broken run even though overrides cover every failure',
    setup: () => {
      addOverride(TASK_A, ids(21));
      return addFailedRun(ids(21));
    },
    expected: false,
  },
  {
    name: "another task's override",
    setup: () => {
      addOverride(TASK_B, ids(3));
      return addFailedRun(ids(3));
    },
    expected: false,
  },
  {
    name: 'expired override (owning task terminal)',
    setup: () => {
      addOverride(TASK_A, ids(3));
      setTaskStatus(TASK_A, '✅ Done');
      return addFailedRun(ids(3));
    },
    expected: false,
  },
];

beforeEach(() => {
  for (const t of [
    'test_run_results',
    'test_request_runs',
    'staged_intent',
    'task_cache',
    'pull_requests',
    'session_feedback_inbox',
    'sessions',
  ]) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  insertSession({
    session_id: 'SA',
    task_id: TASK_A,
    task_url: 'https://notion.so/x',
    project_context_url: 'https://notion.so/p',
    project_id: 'proj-1',
    status: 'running',
    started_at: NOW - 60 * MIN,
    worktree_path: WT,
  } as never);
  setTaskStatus(TASK_A, '🔨 In Progress');
  setTaskStatus(TASK_B, '🔨 In Progress');
});

describe('gate parity across replay entry points', () => {
  for (const scenario of scenarios) {
    describe(scenario.name, () => {
      it.each(Object.entries(entryPoints))(
        `%s returns the same verdict (${scenario.expected ? 'excused' : 'not excused'})`,
        async (_label, entry) => {
          const runId = scenario.setup();
          expect(await entry(runId)).toBe(scenario.expected);
        },
      );
    });
  }
});
