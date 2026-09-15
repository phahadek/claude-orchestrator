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
  insertStagedIntent,
} from '../../db/queries.js';
import type { NotionTask } from '../../notion/types.js';
import type { StagedIntentRow, StagedIntentState } from '../../db/types.js';

/**
 * Regression test for the groom launch loop observed 2026-09-14 (13 groom
 * sessions dispatched in ~3.5h against one open, undispositioned group): a
 * groom session that stages a task.setStatus decision and then goes `done`
 * (readiness-gate rejection, closed turn, crash — anything short of the
 * operator dispositioning the group) leaves that task's decision group open.
 * The task must never re-qualify as a groom candidate while that group sits
 * open, on this tick or any later one — a `done` owning session does not
 * release the group, only an operator (commit/reject) or the session's own
 * withdraw does.
 */
describe('DispatchTriggerEvaluator — open groom decision group blocks re-dispatch', () => {
  const PROJECT = 'proj-open-groom-group-regression';
  const MILESTONE = 'milestone-open-groom-group-regression';
  const TASK_ID = 'task-open-groom-group-regression';
  const NORMALIZED_TASK_ID = `notion:${TASK_ID}`;

  function makeTask(): NotionTask {
    return {
      id: TASK_ID,
      title: 'A task with an open, undispositioned groom group',
      status: '🔲 Backlog',
      type: '💻 Code',
      dependsOn: [],
      notionUrl: `https://notion.so/${TASK_ID}`,
    };
  }

  function insertGroomIntent(overrides: Partial<StagedIntentRow> = {}): void {
    const now = Date.now();
    const row: StagedIntentRow = {
      id: `intent-${Math.random()}`,
      kind: 'task.setStatus',
      payload: JSON.stringify({
        taskId: NORMALIZED_TASK_ID,
        status: '🗂️ Ready',
      }),
      payload_hash: `hash-${Math.random()}`,
      task_id: NORMALIZED_TASK_ID,
      project_id: PROJECT,
      session_id: 'sess-groom-done-owner',
      group_id: 'group-open-groom-group-regression',
      milestone: null,
      state: 'staged' as StagedIntentState,
      supersedes: null,
      annotation: null,
      decision_proposal: null,
      groom_proposal: null,
      advisory: null,
      disposition_reason: null,
      answer: null,
      created_at: now,
      updated_at: now,
      ...overrides,
    };
    insertStagedIntent(row);
  }

  beforeEach(async () => {
    const { db } = await import('../../db/db.js');
    db.prepare('DELETE FROM task_cache').run();
    db.prepare('DELETE FROM flow_arm').run();
    db.prepare('DELETE FROM milestones').run();
    db.prepare('DELETE FROM projects').run();
    db.prepare('DELETE FROM sessions').run();
    db.prepare('DELETE FROM staged_intent').run();

    insertProject({
      id: PROJECT,
      name: 'Open Groom Group Regression Project',
      project_dir: '/tmp/proj-open-groom-group-regression',
      context_url: null,
      github_repo: null,
      task_source: 'notion',
    });
    insertMilestone({
      id: MILESTONE,
      project_id: PROJECT,
      name: 'Open Groom Group Regression Milestone',
      source_id: null,
      canonical_short_id: null,
      wrapped_at: null,
    });
    upsertArm(MILESTONE, 'groom', true, Date.now());
    upsertTaskCache(`board:${MILESTONE}`, JSON.stringify([makeTask()]));

    // The staging session that opened the group has already gone `done` —
    // the exact shape of the recorded incident: a done owner does not
    // release the group.
    insertSession({
      session_id: 'sess-groom-done-owner',
      task_id: TASK_ID,
      task_url: `https://notion.so/${TASK_ID}`,
      project_context_url: 'https://notion.so/ctx',
      status: 'done',
      started_at: Date.now() - 60 * 60_000,
      ended_at: Date.now() - 55 * 60_000,
      session_type: 'groom',
    });

    insertGroomIntent();
  });

  function makeEvaluator(): DispatchTriggerEvaluator {
    return new DispatchTriggerEvaluator({} as never, {} as never);
  }

  it('excludes the task from groom candidates across many repeated evaluator ticks', async () => {
    const evaluator = makeEvaluator();

    for (let tick = 0; tick < 15; tick++) {
      const candidates = await (evaluator as any).scanProjectGroomCandidates(
        PROJECT,
      );
      expect(candidates).toEqual([]);
    }
  });

  it('re-admits the task once the group is committed', async () => {
    const evaluator = makeEvaluator();

    const whileOpen = await (evaluator as any).scanProjectGroomCandidates(
      PROJECT,
    );
    expect(whileOpen).toEqual([]);

    const { db } = await import('../../db/db.js');
    db.prepare(
      `UPDATE staged_intent SET state = 'committed' WHERE task_id = ?`,
    ).run(NORMALIZED_TASK_ID);

    const afterCommit = await (evaluator as any).scanProjectGroomCandidates(
      PROJECT,
    );
    expect(afterCommit).toHaveLength(1);
    expect(afterCommit[0].task.id).toBe(TASK_ID);
  });
});
