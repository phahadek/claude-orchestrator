import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../planningCandidates.js', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    isGroomCandidate: () => true,
    isOpsCandidate: async () => true,
    isDesignCandidate: () => true,
  };
});

vi.mock('../../ops/opsLoad.js', () => ({
  loadOpsContext: vi.fn(),
}));

import {
  computeAvailableCapacity,
  rotateFromIndex,
  DispatchTriggerEvaluator,
} from '../DispatchTriggerEvaluator';
import {
  insertProject,
  insertMilestone,
  upsertArm,
  upsertTaskCache,
} from '../../db/queries.js';
import type { NotionTask } from '../../notion/types.js';

describe('computeAvailableCapacity', () => {
  it('dispatches at most cap - humanReserve - active and leaves the reserve', () => {
    const available = computeAvailableCapacity({
      maxConcurrentPlanningSessions: 5,
      humanReserve: 1,
      activePlanningSessions: 2,
    });
    expect(available).toBe(2); // 5 - 1 - 2

    // Dispatching `available` more sessions lands exactly at cap - humanReserve,
    // leaving the reserve slot untouched.
    const afterDispatch = computeAvailableCapacity({
      maxConcurrentPlanningSessions: 5,
      humanReserve: 1,
      activePlanningSessions: 2 + available,
    });
    expect(afterDispatch).toBe(0);
  });

  it('never goes negative when active + humanReserve exceeds the cap', () => {
    const available = computeAvailableCapacity({
      maxConcurrentPlanningSessions: 5,
      humanReserve: 1,
      activePlanningSessions: 10,
    });
    expect(available).toBe(0);
  });

  it('is zero when the reserve alone consumes the whole cap', () => {
    const available = computeAvailableCapacity({
      maxConcurrentPlanningSessions: 1,
      humanReserve: 1,
      activePlanningSessions: 0,
    });
    expect(available).toBe(0);
  });
});

describe('rotateFromIndex', () => {
  it('rotates the start project across successive indices (round-robin fairness)', () => {
    const projects = ['a', 'b', 'c'];
    expect(rotateFromIndex(projects, 0)).toEqual(['a', 'b', 'c']);
    expect(rotateFromIndex(projects, 1)).toEqual(['b', 'c', 'a']);
    expect(rotateFromIndex(projects, 2)).toEqual(['c', 'a', 'b']);
    // Wraps back around.
    expect(rotateFromIndex(projects, 3)).toEqual(['a', 'b', 'c']);
  });

  it('handles an empty list', () => {
    expect(rotateFromIndex([], 5)).toEqual([]);
  });
});

describe('DispatchTriggerEvaluator scan scope — wrapped_at exclusion', () => {
  const PROJECT = 'proj-scan-scope';
  const WRAPPED_MILESTONE = 'milestone-wrapped';
  const OPEN_MILESTONE = 'milestone-open';

  function makeTask(id: string): NotionTask {
    return {
      id,
      title: `Task ${id}`,
      status: '🔲 Backlog',
      type: '💻 Code',
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

    insertProject({
      id: PROJECT,
      name: 'Scan Scope Project',
      project_dir: '/tmp/proj-scan-scope',
      context_url: null,
      github_repo: null,
      task_source: 'notion',
    });

    insertMilestone({
      id: WRAPPED_MILESTONE,
      project_id: PROJECT,
      name: 'Wrapped Milestone',
      source_id: null,
      canonical_short_id: null,
      wrapped_at: Date.now(),
    });
    insertMilestone({
      id: OPEN_MILESTONE,
      project_id: PROJECT,
      name: 'Open Milestone',
      source_id: null,
      canonical_short_id: null,
      wrapped_at: null,
    });

    for (const milestoneId of [WRAPPED_MILESTONE, OPEN_MILESTONE]) {
      for (const flow of ['groom', 'ops', 'design'] as const) {
        upsertArm(milestoneId, flow, true, Date.now());
      }
      upsertTaskCache(
        `board:${milestoneId}`,
        JSON.stringify([makeTask(`task-${milestoneId}`)]),
      );
    }
  });

  function makeEvaluator(): DispatchTriggerEvaluator {
    return new DispatchTriggerEvaluator({} as never, {} as never);
  }

  it('excludes a wrapped milestone from scanProjectGroomCandidates while keeping the open sibling', async () => {
    const evaluator = makeEvaluator();
    const candidates = await (evaluator as any).scanProjectGroomCandidates(
      PROJECT,
    );
    expect(candidates.map((c: any) => c.milestone.id)).toEqual([
      OPEN_MILESTONE,
    ]);
  });

  it('excludes a wrapped milestone from the ops scan while keeping the open sibling', async () => {
    const evaluator = makeEvaluator();
    const candidates = await (evaluator as any).scanProjectOpsCandidates(
      PROJECT,
    );
    expect(candidates.map((c: any) => c.milestone.id)).toEqual([
      OPEN_MILESTONE,
    ]);
  });

  it('excludes a wrapped milestone from scanProjectDesignCandidates while keeping the open sibling', async () => {
    const evaluator = makeEvaluator();
    const candidates = await (evaluator as any).scanProjectDesignCandidates(
      PROJECT,
    );
    expect(candidates.map((c: any) => c.milestone.id)).toEqual([
      OPEN_MILESTONE,
    ]);
  });
});

describe('DispatchTriggerEvaluator — board blob memoisation', () => {
  const PROJECT = 'proj-memo';
  const MILESTONE = 'milestone-memo';

  function makeTask(id: string): NotionTask {
    return {
      id,
      title: `Task ${id}`,
      status: '🔲 Backlog',
      type: '💻 Code',
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

    insertProject({
      id: PROJECT,
      name: 'Memo Project',
      project_dir: '/tmp/proj-memo',
      context_url: null,
      github_repo: null,
      task_source: 'notion',
    });
    insertMilestone({
      id: MILESTONE,
      project_id: PROJECT,
      name: 'Memo Milestone',
      source_id: null,
      canonical_short_id: null,
      wrapped_at: null,
    });
    for (const flow of ['groom', 'ops', 'design'] as const) {
      upsertArm(MILESTONE, flow, true, Date.now());
    }
    upsertTaskCache(`board:${MILESTONE}`, JSON.stringify([makeTask('task-1')]));
  });

  function makeEvaluator(): DispatchTriggerEvaluator {
    return new DispatchTriggerEvaluator({} as never, {} as never);
  }

  it('reuses the same parsed task objects across scans in one tick and across ticks when unchanged', async () => {
    const evaluator = makeEvaluator();
    const first = await (evaluator as any).scanProjectGroomCandidates(PROJECT);
    const second = await (evaluator as any).scanProjectDesignCandidates(
      PROJECT,
    );
    const third = await (evaluator as any).scanProjectGroomCandidates(PROJECT);

    expect(first[0].task).toBe(second[0].task);
    expect(first[0].task).toBe(third[0].task);
  });

  it('re-parses after upsertTaskCache changes raw_json content', async () => {
    const evaluator = makeEvaluator();
    const before = await (evaluator as any).scanProjectGroomCandidates(PROJECT);

    upsertTaskCache(
      `board:${MILESTONE}`,
      JSON.stringify([makeTask('task-1'), makeTask('task-2')]),
    );

    const after = await (evaluator as any).scanProjectGroomCandidates(PROJECT);
    expect(before[0].task).not.toBe(after[0].task);
    expect(after.map((c: any) => c.task.id)).toEqual(['task-1', 'task-2']);
  });

  it('re-parses after a status write-through rewrites raw_json while reusing fetched_at', async () => {
    const { updateTaskStatusInBoardCaches } =
      await import('../../db/queries.js');
    const evaluator = makeEvaluator();
    const before = await (evaluator as any).scanProjectGroomCandidates(PROJECT);
    expect(before[0].task.status).toBe('🔲 Backlog');

    updateTaskStatusInBoardCaches('task-1', '🗂️ Ready');

    const after = await (evaluator as any).scanProjectGroomCandidates(PROJECT);
    expect(before[0].task).not.toBe(after[0].task);
    expect(after[0].task.status).toBe('🗂️ Ready');
  });
});

describe('DispatchTriggerEvaluator — design-armed groom narrowing', () => {
  const PROJECT = 'proj-groom-narrowing';
  const MILESTONE = 'milestone-groom-narrowing';

  function makeTask(id: string, type: string): NotionTask {
    return {
      id,
      title: `Task ${id}`,
      status: '🔲 Backlog',
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

    insertProject({
      id: PROJECT,
      name: 'Groom Narrowing Project',
      project_dir: '/tmp/proj-groom-narrowing',
      context_url: null,
      github_repo: null,
      task_source: 'notion',
    });
    insertMilestone({
      id: MILESTONE,
      project_id: PROJECT,
      name: 'Groom Narrowing Milestone',
      source_id: null,
      canonical_short_id: null,
      wrapped_at: null,
    });

    const tasks = [
      makeTask('design-task', '📐 Design'),
      makeTask('planning-task', '📋 Planning'),
      makeTask('code-task', '💻 Code'),
    ];
    upsertTaskCache(`board:${MILESTONE}`, JSON.stringify(tasks));
  });

  function makeEvaluator(): DispatchTriggerEvaluator {
    return new DispatchTriggerEvaluator({} as never, {} as never);
  }

  it('with design armed and groom disarmed, admits only design-eligible Backlog tasks', async () => {
    upsertArm(MILESTONE, 'design', true, Date.now());
    upsertArm(MILESTONE, 'groom', false, Date.now());

    const evaluator = makeEvaluator();
    const candidates = await (evaluator as any).scanProjectGroomCandidates(
      PROJECT,
    );
    const ids = candidates.map((c: any) => c.task.id).sort();
    expect(ids).toEqual(['design-task', 'planning-task']);
  });

  it('with both groom and design armed, admits every Type (unchanged from today)', async () => {
    upsertArm(MILESTONE, 'design', true, Date.now());
    upsertArm(MILESTONE, 'groom', true, Date.now());

    const evaluator = makeEvaluator();
    const candidates = await (evaluator as any).scanProjectGroomCandidates(
      PROJECT,
    );
    const ids = candidates.map((c: any) => c.task.id).sort();
    expect(ids).toEqual(['code-task', 'design-task', 'planning-task']);
  });

  it('with both disarmed, admits nothing', async () => {
    upsertArm(MILESTONE, 'design', false, Date.now());
    upsertArm(MILESTONE, 'groom', false, Date.now());

    const evaluator = makeEvaluator();
    const candidates = await (evaluator as any).scanProjectGroomCandidates(
      PROJECT,
    );
    expect(candidates).toEqual([]);
  });

  it('leaves ops candidate scanning unaffected by the groom/design arm combination', async () => {
    upsertArm(MILESTONE, 'design', true, Date.now());
    upsertArm(MILESTONE, 'groom', false, Date.now());
    upsertArm(MILESTONE, 'ops', true, Date.now());

    const evaluator = makeEvaluator();
    const opsCandidates = await (evaluator as any).scanProjectOpsCandidates(
      PROJECT,
    );
    // isOpsCandidate is mocked to always true, so every task on the board
    // surfaces regardless of the groom/design arm combination above.
    const ids = opsCandidates.map((c: any) => c.task.id).sort();
    expect(ids).toEqual(['code-task', 'design-task', 'planning-task']);
  });
});

describe('DispatchTriggerEvaluator — usage admission gate', () => {
  beforeEach(async () => {
    const { clearUsageDeferral } = await import('../../db/queries.js');
    clearUsageDeferral('five_hour');
    clearUsageDeferral('seven_day');
  });

  it('does not scan or dispatch any project while the seven-day window is exhausted', async () => {
    const { registerUsagePoller } = await import('../usageAdmission.js');
    const resetsAt = new Date(Date.now() + 3600_000).toISOString();
    registerUsagePoller({
      getCache: () => ({
        available: true,
        weekly: { percent: 100, resetsAt, severity: 'exceeded' },
      }),
    });

    const listProjects = vi.fn().mockReturnValue(['proj-should-not-scan']);
    const evaluator = new DispatchTriggerEvaluator({} as never, {} as never, {
      listProjects: listProjects as never,
    });

    const dispatched = await evaluator.tickOnce();

    expect(dispatched).toBe(0);
    expect(listProjects).not.toHaveBeenCalled();
  });

  it('scans normally once usage is available', async () => {
    const { registerUsagePoller } = await import('../usageAdmission.js');
    registerUsagePoller({ getCache: () => ({ available: false }) });

    const listProjects = vi.fn().mockReturnValue([]);
    const evaluator = new DispatchTriggerEvaluator({} as never, {} as never, {
      listProjects: listProjects as never,
    });

    await evaluator.tickOnce();

    expect(listProjects).toHaveBeenCalledOnce();
  });
});

describe('DispatchTriggerEvaluator — poll complete log line', () => {
  it('logs a poll complete line with durationMs once per tick', async () => {
    const { logger } = await import('../../logger.js');
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});

    const listProjects = vi.fn().mockReturnValue([]);
    const evaluator = new DispatchTriggerEvaluator({} as never, {} as never, {
      listProjects: listProjects as never,
    });

    await evaluator.tickOnce();

    const matches = infoSpy.mock.calls.filter(
      ([message]) =>
        typeof message === 'string' &&
        message.includes('[DispatchTriggerEvaluator] poll complete') &&
        message.includes('durationMs='),
    );
    expect(matches).toHaveLength(1);

    infoSpy.mockRestore();
  });
});

describe('DispatchTriggerEvaluator — dispatch provenance audit rows', () => {
  const PROJECT = 'proj-provenance';
  const MILESTONE = 'milestone-provenance';

  function makeTask(id: string): NotionTask {
    return {
      id,
      title: `Task ${id}`,
      status: '🔲 Backlog',
      type: '💻 Code',
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
    db.prepare(
      "DELETE FROM audit_log WHERE event_type = 'planning_dispatch_launched'",
    ).run();

    insertProject({
      id: PROJECT,
      name: 'Provenance Project',
      project_dir: '/tmp/proj-provenance',
      context_url: null,
      github_repo: null,
      task_source: 'notion',
    });
    insertMilestone({
      id: MILESTONE,
      project_id: PROJECT,
      name: 'Provenance Milestone',
      source_id: null,
      canonical_short_id: null,
      wrapped_at: null,
    });
    upsertTaskCache(`board:${MILESTONE}`, JSON.stringify([makeTask('task-1')]));
  });

  it('records a planning_dispatch_launched row with trigger_source "evaluator" on a successful groom dispatch', async () => {
    const { db } = await import('../../db/db.js');
    const launcher = {
      launchSelected: vi.fn().mockResolvedValue({
        launched: ['task-1'],
        deferred: [],
        failed: [],
      }),
    };
    const evaluator = new DispatchTriggerEvaluator(
      {} as never,
      launcher as never,
    );
    const candidate = {
      projectId: PROJECT,
      milestone: { id: MILESTONE } as never,
      task: makeTask('task-1'),
    };

    const launched = await (evaluator as any).dispatchPlanningCandidate(
      candidate,
      'groom',
    );
    expect(launched).toBe(true);

    const rows = db
      .prepare(
        "SELECT payload FROM audit_log WHERE event_type = 'planning_dispatch_launched'",
      )
      .all() as Array<{ payload: string }>;
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0].payload);
    expect(payload).toEqual({
      trigger_source: 'evaluator',
      flow: 'groom',
      milestone_id: MILESTONE,
    });
  });

  it('records a planning_dispatch_launched row with trigger_source "evaluator" on a successful ops dispatch', async () => {
    const { db } = await import('../../db/db.js');
    const opsEntry = {
      id: 'task-1',
      title: 'Task task-1',
      url: '',
      blockingDepIds: [],
      mode: 'launch',
    };
    const { loadOpsContext } = await import('../../ops/opsLoad.js');
    vi.mocked(loadOpsContext).mockResolvedValue({
      worklist: { executable: [opsEntry] },
    } as never);

    const launcher = {
      launchSelected: vi.fn().mockResolvedValue({
        launched: ['task-1'],
        deferred: [],
        failed: [],
      }),
    };
    const evaluator = new DispatchTriggerEvaluator(
      {} as never,
      launcher as never,
    );
    const candidate = {
      projectId: PROJECT,
      milestone: { id: MILESTONE } as never,
      task: makeTask('task-1'),
    };

    const launched = await (evaluator as any).dispatchOpsCandidate(candidate);
    expect(launched).toBe(true);

    const rows = db
      .prepare(
        "SELECT payload FROM audit_log WHERE event_type = 'planning_dispatch_launched'",
      )
      .all() as Array<{ payload: string }>;
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0].payload);
    expect(payload).toEqual({
      trigger_source: 'evaluator',
      flow: 'ops',
      milestone_id: MILESTONE,
    });
  });
});
