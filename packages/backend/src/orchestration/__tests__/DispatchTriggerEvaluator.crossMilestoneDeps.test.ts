import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../../ops/opsLoad.js', () => ({
  loadOpsContext: async () => ({ worklist: { executable: [] } }),
  isOpsEligibleType: () => false,
  computeOpsBlockingDeps: async () => new Map(),
}));

import { DispatchTriggerEvaluator } from '../DispatchTriggerEvaluator';
import {
  insertProject,
  insertMilestone,
  upsertArm,
  upsertTaskCache,
} from '../../db/queries.js';
import type { NotionTask } from '../../notion/types.js';

/**
 * Real (unmocked) planningCandidates dep-gate behavior across milestones —
 * the sibling suite in DispatchTriggerEvaluator.test.ts stubs
 * isGroomCandidate/isDesignCandidate to always-true, so it can't exercise
 * this. Covers resolveProjectDep threading through scanProjectGroomCandidates
 * / scanProjectDesignCandidates.
 */
describe('DispatchTriggerEvaluator — cross-milestone dependency resolution', () => {
  const PROJECT = 'proj-cross-milestone-deps';
  const MILESTONE_A = 'milestone-a';
  const MILESTONE_B = 'milestone-b';

  function makeTask(overrides: Partial<NotionTask> & { id: string }): NotionTask {
    return {
      title: `Task ${overrides.id}`,
      status: '🔲 Backlog',
      type: '💻 Code',
      dependsOn: [],
      notionUrl: `https://notion.so/${overrides.id}`,
      ...overrides,
    };
  }

  beforeEach(async () => {
    const { db } = await import('../../db/db.js');
    db.prepare('DELETE FROM task_cache').run();
    db.prepare('DELETE FROM flow_arm').run();
    db.prepare('DELETE FROM milestones').run();
    db.prepare('DELETE FROM projects').run();

    insertProject({
      id: PROJECT,
      name: 'Cross Milestone Deps Project',
      project_dir: '/tmp/proj-cross-milestone-deps',
      context_url: null,
      github_repo: null,
      task_source: 'notion',
    });

    insertMilestone({
      id: MILESTONE_A,
      project_id: PROJECT,
      name: 'Milestone A',
      source_id: null,
      canonical_short_id: null,
      wrapped_at: null,
    });
    insertMilestone({
      id: MILESTONE_B,
      project_id: PROJECT,
      name: 'Milestone B',
      source_id: null,
      canonical_short_id: null,
      wrapped_at: null,
    });

    for (const milestoneId of [MILESTONE_A, MILESTONE_B]) {
      upsertArm(milestoneId, 'groom', true, Date.now());
      upsertArm(milestoneId, 'design', true, Date.now());
    }
  });

  function makeEvaluator(): DispatchTriggerEvaluator {
    return new DispatchTriggerEvaluator({} as never, {} as never);
  }

  it('admits a groom candidate whose dep is ✅ Done on a different milestone board of the same project', async () => {
    upsertTaskCache(
      `board:${MILESTONE_A}`,
      JSON.stringify([
        makeTask({ id: 'task-dependent', dependsOn: ['dep-on-b'] }),
      ]),
    );
    upsertTaskCache(
      `board:${MILESTONE_B}`,
      JSON.stringify([
        makeTask({ id: 'dep-on-b', type: '📐 Design', status: '✅ Done' }),
      ]),
    );

    const evaluator = makeEvaluator();
    const candidates = await (evaluator as any).scanProjectGroomCandidates(
      PROJECT,
    );
    expect(candidates.map((c: any) => c.task.id)).toEqual(['task-dependent']);
  });

  it('blocks the same cross-board dependency when it is not ✅ Done, per normal status rules', async () => {
    upsertTaskCache(
      `board:${MILESTONE_A}`,
      JSON.stringify([
        makeTask({ id: 'task-dependent', dependsOn: ['dep-on-b'] }),
      ]),
    );
    upsertTaskCache(
      `board:${MILESTONE_B}`,
      JSON.stringify([
        makeTask({
          id: 'dep-on-b',
          type: '📐 Design',
          status: '📐 In Progress',
        }),
      ]),
    );

    const evaluator = makeEvaluator();
    const candidates = await (evaluator as any).scanProjectGroomCandidates(
      PROJECT,
    );
    expect(candidates).toEqual([]);
  });

  it('behaves identically for scanProjectDesignCandidates', async () => {
    upsertTaskCache(
      `board:${MILESTONE_A}`,
      JSON.stringify([
        makeTask({
          id: 'design-dependent',
          type: '📐 Design',
          status: '🗂️ Ready',
          dependsOn: ['dep-on-b'],
        }),
      ]),
    );
    upsertTaskCache(
      `board:${MILESTONE_B}`,
      JSON.stringify([
        makeTask({ id: 'dep-on-b', type: '💻 Code', status: '✅ Done' }),
      ]),
    );

    const evaluator = makeEvaluator();
    const candidates = await (evaluator as any).scanProjectDesignCandidates(
      PROJECT,
    );
    expect(candidates.map((c: any) => c.task.id)).toEqual([
      'design-dependent',
    ]);
  });

  it('still fails the gate closed for a dependency present on no board of the project', async () => {
    upsertTaskCache(
      `board:${MILESTONE_A}`,
      JSON.stringify([
        makeTask({ id: 'task-dependent', dependsOn: ['nowhere-dep'] }),
      ]),
    );
    upsertTaskCache(`board:${MILESTONE_B}`, JSON.stringify([]));

    const evaluator = makeEvaluator();
    const candidates = await (evaluator as any).scanProjectGroomCandidates(
      PROJECT,
    );
    expect(candidates).toEqual([]);
  });
});
