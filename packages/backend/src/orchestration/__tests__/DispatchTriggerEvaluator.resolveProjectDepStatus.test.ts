import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { resolveProjectDepStatus } from '../DispatchTriggerEvaluator';
import {
  insertProject,
  insertMilestone,
  upsertTaskCache,
} from '../../db/queries.js';
import type { NotionTask } from '../../notion/types.js';

/**
 * resolveProjectDepStatus is the shared, route-reusable core behind
 * DispatchTriggerEvaluator.resolveProjectDep — it must distinguish a dep
 * confirmed absent from every board (dangling) from a dep that couldn't be
 * checked because some board isn't cached yet (unknown), and must never
 * touch the network to do it (see routes/tasks.ts's annotateGroomDepBlocking,
 * which runs on every poll of a frequently refetched task list).
 */
describe('resolveProjectDepStatus', () => {
  const PROJECT = 'proj-resolve-dep-status';
  const MILESTONE_A = 'rds-milestone-a';
  const MILESTONE_B = 'rds-milestone-b';

  function makeTask(
    overrides: Partial<NotionTask> & { id: string },
  ): NotionTask {
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
    db.prepare('DELETE FROM milestones').run();
    db.prepare('DELETE FROM projects').run();

    insertProject({
      id: PROJECT,
      name: 'Resolve Dep Status Project',
      project_dir: '/tmp/proj-resolve-dep-status',
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
  });

  it('resolves a dep found on a different milestone board of the same project', () => {
    upsertTaskCache(`board:${MILESTONE_A}`, JSON.stringify([]));
    upsertTaskCache(
      `board:${MILESTONE_B}`,
      JSON.stringify([makeTask({ id: 'dep-on-b', title: 'Dep on B' })]),
    );

    const result = resolveProjectDepStatus(PROJECT, 'dep-on-b');
    expect(result.status).toBe('found');
    expect(result.status === 'found' && result.task.title).toBe('Dep on B');
  });

  it('reports dangling when every board is cached and none contain the dep id', () => {
    upsertTaskCache(`board:${MILESTONE_A}`, JSON.stringify([]));
    upsertTaskCache(`board:${MILESTONE_B}`, JSON.stringify([]));

    expect(resolveProjectDepStatus(PROJECT, 'nowhere-dep')).toEqual({
      status: 'dangling',
    });
  });

  it('reports unknown, not dangling, when a board has no task_cache row (cold cache)', () => {
    upsertTaskCache(`board:${MILESTONE_A}`, JSON.stringify([]));
    // MILESTONE_B has no cache row at all.

    expect(resolveProjectDepStatus(PROJECT, 'some-dep')).toEqual({
      status: 'unknown',
    });
  });

  it('a cold cache across every board does not mass-flag deps as dangling', () => {
    // Neither milestone has a task_cache row.
    expect(resolveProjectDepStatus(PROJECT, 'any-dep')).toEqual({
      status: 'unknown',
    });
  });

  it('still finds a dep when one board is cold but another (cached) board has it', () => {
    // MILESTONE_A has no cache row; MILESTONE_B has the dep.
    upsertTaskCache(
      `board:${MILESTONE_B}`,
      JSON.stringify([makeTask({ id: 'dep-on-b', title: 'Dep on B' })]),
    );

    const result = resolveProjectDepStatus(PROJECT, 'dep-on-b');
    expect(result.status).toBe('found');
  });

  it('issues zero Notion network calls — resolution is served from task_cache only', () => {
    upsertTaskCache(`board:${MILESTONE_A}`, JSON.stringify([]));
    upsertTaskCache(`board:${MILESTONE_B}`, JSON.stringify([]));

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      resolveProjectDepStatus(PROJECT, 'nowhere-dep');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
