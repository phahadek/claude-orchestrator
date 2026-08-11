import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../../ops/opsLoad.js', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    loadOpsContext: vi.fn(),
  };
});

import { DispatchTriggerEvaluator } from '../DispatchTriggerEvaluator';
import {
  insertProject,
  insertMilestone,
  upsertArm,
  upsertTaskCache,
  insertSession,
  updateTaskStatusInBoardCaches,
} from '../../db/queries.js';
import type { NotionTask } from '../../notion/types.js';
import type { ProjectConfig } from '../../config';

/**
 * Regression coverage for the scan-vs-launch race: DispatchTriggerEvaluator
 * used to compute the eligible candidate list once at scan time and then
 * dispatch from it with no re-check, so a slow poll could dispatch a groom
 * onto a task whose status/session state changed during the poll (observed
 * live: a groom launched onto a task promoted to Ready seconds earlier).
 * These exercise the real isGroomCandidate / isDesignCandidate /
 * isDocsCandidate predicates end to end via tickOnce (no planningCandidates
 * mock), so the fix is proven against the same predicate used at scan time
 * rather than a hand-written subset.
 */
describe('DispatchTriggerEvaluator — re-validate immediately before launch', () => {
  const PROJECT = 'proj-race-revalidate';
  const MILESTONE = 'milestone-race-revalidate';

  function backlogTask(id: string, type = '💻 Code'): NotionTask {
    return {
      id,
      title: `Task ${id}`,
      status: '🔲 Backlog',
      type,
      dependsOn: [],
      notionUrl: `https://notion.so/${id}`,
    };
  }

  function readyTask(id: string, type = '📝 Docs'): NotionTask {
    return {
      id,
      title: `Task ${id}`,
      status: '🗂️ Ready',
      type,
      dependsOn: [],
      notionUrl: `https://notion.so/${id}`,
    };
  }

  beforeEach(async () => {
    const { db } = await import('../../db/db.js');
    db.prepare('DELETE FROM task_cache').run();
    db.prepare('DELETE FROM flow_arm').run();
    db.prepare('DELETE FROM milestones').run();
    db.prepare('DELETE FROM projects').run();
    db.prepare('DELETE FROM sessions').run();
    db.prepare(
      "DELETE FROM audit_log WHERE event_type = 'planning_dispatch_launched'",
    ).run();

    insertProject({
      id: PROJECT,
      name: 'Race Revalidate Project',
      project_dir: '/tmp/proj-race-revalidate',
      context_url: null,
      github_repo: null,
      task_source: 'notion',
    });
    insertMilestone({
      id: MILESTONE,
      project_id: PROJECT,
      name: 'Race Revalidate Milestone',
      source_id: null,
      canonical_short_id: null,
      wrapped_at: null,
    });
  });

  function makeEvaluator(launcher: {
    launchSelected: ReturnType<typeof vi.fn>;
  }): DispatchTriggerEvaluator {
    const sessionManager = { getLivePlanningSessionCount: () => 0 };
    return new DispatchTriggerEvaluator(
      sessionManager as never,
      launcher as never,
      { listProjects: () => [{ id: PROJECT } as ProjectConfig] },
    );
  }

  it('does not dispatch a groom candidate whose status left Backlog between scan and launch', async () => {
    upsertArm(MILESTONE, 'groom', true, Date.now());
    upsertTaskCache(
      `board:${MILESTONE}`,
      JSON.stringify([backlogTask('task-a'), backlogTask('task-b')]),
    );

    // Simulate the race: while task-a's dispatch is in flight, task-b gets
    // promoted to Ready by something else (e.g. an operator/groom session) —
    // the same by-value sequence observed live.
    const launchSelected = vi.fn().mockImplementation(async (params) => {
      const taskId = params.tasks[0].id;
      if (taskId.includes('task-a')) {
        updateTaskStatusInBoardCaches('task-b', '🗂️ Ready');
      }
      return { launched: [taskId], deferred: [], failed: [] };
    });
    const evaluator = makeEvaluator({ launchSelected });

    const dispatched = await evaluator.tickOnce();

    expect(dispatched).toBe(1);
    expect(launchSelected).toHaveBeenCalledTimes(1);
    expect(launchSelected.mock.calls[0][0].tasks[0].id).toContain('task-a');
  });

  it('does not dispatch a groom candidate that gained an active session between scan and launch', async () => {
    upsertArm(MILESTONE, 'groom', true, Date.now());
    upsertTaskCache(
      `board:${MILESTONE}`,
      JSON.stringify([backlogTask('task-a'), backlogTask('task-b')]),
    );

    const launchSelected = vi.fn().mockImplementation(async (params) => {
      const taskId = params.tasks[0].id;
      if (taskId.includes('task-a')) {
        // A groom session appears for task-b mid-poll — e.g. an operator
        // manually launched it while the slow poll was still running.
        insertSession({
          session_id: 'sess-race',
          task_id: 'task-b',
          task_url: 'https://notion.so/task-b',
          project_context_url: 'https://notion.so/ctx',
          status: 'running',
          started_at: Date.now(),
          session_type: 'groom',
        });
      }
      return { launched: [taskId], deferred: [], failed: [] };
    });
    const evaluator = makeEvaluator({ launchSelected });

    const dispatched = await evaluator.tickOnce();

    expect(dispatched).toBe(1);
    expect(launchSelected).toHaveBeenCalledTimes(1);
    expect(launchSelected.mock.calls[0][0].tasks[0].id).toContain('task-a');
  });

  it('counts a skipped-at-launch candidate in the poll skipped total (log line stays truthful)', async () => {
    upsertArm(MILESTONE, 'groom', true, Date.now());
    upsertTaskCache(
      `board:${MILESTONE}`,
      JSON.stringify([backlogTask('task-a'), backlogTask('task-b')]),
    );

    const launchSelected = vi.fn().mockImplementation(async (params) => {
      const taskId = params.tasks[0].id;
      if (taskId.includes('task-a')) {
        updateTaskStatusInBoardCaches('task-b', '🗂️ Ready');
      }
      return { launched: [taskId], deferred: [], failed: [] };
    });
    const evaluator = makeEvaluator({ launchSelected });

    const { logger } = await import('../../logger.js');
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});

    await evaluator.tickOnce();

    const [message] = infoSpy.mock.calls.find(
      ([m]) => typeof m === 'string' && m.includes('poll complete'),
    ) as [string];
    expect(message).toContain('eligible=2');
    expect(message).toContain('launched=1');
    expect(message).toContain('skipped=1');

    infoSpy.mockRestore();
  });

  it('dispatches a candidate that is still eligible at launch, unchanged from today', async () => {
    upsertArm(MILESTONE, 'groom', true, Date.now());
    upsertTaskCache(
      `board:${MILESTONE}`,
      JSON.stringify([backlogTask('task-a')]),
    );

    const launchSelected = vi.fn().mockResolvedValue({
      launched: ['task-a'],
      deferred: [],
      failed: [],
    });
    const evaluator = makeEvaluator({ launchSelected });

    const dispatched = await evaluator.tickOnce();

    expect(dispatched).toBe(1);
    expect(launchSelected).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch a design candidate whose status left Ready between scan and launch', async () => {
    upsertArm(MILESTONE, 'design', true, Date.now());
    upsertTaskCache(
      `board:${MILESTONE}`,
      JSON.stringify([
        readyTask('design-a', '📐 Design'),
        readyTask('design-b', '📐 Design'),
      ]),
    );

    const launchSelected = vi.fn().mockImplementation(async (params) => {
      const taskId = params.tasks[0].id;
      if (taskId.includes('design-a')) {
        updateTaskStatusInBoardCaches('design-b', '🔲 Backlog');
      }
      return { launched: [taskId], deferred: [], failed: [] };
    });
    const evaluator = makeEvaluator({ launchSelected });

    const dispatched = await evaluator.tickOnce();

    expect(dispatched).toBe(1);
    expect(launchSelected).toHaveBeenCalledTimes(1);
    expect(launchSelected.mock.calls[0][0].tasks[0].id).toContain('design-a');
  });

  it('does not dispatch a docs candidate whose status left Ready between scan and launch', async () => {
    upsertArm(MILESTONE, 'docs', true, Date.now());
    upsertTaskCache(
      `board:${MILESTONE}`,
      JSON.stringify([readyTask('docs-a'), readyTask('docs-b')]),
    );

    const launchSelected = vi.fn().mockImplementation(async (params) => {
      const taskId = params.tasks[0].id;
      if (taskId.includes('docs-a')) {
        updateTaskStatusInBoardCaches('docs-b', '🔲 Backlog');
      }
      return { launched: [taskId], deferred: [], failed: [] };
    });
    const evaluator = makeEvaluator({ launchSelected });

    const dispatched = await evaluator.tickOnce();

    expect(dispatched).toBe(1);
    expect(launchSelected).toHaveBeenCalledTimes(1);
    expect(launchSelected.mock.calls[0][0].tasks[0].id).toContain('docs-a');
  });

  it('leaves the ops candidate path unaffected — it already re-validates via a live worklist reload, not the new revalidate hook', async () => {
    upsertArm(MILESTONE, 'ops', true, Date.now());
    upsertTaskCache(
      `board:${MILESTONE}`,
      JSON.stringify([
        { ...backlogTask('ops-a'), status: '🗂️ Ready', type: '🔧 Operational' },
      ]),
    );

    const { loadOpsContext } = await import('../../ops/opsLoad.js');
    vi.mocked(loadOpsContext).mockResolvedValue({
      worklist: {
        executable: [
          {
            id: 'ops-a',
            title: 'Task ops-a',
            url: '',
            blockingDepIds: [],
            mode: 'launch',
          },
        ],
      },
    } as never);

    const launchSelected = vi.fn().mockResolvedValue({
      launched: ['ops-a'],
      deferred: [],
      failed: [],
    });
    const evaluator = makeEvaluator({ launchSelected });

    const dispatched = await evaluator.tickOnce();

    expect(dispatched).toBe(1);
    expect(launchSelected).toHaveBeenCalledTimes(1);
  });
});
