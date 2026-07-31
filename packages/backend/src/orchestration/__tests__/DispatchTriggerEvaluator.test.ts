import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../planningCandidates.js', () => ({
  isGroomCandidate: () => true,
  isOpsCandidate: async () => true,
  isDesignCandidate: () => true,
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

  it('excludes a wrapped milestone from scanProjectGroomCandidates while keeping the open sibling', () => {
    const evaluator = makeEvaluator();
    const candidates = (evaluator as any).scanProjectGroomCandidates(PROJECT);
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

  it('excludes a wrapped milestone from scanProjectDesignCandidates while keeping the open sibling', () => {
    const evaluator = makeEvaluator();
    const candidates = (evaluator as any).scanProjectDesignCandidates(PROJECT);
    expect(candidates.map((c: any) => c.milestone.id)).toEqual([
      OPEN_MILESTONE,
    ]);
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
