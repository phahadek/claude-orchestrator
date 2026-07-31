/**
 * Tests for the docs candidate predicate (packages/backend/src/orchestration/planningCandidates.ts).
 *
 * AC: isDocsCandidate returns false for every 🎨 Assets task regardless of
 * arm state or dependency status, mirroring isDesignCandidate's shape but
 * scoped to 📝 Docs only. It reuses the ops dep-gate (Done + deployed)
 * verbatim, unlike isDesignCandidate's Done-only gate.
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
import { isDocsCandidate, isDocsEligibleType } from '../planningCandidates.js';

const PROJECT = 'proj-1';

function task(overrides: Partial<NotionTask> = {}): NotionTask {
  return {
    id: 'docs-task',
    title: 'A docs task',
    status: '🗂️ Ready',
    type: '📝 Docs',
    dependsOn: [],
    notionUrl: '',
    ...overrides,
  };
}

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

describe('isDocsEligibleType', () => {
  it('admits 📝 Docs', () => {
    expect(isDocsEligibleType('📝 Docs')).toBe(true);
  });

  it('rejects 🎨 Assets and other non-docs Types', () => {
    expect(isDocsEligibleType('🎨 Assets')).toBe(false);
    expect(isDocsEligibleType('💻 Code')).toBe(false);
    expect(isDocsEligibleType('📐 Design')).toBe(false);
  });
});

describe('isDocsCandidate', () => {
  const baseDeps = {
    tasksById: new Map<string, NotionTask>(),
    hasActiveSession: () => false,
    hasActiveDocsSession: () => false,
    inCrashCooldown: () => false,
    projectId: PROJECT,
    armed: true,
  };

  it('excludes a 🗂️ Ready 📝 Docs task while the docs flow is disarmed', async () => {
    const t = task();
    expect(await isDocsCandidate(t, { ...baseDeps, armed: false })).toBe(
      false,
    );
  });

  it('includes a 🗂️ Ready 📝 Docs task once the docs flow is armed', async () => {
    const t = task();
    expect(await isDocsCandidate(t, baseDeps)).toBe(true);
  });

  it('rejects a task that is not 🗂️ Ready', async () => {
    const t = task({ status: '🔲 Backlog' });
    expect(await isDocsCandidate(t, baseDeps)).toBe(false);
  });

  it.each(['armed', 'disarmed'])(
    'returns false for every 🎨 Assets task regardless of arm state or dependency status (%s)',
    async (armState) => {
      const armed = armState === 'armed';

      const noDeps = task({ type: '🎨 Assets' });
      expect(await isDocsCandidate(noDeps, { ...baseDeps, armed })).toBe(
        false,
      );

      seedMergedDep('dep-task', headSha);
      recordProjectDeployedSha(PROJECT, headSha);
      const tasksById = new Map<string, NotionTask>([
        [
          'dep-task',
          task({ id: 'dep-task', title: 'Dependency', status: '✅ Done' }),
        ],
      ]);
      const clearedDeps = task({
        type: '🎨 Assets',
        dependsOn: ['dep-task'],
      });
      expect(
        await isDocsCandidate(clearedDeps, { ...baseDeps, armed, tasksById }),
      ).toBe(false);
    },
  );

  it('skips a task with an active standard session (dedup)', async () => {
    const t = task();
    expect(
      await isDocsCandidate(t, { ...baseDeps, hasActiveSession: () => true }),
    ).toBe(false);
  });

  it('skips a task with an active docs session (dedup)', async () => {
    const t = task();
    expect(
      await isDocsCandidate(t, {
        ...baseDeps,
        hasActiveDocsSession: () => true,
      }),
    ).toBe(false);
  });

  it('skips a task within its crash-budget cooldown', async () => {
    const t = task();
    expect(
      await isDocsCandidate(t, { ...baseDeps, inCrashCooldown: () => true }),
    ).toBe(false);
  });

  it('excludes a candidate whose ✅ Done dep is not yet deployed', async () => {
    seedMergedDep('dep-task', headSha);
    recordProjectDeployedSha(PROJECT, ancestorSha);

    const tasksById = new Map<string, NotionTask>([
      [
        'dep-task',
        task({ id: 'dep-task', title: 'Dependency', status: '✅ Done' }),
      ],
    ]);
    const t = task({ dependsOn: ['dep-task'] });

    expect(await isDocsCandidate(t, { ...baseDeps, tasksById })).toBe(false);
  });

  it('includes a candidate whose ✅ Done dep is deployed', async () => {
    seedMergedDep('dep-task', headSha);
    recordProjectDeployedSha(PROJECT, headSha);

    const tasksById = new Map<string, NotionTask>([
      [
        'dep-task',
        task({ id: 'dep-task', title: 'Dependency', status: '✅ Done' }),
      ],
    ]);
    const t = task({ dependsOn: ['dep-task'] });

    expect(await isDocsCandidate(t, { ...baseDeps, tasksById })).toBe(true);
  });
});
