/**
 * Tests for the ops candidate predicate's dep-gate reuse
 * (packages/backend/src/orchestration/planningCandidates.ts).
 *
 * AC: the ops predicate correctly reuses opsLoad's blockingDepsFor's existing
 * deploy-gate — a ✅ Done-but-undeployed dep excludes the candidate; a
 * ✅ Done-and-deployed dep does not.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../config', () => ({
  config: { notionApiKey: 'test', notionDatabaseId: 'test', port: 3000 },
}));

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { execFileSync } from 'child_process';
import { db } from '../../db/db.js';
import {
  insertProject,
  insertSession,
  insertLocalBranch,
  markLocalBranchMerged,
  recordProjectDeployedSha,
} from '../../db/queries.js';
import type { NotionTask } from '../../notion/types';
import { passesOpsDepGate, isOpsCandidate } from '../planningCandidates.js';

const PROJECT = 'proj-1';

function task(overrides: Partial<NotionTask> = {}): NotionTask {
  return {
    id: 'ops-task',
    title: 'An ops task',
    status: '🗂️ Ready',
    type: '🔧 Operational',
    dependsOn: [],
    notionUrl: '',
    ...overrides,
  };
}

// Real commit shas from this repo's own history, so createLocalGitAncestrySource's
// `git merge-base --is-ancestor` has a genuine ancestry relationship to check
// against, run with project_dir pointed at this checkout.
const repoDir = process.cwd();
const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir })
  .toString()
  .trim();
const ancestorSha = execFileSync('git', ['rev-parse', 'HEAD~3'], {
  cwd: repoDir,
})
  .toString()
  .trim();

function seedMergedDep(taskId: string, mergeCommitSha: string) {
  const sessionId = `sess-${taskId}`;
  insertSession({
    session_id: sessionId,
    task_id: `notion:${taskId}`,
    task_url: null,
    project_context_url: null,
    status: 'done',
    started_at: 0,
    session_type: 'standard',
    task_name: null,
    metadata: null,
    review_result: null,
    pause_reason: null,
    last_error_detail: null,
    events_pruned_at: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    compaction_count: 0,
    context_occupancy_tokens: 0,
  } as never);
  const branch = insertLocalBranch({
    project_id: PROJECT,
    session_id: sessionId,
    branch_name: `feature/${taskId}`,
    base_branch: 'dev',
    status: 'open',
    review_result: null,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  });
  markLocalBranchMerged(branch.id, mergeCommitSha);
}

beforeEach(() => {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM local_branches').run();
  db.prepare('DELETE FROM project_deployed_sha').run();
  db.prepare('DELETE FROM projects').run();

  insertProject({
    id: PROJECT,
    name: 'Project One',
    project_dir: repoDir,
    context_url: null,
    github_repo: null,
    task_source: 'notion',
  });
});

describe('passesOpsDepGate', () => {
  it('excludes a candidate whose ✅ Done dep is not yet deployed', async () => {
    seedMergedDep('dep-task', headSha);
    // Deployed SHA is an older commit that does not contain the dep's merge commit.
    recordProjectDeployedSha(PROJECT, ancestorSha);

    const tasksById = new Map<string, NotionTask>([
      [
        'dep-task',
        task({ id: 'dep-task', title: 'Dependency', status: '✅ Done' }),
      ],
    ]);
    const t = task({ dependsOn: ['dep-task'] });

    expect(await passesOpsDepGate(t, tasksById, PROJECT)).toBe(false);
  });

  it('includes a candidate whose ✅ Done dep is deployed', async () => {
    seedMergedDep('dep-task', headSha);
    // Deployed SHA now covers (is a descendant of / equal to) the dep's merge commit.
    recordProjectDeployedSha(PROJECT, headSha);

    const tasksById = new Map<string, NotionTask>([
      [
        'dep-task',
        task({ id: 'dep-task', title: 'Dependency', status: '✅ Done' }),
      ],
    ]);
    const t = task({ dependsOn: ['dep-task'] });

    expect(await passesOpsDepGate(t, tasksById, PROJECT)).toBe(true);
  });
});

describe('isOpsCandidate', () => {
  const baseDeps = {
    hasActiveSession: () => false,
    inCrashCooldown: () => false,
    projectId: PROJECT,
  };

  it('rejects a task that is not 🗂️ Ready', async () => {
    const t = task({ status: '🔲 Backlog' });
    expect(
      await isOpsCandidate(t, { ...baseDeps, tasksById: new Map() }),
    ).toBe(false);
  });

  it('rejects a Ready task of a non-ops-eligible Type', async () => {
    const t = task({ status: '🗂️ Ready', type: '💻 Code' });
    expect(
      await isOpsCandidate(t, { ...baseDeps, tasksById: new Map() }),
    ).toBe(false);
  });

  it('accepts a 🗂️ Ready 🔎 Investigation task with no deps', async () => {
    const t = task({ status: '🗂️ Ready', type: '🔎 Investigation' });
    expect(
      await isOpsCandidate(t, { ...baseDeps, tasksById: new Map() }),
    ).toBe(true);
  });

  it('skips a task with an active session (dedup)', async () => {
    const t = task({ status: '🗂️ Ready' });
    expect(
      await isOpsCandidate(t, {
        ...baseDeps,
        tasksById: new Map(),
        hasActiveSession: () => true,
      }),
    ).toBe(false);
  });

  it('skips a task within its crash-budget cooldown', async () => {
    const t = task({ status: '🗂️ Ready' });
    expect(
      await isOpsCandidate(t, {
        ...baseDeps,
        tasksById: new Map(),
        inCrashCooldown: () => true,
      }),
    ).toBe(false);
  });

  it('excludes a candidate whose dep is ✅ Done but undeployed', async () => {
    seedMergedDep('dep-task', headSha);
    recordProjectDeployedSha(PROJECT, ancestorSha);

    const tasksById = new Map<string, NotionTask>([
      [
        'dep-task',
        task({ id: 'dep-task', title: 'Dependency', status: '✅ Done' }),
      ],
    ]);
    const t = task({ status: '🗂️ Ready', dependsOn: ['dep-task'] });

    expect(await isOpsCandidate(t, { ...baseDeps, tasksById })).toBe(false);
  });
});
