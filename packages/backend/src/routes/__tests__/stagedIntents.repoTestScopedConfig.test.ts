/**
 * Feeds this repo's real .claude-orchestrator.yml through test.request command
 * resolution (same harness as stagedIntents.testScopedCommandResolution.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

const { mockGetProjectById, mockComputeHash, mockGetChangedFiles, mockAdmit } =
  vi.hoisted(() => ({
    mockGetProjectById: vi.fn(),
    mockComputeHash: vi.fn(),
    mockGetChangedFiles: vi.fn(),
    mockAdmit: vi.fn(),
  }));

vi.mock('../../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config')>();
  return { ...actual, getProjectById: mockGetProjectById };
});

vi.mock('../../session/analyzeGating', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../session/analyzeGating')>();
  return { ...actual, computeWholeTreeContentHash: mockComputeHash };
});

vi.mock('../../session/autofix-runner', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../session/autofix-runner')>();
  return { ...actual, getChangedFiles: mockGetChangedFiles };
});

vi.mock('../../orchestration/testRequestLane', () => ({
  admitTestRequest: mockAdmit,
  checkTestRequestHold: () => ({ held: false }),
}));

import { db } from '../../db/db';
import { stageIntent, routeStageTimeBlock } from '../stagedIntents';
import { insertSession, updateSessionWorktreePath } from '../../db/queries';
import { typedSetSetting } from '../../config/settings';
import { loadOrchestratorConfig } from '../../session/orchestrator-config';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');

async function resolveFor(sessionId: string, diff: string[]) {
  mockGetChangedFiles.mockResolvedValue(diff);
  insertSession({
    session_id: sessionId,
    task_id: 'task-1',
    task_url: null,
    project_context_url: null,
    status: 'running',
    started_at: Date.now(),
  });
  updateSessionWorktreePath(sessionId, '/tmp/wt');
  const intent = stageIntent(
    'test.request',
    { taskId: 'task-1', reason: 'confirm' },
    'proj-1',
    null,
    sessionId,
  );
  await routeStageTimeBlock(intent, undefined);
  return mockAdmit.mock.calls[0][0] as { commands: string[]; runKind: string };
}

beforeEach(() => {
  mockGetChangedFiles.mockReset();
  mockAdmit.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM pull_requests').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM session_test_request_cycles').run();
  db.prepare('DELETE FROM session_feedback_inbox').run();
  mockGetProjectById.mockReturnValue({
    id: 'proj-1',
    projectDir: REPO_ROOT,
    baseBranch: 'dev',
  });
  mockComputeHash.mockResolvedValue('hash-1');
  mockAdmit.mockImplementation(() => ({
    runId: 'run-1',
    status: 'running',
    position: 0,
    queueDepth: 0,
    reused: false,
    result: Promise.resolve({
      runId: 'run-1',
      passed: true,
      output: 'ok',
      joined: false,
    }),
  }));
  typedSetSetting('test_request_cycle_limit', 3);
});

describe("this repo's .claude-orchestrator.yml test scoping", () => {
  it('declares non-empty test_scoped and test_full_run_paths and loads cleanly', () => {
    const config = loadOrchestratorConfig(REPO_ROOT);
    expect(config.test_scoped.length).toBeGreaterThan(0);
    expect(config.test_full_run_paths.length).toBeGreaterThan(0);
    expect(config.test_report_glob).toBe('**/.test-reports/*.xml');
  });

  // scripts/scoped-tests.mjs filters paths per workspace, so the frontend
  // invocation of a backend-only diff runs nothing and writes an empty report.
  it('a backend-only diff resolves to scoped commands', async () => {
    const r = await resolveFor('s-backend', [
      'packages/backend/src/routes/foo.ts',
    ]);
    expect(r.runKind).toBe('scoped');
    expect(r.commands).toEqual([
      "node scripts/scoped-tests.mjs frontend 'packages/backend/src/routes/foo.ts'",
      "node scripts/scoped-tests.mjs backend 'packages/backend/src/routes/foo.ts'",
    ]);
  });

  it('a package-lock.json diff resolves to the full test: commands', async () => {
    const r = await resolveFor('s-lock', [
      'package-lock.json',
      'packages/backend/src/routes/foo.ts',
    ]);
    expect(r.runKind).toBe('full');
    expect(r.commands).toEqual(loadOrchestratorConfig(REPO_ROOT).test);
  });
});
