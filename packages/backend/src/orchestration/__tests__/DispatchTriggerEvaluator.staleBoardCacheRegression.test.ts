import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { DispatchTriggerEvaluator } from '../DispatchTriggerEvaluator';
import {
  insertProject,
  insertMilestone,
  upsertArm,
  upsertTaskCache,
  recordTaskStatusWrite,
} from '../../db/queries';
import { NotionTaskBackend } from '../../tasks/NotionTaskBackend';
import type { ResolvedTask } from '../../tasks/types';

/**
 * Regression test for TaskCacheRefresher's periodic poll clobbering a
 * just-applied status promotion: a task promoted out of Backlog, followed by
 * a TaskCacheRefresher-shaped fetchReadyTasks() call carrying a stale
 * pre-promotion board snapshot, must not re-qualify as a groom candidate on
 * the next scan. Mirrors DispatchTriggerEvaluator.idleGroomRegression.test.ts
 * (a different duplicate-dispatch mechanism) but exercises the
 * NotionTaskBackend.fetchReadyTasks write path instead of a raw task_cache
 * seed.
 */
describe('DispatchTriggerEvaluator — stale TaskCacheRefresher poll does not revert a promotion', () => {
  const PROJECT = 'proj-stale-board-cache-regression';
  const MILESTONE = 'milestone-stale-board-cache-regression';
  const RAW_TASK_ID = 'eeee5555-ffff-6666-0000-111122223333';
  const PREFIXED_TASK_ID = `notion:${RAW_TASK_ID}`;

  function makeResolvedTask(status: string): ResolvedTask {
    return {
      task: {
        id: RAW_TASK_ID,
        title: 'A task promoted out of Backlog',
        status,
        type: '💻 Code',
        dependsOn: [],
        notionUrl: `https://notion.so/${RAW_TASK_ID}`,
      },
      source: 'notion',
      blocked: false,
      blockers: [],
      nonCode: false,
      wave: 0,
    };
  }

  beforeEach(async () => {
    const { db } = await import('../../db/db.js');
    db.prepare('DELETE FROM task_cache').run();
    db.prepare('DELETE FROM task_status_writes').run();
    db.prepare('DELETE FROM flow_arm').run();
    db.prepare('DELETE FROM milestones').run();
    db.prepare('DELETE FROM projects').run();
    db.prepare('DELETE FROM sessions').run();

    insertProject({
      id: PROJECT,
      name: 'Stale Board Cache Regression Project',
      project_dir: '/tmp/proj-stale-board-cache-regression',
      context_url: null,
      github_repo: null,
      task_source: 'notion',
    });
    insertMilestone({
      id: MILESTONE,
      project_id: PROJECT,
      name: 'Stale Board Cache Regression Milestone',
      source_id: 'source-db-id-stale-regression',
      canonical_short_id: null,
      wrapped_at: null,
    });
    upsertArm(MILESTONE, 'groom', true, Date.now());
  });

  function makeEvaluator(): DispatchTriggerEvaluator {
    return new DispatchTriggerEvaluator({} as never, {} as never);
  }

  it('excludes the promoted task from groom candidates after a stale refresh', async () => {
    // The promotion: task_cache is patched and the write is recorded, the
    // same way AuditingTaskBackend.updateStatus does on a real status write.
    upsertTaskCache(`board:${MILESTONE}`, JSON.stringify([]));
    recordTaskStatusWrite(PREFIXED_TASK_ID, '🗂️ Ready');

    // A TaskCacheRefresher-shaped poll: fetchReadyTasks() on a Notion
    // backend whose underlying client still returns the pre-promotion
    // snapshot (the stale NotionClient board-level cache read).
    const staleClient = {
      fetchReadyTasks: vi
        .fn()
        .mockResolvedValue([makeResolvedTask('🔲 Backlog')]),
    };
    const backend = new NotionTaskBackend(staleClient as never);
    await backend.fetchReadyTasks(MILESTONE);

    const evaluator = makeEvaluator();
    const candidates = await (evaluator as any).scanProjectGroomCandidates(
      PROJECT,
    );

    expect(candidates).toEqual([]);
  });
});
