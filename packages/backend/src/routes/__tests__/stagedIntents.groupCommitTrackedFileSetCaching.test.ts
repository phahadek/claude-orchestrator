/**
 * commitGroupIntents' apply loop, for a 💻 Code task.setStatus→Ready member,
 * runs TaskWriteCommands.setStatus -> checkGroomingPromotionGate ->
 * resolveFilesPathsEntriesServerSide -> resolveTrackedFileSet, which shells
 * out to `git ls-files` whenever a Files/paths entry needs tracked-file
 * resolution. Uncached, a group commit containing N such members re-spawns
 * that subprocess once per member even though the result is identical for
 * every member within the same commit (same repo). This asserts a
 * commit-scoped cache bounds the subprocess to at most one spawn for the
 * whole commit, regardless of member count — mirrors
 * stagedIntents.groupBlockedSignalsCachingWritePath.test.ts's shape, applied
 * to this separate expensive-per-member-work instance of the same bug class.
 *
 * Deliberately does NOT mock resolveTrackedFileSet itself — that function
 * *is* the caching logic under test. Instead this mocks `child_process`'s
 * `execFile` (what groomLoad.ts's `git()` helper shells out through), so the
 * real resolveTrackedFileSet/cache code runs and only the actual subprocess
 * spawn is counted.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promisify } from 'util';
import express from 'express';
import supertest from 'supertest';

const {
  mockGetTaskBackend,
  mockRecordEvent,
  mockClassifyReadyProposal,
  execFileSpy,
} = vi.hoisted(() => ({
  mockGetTaskBackend: vi.fn(),
  mockRecordEvent: vi.fn(),
  mockClassifyReadyProposal: vi.fn(),
  execFileSpy: vi.fn(),
}));

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: mockGetTaskBackend,
}));

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: mockRecordEvent,
}));

vi.mock('../../tasks/deferralClassifier', () => ({
  classifyReadyProposal: mockClassifyReadyProposal,
}));

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../../db/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/queries')>();
  return {
    ...actual,
    getTaskCache: vi.fn().mockReturnValue(null),
  };
});

const FAKE_REPO_ROOT = 'FAKE_REPO_ROOT';

vi.mock('../../projects/ProjectService', () => ({
  ProjectService: {
    getById: (id: string) => ({ id, projectDir: FAKE_REPO_ROOT, milestones: [] }),
  },
}));

/**
 * Replaces the `git` subprocess spawn `resolveTrackedFileSet` ultimately
 * shells out through (groomLoad.ts's internal `git()` -> `execFileAsync`)
 * with a fake that always succeeds with a fixed `git ls-files` output —
 * groomLoad.ts's own caching (or lack of it) above this point is left
 * completely real. Mirrors Node's own `util.promisify.custom` tagging on
 * `child_process.execFile` so `promisify(execFile)` (what groomLoad.ts
 * calls at module scope) resolves `{ stdout, stderr }` exactly as the real
 * one does, instead of the generic array-of-callback-args promisify shape.
 */
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const fakeExecFile = (
    ...args: unknown[]
  ): ReturnType<typeof actual.execFile> => {
    const cb = args[args.length - 1] as
      | ((err: Error | null, stdout: string, stderr: string) => void)
      | undefined;
    execFileSpy(...args.slice(0, -1));
    if (typeof cb === 'function') {
      cb(null, 'README.md\n.gitignore\npackage.json\n', '');
    }
    return {} as ReturnType<typeof actual.execFile>;
  };
  Object.defineProperty(fakeExecFile, promisify.custom, {
    value: (...args: unknown[]) => {
      execFileSpy(...args);
      return Promise.resolve({
        stdout: 'README.md\n.gitignore\npackage.json\n',
        stderr: '',
      });
    },
  });
  return {
    ...actual,
    execFile: fakeExecFile,
  };
});

vi.mock('../../gate/gateStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../gate/gateStore')>();
  return {
    ...actual,
    getAccretionMarker: () => ({
      sourceTaskId: 'any',
      project: 'p',
      milestone: 'M1',
      decision: 'n/a' as const,
      reason: 'nothing runtime-observable',
      accretedAt: new Date(0).toISOString(),
    }),
  };
});

vi.mock('../../seed/seedStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../seed/seedStore')>();
  return {
    ...actual,
    getAccretionMarker: () => ({
      sourceTaskId: 'any',
      project: 'p',
      milestone: 'M1',
      decision: 'n/a' as const,
      accretedAt: new Date(0).toISOString(),
    }),
  };
});

import { db } from '../../db/db';
import { getTaskCache } from '../../db/queries';
import { createStagedIntentsRouter } from '../stagedIntents';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter());
  return app;
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  mockRecordEvent.mockReset();
  mockClassifyReadyProposal.mockReset();
  mockClassifyReadyProposal.mockResolvedValue(undefined);
  execFileSpy.mockClear();
  vi.mocked(getTaskCache).mockReturnValue(null);
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
});

const CODE_TASK_BODY =
  '## Summary\nDo a thing.\n\n## Files / paths affected\n- `README.md`\n';

function countLsFilesCalls(): number {
  return execFileSpy.mock.calls.filter(
    (call) => call[0] === 'git' && Array.isArray(call[1]) && call[1][0] === 'ls-files',
  ).length;
}

/**
 * Stages `memberCount` independent 💻 Code task.setStatus->Ready intents
 * (each a distinct taskId, each preceded by a satisfied task.setDependsOn
 * for the same taskId) in one group, then approves the whole group in one
 * commit via override:true (bypassing the unrelated readiness-gate floor
 * facts a 💻 Code Ready-flip would otherwise also need — out of scope for
 * this test, which is about the grooming-gate's tracked-file resolution).
 */
async function stageAndApproveCodeGroup(
  agent: ReturnType<typeof supertest>,
  projectId: string,
  groupId: string,
  memberCount: number,
): Promise<{ status: number; body: any }> {
  for (let i = 0; i < memberCount; i += 1) {
    const taskId = `t-${groupId}-${i}`;
    await agent.post('/api/staged-intents').send({
      kind: 'task.setDependsOn',
      projectId,
      groupId,
      payload: { taskId, dependsOn: [] },
    });
    await agent.post('/api/staged-intents').send({
      kind: 'task.setStatus',
      projectId,
      groupId,
      payload: {
        taskId,
        status: 'Ready',
        groomingGate: {
          type: '💻 Code',
          size_check: { decision: 'n/a' },
          type_check: { decision: 'none' },
        },
      },
    });
  }

  // Staging itself also runs a stage-time twin of this same gate
  // (runStageTimeReadyChecks, via routeStageTimeBlock) once per staged
  // task.setStatus — out of scope for this test, which is specifically
  // about commitGroupIntents' own apply loop. Clear the spy so only calls
  // made during the commit itself are counted below.
  execFileSpy.mockClear();

  return agent
    .post(`/api/staged-intents/group/${groupId}/approve`)
    .send({ override: true, reason: 'test: bypass readiness floor facts' });
}

describe('commitGroupIntents — tracked-file-set resolution caching', () => {
  it('spawns `git ls-files` at most once for a commit with multiple 💻 Code Ready-flip members', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue(CODE_TASK_BODY),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn(),
    });

    const app = makeApp();
    const agent = supertest(app);

    const result = await stageAndApproveCodeGroup(
      agent,
      'proj-tfsc-1',
      'g-tfsc-1',
      5,
    );

    expect(result.status).toBe(200);
    expect(result.body.committed).toHaveLength(10);
    // Uncached, this would scale with member count — checkGroomingPromotionGate
    // runs once per arming row in precheckGroupCommit AND once per member as
    // the apply loop applies it, so 5 members would spawn `git ls-files` 10
    // times. Cached, it's spawned at most once for the whole commit.
    expect(countLsFilesCalls()).toBeLessThanOrEqual(1);
  });

  it('spawns `git ls-files` exactly once for a single-member commit (sanity baseline)', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue(CODE_TASK_BODY),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn(),
    });

    const app = makeApp();
    const agent = supertest(app);

    const result = await stageAndApproveCodeGroup(
      agent,
      'proj-tfsc-2',
      'g-tfsc-2',
      1,
    );

    expect(result.status).toBe(200);
    expect(countLsFilesCalls()).toBe(1);
  });
});
