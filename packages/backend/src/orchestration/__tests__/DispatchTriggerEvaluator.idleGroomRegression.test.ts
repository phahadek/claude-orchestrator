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
  insertSession,
} from '../../db/queries.js';
import type { NotionTask } from '../../notion/types.js';

/**
 * Regression test for the 17 duplicate groom launches observed after the
 * 2026-07-30 23:42 deploy: a task whose groom session is parked idle
 * (awaiting operator disposition) must never re-qualify as a groom
 * candidate, on this tick or the next — idle is a live, non-terminal
 * status, not a signal that the task is free for re-dispatch. Exercises the
 * real isGroomCandidate / hasActivePlanningSessionForTask predicates (no
 * planningCandidates mock), unlike DispatchTriggerEvaluator.test.ts.
 */
describe('DispatchTriggerEvaluator — parked-idle groom session blocks re-dispatch', () => {
  const PROJECT = 'proj-idle-groom-regression';
  const MILESTONE = 'milestone-idle-groom-regression';
  const TASK_ID = 'task-idle-groom-regression';

  function makeTask(): NotionTask {
    return {
      id: TASK_ID,
      title: 'A groomed-but-parked task',
      status: '🔲 Backlog',
      type: '💻 Code',
      dependsOn: [],
      notionUrl: `https://notion.so/${TASK_ID}`,
    };
  }

  beforeEach(async () => {
    const { db } = await import('../../db/db.js');
    db.prepare('DELETE FROM task_cache').run();
    db.prepare('DELETE FROM flow_arm').run();
    db.prepare('DELETE FROM milestones').run();
    db.prepare('DELETE FROM projects').run();
    db.prepare('DELETE FROM sessions').run();

    insertProject({
      id: PROJECT,
      name: 'Idle Groom Regression Project',
      project_dir: '/tmp/proj-idle-groom-regression',
      context_url: null,
      github_repo: null,
      task_source: 'notion',
    });
    insertMilestone({
      id: MILESTONE,
      project_id: PROJECT,
      name: 'Idle Groom Regression Milestone',
      source_id: null,
      canonical_short_id: null,
      wrapped_at: null,
    });
    upsertArm(MILESTONE, 'groom', true, Date.now());
    upsertTaskCache(`board:${MILESTONE}`, JSON.stringify([makeTask()]));

    // A groom session for this task that has parked idle — the state a
    // dispatched groom session sits in between turns and while awaiting an
    // operator disposition. It has not concluded.
    insertSession({
      session_id: 'sess-idle-groom',
      task_id: TASK_ID,
      task_url: `https://notion.so/${TASK_ID}`,
      project_context_url: 'https://notion.so/ctx',
      status: 'idle',
      started_at: Date.now() - 10 * 60_000,
      session_type: 'groom',
    });
  });

  function makeEvaluator(): DispatchTriggerEvaluator {
    return new DispatchTriggerEvaluator({} as never, {} as never);
  }

  it('excludes the task from groom candidates across two successive scans', async () => {
    const evaluator = makeEvaluator();

    const firstTick = await (evaluator as any).scanProjectGroomCandidates(
      PROJECT,
    );
    expect(firstTick).toEqual([]);

    const secondTick = await (evaluator as any).scanProjectGroomCandidates(
      PROJECT,
    );
    expect(secondTick).toEqual([]);
  });
});
