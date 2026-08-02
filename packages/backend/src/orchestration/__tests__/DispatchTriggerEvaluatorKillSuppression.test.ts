/**
 * Integration coverage for the kill-suppression gate wired into
 * DispatchTriggerEvaluator's groom/design/ops scans (planningCandidates.ts +
 * db/queries.ts's isPlanningKillSuppressed). Unlike DispatchTriggerEvaluator.test.ts,
 * this file does NOT mock isGroomCandidate/isDesignCandidate/isOpsCandidate — it
 * exercises the real predicates end to end so a killed session's suppression
 * is proven at the scan boundary, not just at the predicate-unit level.
 *
 * AC: a groom session killed with reason "user_kill" does not cause its task
 * to be re-dispatched on the immediately following poll.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import { DispatchTriggerEvaluator } from '../DispatchTriggerEvaluator';
import {
  insertProject,
  insertMilestone,
  upsertArm,
  upsertTaskCache,
  insertSession,
} from '../../db/queries.js';
import { recordEvent } from '../../audit/AuditLog';
import type { NotionTask } from '../../notion/types.js';

const PROJECT = 'proj-kill-suppression';
const MILESTONE = 'milestone-kill-suppression';
const TASK_ID = 'task-kill-suppressed';

function makeTask(id: string, type = '💻 Code'): NotionTask {
  return {
    id,
    title: `Task ${id}`,
    status: '🔲 Backlog',
    type,
    dependsOn: [],
    notionUrl: `https://notion.so/${id}`,
  };
}

function killSession(sessionType: 'groom' | 'design' | 'ops', reason: string) {
  const sessionId = `sess-${sessionType}-${Math.random()}`;
  // Deliberately well in the past so a later, live-clock-stamped edit event
  // is unambiguously "after" the kill for hasTaskEditSinceTimestamp's ts > sinceTs check.
  const endedAt = Date.now() - 60_000;
  insertSession({
    session_id: sessionId,
    task_id: TASK_ID,
    task_url: 'https://notion.so/task',
    project_context_url: 'https://notion.so/ctx',
    project_id: PROJECT,
    status: 'killed',
    started_at: endedAt - 60_000,
    ended_at: endedAt,
    session_type: sessionType,
  } as never);
  recordEvent({
    event_type: 'session_errored',
    actor_type: 'system',
    actor_id: sessionId,
    project_id: null,
    task_id: null,
    payload: { sessionId, status: 'killed', reason },
  });
}

function makeEvaluator(): DispatchTriggerEvaluator {
  return new DispatchTriggerEvaluator({} as never, {} as never);
}

beforeEach(() => {
  db.prepare('DELETE FROM task_cache').run();
  db.prepare('DELETE FROM flow_arm').run();
  db.prepare('DELETE FROM milestones').run();
  db.prepare('DELETE FROM projects').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM audit_log').run();

  insertProject({
    id: PROJECT,
    name: 'Kill Suppression Project',
    project_dir: '/tmp/proj-kill-suppression',
    context_url: null,
    github_repo: null,
    task_source: 'notion',
  });
  insertMilestone({
    id: MILESTONE,
    project_id: PROJECT,
    name: 'Kill Suppression Milestone',
    source_id: null,
    canonical_short_id: null,
    wrapped_at: null,
  });
  for (const flow of ['groom', 'ops', 'design'] as const) {
    upsertArm(MILESTONE, flow, true, Date.now());
  }
});

describe('DispatchTriggerEvaluator — kill suppression', () => {
  it('does not re-surface a Backlog task as a groom candidate right after its groom session is killed with user_kill', async () => {
    upsertTaskCache(`board:${MILESTONE}`, JSON.stringify([makeTask(TASK_ID)]));
    killSession('groom', 'user_kill');

    const evaluator = makeEvaluator();
    const candidates = await (evaluator as any).scanProjectGroomCandidates(
      PROJECT,
    );
    expect(candidates).toEqual([]);
  });

  it('does not re-surface a Ready task as a design candidate right after its design session is killed with user_kill', async () => {
    upsertTaskCache(
      `board:${MILESTONE}`,
      JSON.stringify([
        { ...makeTask(TASK_ID, '📐 Design'), status: '🗂️ Ready' },
      ]),
    );
    killSession('design', 'user_kill');

    const evaluator = makeEvaluator();
    const candidates = await (evaluator as any).scanProjectDesignCandidates(
      PROJECT,
    );
    expect(candidates).toEqual([]);
  });

  it('does not re-surface a Ready task as an ops candidate right after its ops session is killed with user_kill', async () => {
    upsertTaskCache(
      `board:${MILESTONE}`,
      JSON.stringify([
        { ...makeTask(TASK_ID, '🔧 Operational'), status: '🗂️ Ready' },
      ]),
    );
    killSession('ops', 'user_kill');

    const evaluator = makeEvaluator();
    const candidates = await (evaluator as any).scanProjectOpsCandidates(
      PROJECT,
    );
    expect(candidates).toEqual([]);
  });

  it('still surfaces the task as a groom candidate when the prior session ended for a non-kill reason (done)', async () => {
    upsertTaskCache(`board:${MILESTONE}`, JSON.stringify([makeTask(TASK_ID)]));
    const sessionId = 'sess-done';
    insertSession({
      session_id: sessionId,
      task_id: TASK_ID,
      task_url: 'https://notion.so/task',
      project_context_url: 'https://notion.so/ctx',
      project_id: PROJECT,
      status: 'done',
      started_at: Date.now() - 60_000,
      ended_at: Date.now(),
      session_type: 'groom',
    } as never);
    recordEvent({
      event_type: 'session_errored',
      actor_type: 'system',
      actor_id: sessionId,
      project_id: null,
      task_id: null,
      payload: { sessionId, status: 'done', reason: 'done' },
    });

    const evaluator = makeEvaluator();
    const candidates = await (evaluator as any).scanProjectGroomCandidates(
      PROJECT,
    );
    expect(candidates.map((c: any) => c.task.id)).toEqual([TASK_ID]);
  });

  it('re-surfaces the task once a task edit lands after the kill — suppression retires, even when the killed session and the edit event record the task id in different forms', async () => {
    // TASK_ID is the bare-hyphenated form the board cache and the killed
    // session's task_id carry. Production edit events (task_body_updated /
    // task_deps_updated) are written with a notion:-prefixed task_id by
    // TaskBackend — recording the edit in that mismatched form here proves
    // suppression retires via id-space-agnostic comparison, not just when
    // both sides happen to already agree on id form.
    const PREFIXED_TASK_ID = `notion:${TASK_ID}`;
    upsertTaskCache(`board:${MILESTONE}`, JSON.stringify([makeTask(TASK_ID)]));
    killSession('groom', 'user_kill');

    const evaluator = makeEvaluator();
    expect(
      (await (evaluator as any).scanProjectGroomCandidates(PROJECT)).length,
    ).toBe(0);
    // A second poll before any edit lands must still be suppressed.
    expect(
      (await (evaluator as any).scanProjectGroomCandidates(PROJECT)).length,
    ).toBe(0);

    recordEvent({
      event_type: 'task_body_updated',
      actor_type: 'system',
      actor_id: null,
      project_id: PROJECT,
      task_id: PREFIXED_TASK_ID,
      payload: {},
    });

    const candidates = await (evaluator as any).scanProjectGroomCandidates(
      PROJECT,
    );
    expect(candidates.map((c: any) => c.task.id)).toEqual([TASK_ID]);
  });
});
