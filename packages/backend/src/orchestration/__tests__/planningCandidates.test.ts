import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NotionTask } from '../../notion/types';
import {
  isGroomCandidate,
  passesGroomDepGate,
  isDesignCandidate,
  passesDesignDepGate,
} from '../planningCandidates';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import {
  updateTaskStatusInBoardCaches,
  getTaskCache,
  hasActivePlanningSessionForTask,
  isGroomNoOpSuppressed,
  insertStagedIntent,
} from '../../db/queries';
import { recordEvent } from '../../audit/AuditLog';
import type { StagedIntentRow, StagedIntentState } from '../../db/types';

function task(overrides: Partial<NotionTask> = {}): NotionTask {
  return {
    id: 'task-1',
    title: 'A task',
    status: '🔲 Backlog',
    type: '💻 Code',
    dependsOn: [],
    notionUrl: '',
    ...overrides,
  };
}

describe('passesGroomDepGate', () => {
  it('requires a 📐 Design/📋 Planning dep to be ✅ Done', () => {
    const t = task({ dependsOn: ['design-dep'] });
    const notDone = new Map([
      [
        'design-dep',
        task({ id: 'design-dep', type: '📐 Design', status: '📐 In Progress' }),
      ],
    ]);
    expect(passesGroomDepGate(t, notDone)).toBe(false);

    const done = new Map([
      [
        'design-dep',
        task({ id: 'design-dep', type: '📐 Design', status: '✅ Done' }),
      ],
    ]);
    expect(passesGroomDepGate(t, done)).toBe(true);
  });

  it('requires an other-Type dep to be groomed past 🔲 Backlog (at 🗂️ Ready or beyond)', () => {
    const t = task({ dependsOn: ['code-dep'] });
    const stillBacklog = new Map([
      [
        'code-dep',
        task({ id: 'code-dep', type: '💻 Code', status: '🔲 Backlog' }),
      ],
    ]);
    expect(passesGroomDepGate(t, stillBacklog)).toBe(false);

    const groomed = new Map([
      [
        'code-dep',
        task({ id: 'code-dep', type: '💻 Code', status: '🗂️ Ready' }),
      ],
    ]);
    expect(passesGroomDepGate(t, groomed)).toBe(true);
  });

  it('requires a 🔎 Investigation dep to be ✅ Done, like Design/Planning', () => {
    const t = task({ dependsOn: ['investigation-dep'] });
    const ready = new Map([
      [
        'investigation-dep',
        task({
          id: 'investigation-dep',
          type: '🔎 Investigation',
          status: '🗂️ Ready',
        }),
      ],
    ]);
    expect(passesGroomDepGate(t, ready)).toBe(false);

    const inProgress = new Map([
      [
        'investigation-dep',
        task({
          id: 'investigation-dep',
          type: '🔎 Investigation',
          status: '🔄 In Progress',
        }),
      ],
    ]);
    expect(passesGroomDepGate(t, inProgress)).toBe(false);

    const done = new Map([
      [
        'investigation-dep',
        task({
          id: 'investigation-dep',
          type: '🔎 Investigation',
          status: '✅ Done',
        }),
      ],
    ]);
    expect(passesGroomDepGate(t, done)).toBe(true);
  });

  it('blocks on a ⏭️ Deferred dep of any Type, including non-decision types', () => {
    const t = task({ dependsOn: ['code-dep'] });
    const deferred = new Map([
      [
        'code-dep',
        task({ id: 'code-dep', type: '💻 Code', status: '⏭️ Deferred' }),
      ],
    ]);
    expect(passesGroomDepGate(t, deferred)).toBe(false);
  });

  it('fails closed when a dep is missing from the board cache', () => {
    const t = task({ dependsOn: ['missing-dep'] });
    expect(passesGroomDepGate(t, new Map())).toBe(false);
  });

  it('passes with no dependencies', () => {
    expect(passesGroomDepGate(task(), new Map())).toBe(true);
  });
});

describe('isGroomCandidate', () => {
  const baseDeps = {
    tasksById: new Map<string, NotionTask>(),
    hasActiveSession: () => false,
    hasActiveGroomSession: () => false,
    inCrashCooldown: () => false,
    isNoOpSuppressed: () => false,
  };

  it('rejects a task that is not still 🔲 Backlog', () => {
    const t = task({ status: '🗂️ Ready' });
    expect(isGroomCandidate(t, baseDeps)).toBe(false);
  });

  it('skips a task with an active standard session (dedup)', () => {
    const t = task();
    expect(
      isGroomCandidate(t, { ...baseDeps, hasActiveSession: () => true }),
    ).toBe(false);
  });

  it('skips a task within its crash-budget cooldown', () => {
    const t = task();
    expect(
      isGroomCandidate(t, { ...baseDeps, inCrashCooldown: () => true }),
    ).toBe(false);
  });

  it('accepts a Backlog task with no active session, no cooldown, and a clear dep-gate', () => {
    const t = task();
    expect(isGroomCandidate(t, baseDeps)).toBe(true);
  });

  it('skips a task with a groom session still running', () => {
    const t = task();
    expect(
      isGroomCandidate(t, { ...baseDeps, hasActiveGroomSession: () => true }),
    ).toBe(false);
  });

  it('skips a task with a groom session parked idle — idle blocks unconditionally, whether or not it holds an undispositioned intent', () => {
    const t = task();
    expect(
      isGroomCandidate(t, { ...baseDeps, hasActiveGroomSession: () => true }),
    ).toBe(false);
  });

  it('admits a task whose only groom session is archived and idle, wired through the real DB-backed predicate', () => {
    db.prepare('DELETE FROM sessions').run();
    db.prepare(
      `INSERT INTO sessions (session_id, task_id, task_url, project_context_url,
         status, started_at, session_type, archived)
       VALUES ('sess-archived-idle', 'task-1', 'https://notion.so/task', 'https://notion.so/ctx',
         'idle', ?, 'groom', 1)`,
    ).run(Date.now() - 10 * 60 * 1000);

    const t = task();
    expect(
      isGroomCandidate(t, {
        ...baseDeps,
        hasActiveGroomSession: (taskId) =>
          hasActivePlanningSessionForTask(taskId, 'groom'),
      }),
    ).toBe(true);
  });

  it('still excludes a task with a live running groom session, wired through the real DB-backed predicate', () => {
    db.prepare('DELETE FROM sessions').run();
    db.prepare(
      `INSERT INTO sessions (session_id, task_id, task_url, project_context_url,
         status, started_at, session_type, archived)
       VALUES ('sess-running', 'task-1', 'https://notion.so/task', 'https://notion.so/ctx',
         'running', ?, 'groom', 0)`,
    ).run(Date.now() - 10 * 60 * 1000);

    const t = task();
    expect(
      isGroomCandidate(t, {
        ...baseDeps,
        hasActiveGroomSession: (taskId) =>
          hasActivePlanningSessionForTask(taskId, 'groom'),
      }),
    ).toBe(false);
  });

  it('skips a task whose most recent planning.noOp still suppresses it', () => {
    const t = task();
    expect(
      isGroomCandidate(t, { ...baseDeps, isNoOpSuppressed: () => true }),
    ).toBe(false);
  });
});

function insertNoOp(overrides: Partial<StagedIntentRow> = {}): void {
  const now = Date.now();
  const row: StagedIntentRow = {
    id: `noop-${Math.random()}`,
    kind: 'planning.noOp',
    payload: JSON.stringify({ taskId: 'task-1', reason: 'nothing to decide' }),
    payload_hash: `hash-${Math.random()}`,
    task_id: 'task-1',
    project_id: 'proj-1',
    session_id: 'sess-noop',
    group_id: null,
    milestone: null,
    state: 'committed' as StagedIntentState,
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

describe('isGroomNoOpSuppressed', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM staged_intent').run();
    db.prepare('DELETE FROM audit_log').run();
  });

  it('suppresses while the most recent planning.noOp for the task is committed', () => {
    insertNoOp();
    expect(isGroomNoOpSuppressed('task-1')).toBe(true);
  });

  it('does not suppress when the task has no planning.noOp', () => {
    expect(isGroomNoOpSuppressed('task-1')).toBe(false);
  });

  it.each(['rejected', 'superseded', 'staged'] as StagedIntentState[])(
    'does not suppress when the most recent no-op is %s',
    (state) => {
      insertNoOp({ state });
      expect(isGroomNoOpSuppressed('task-1')).toBe(false);
    },
  );

  it('reads only the most recent no-op, not an earlier committed one', () => {
    insertNoOp({ state: 'committed', created_at: 1000, updated_at: 1000 });
    insertNoOp({ state: 'rejected', created_at: 2000, updated_at: 2000 });
    expect(isGroomNoOpSuppressed('task-1')).toBe(false);
  });

  it('retires the suppression once a task_body_updated event lands after the commit', () => {
    insertNoOp({ created_at: 1000, updated_at: 1000 });
    expect(isGroomNoOpSuppressed('task-1')).toBe(true);

    recordEvent({
      event_type: 'task_body_updated',
      actor_type: 'system',
      actor_id: null,
      project_id: 'proj-1',
      task_id: 'task-1',
      payload: {},
    });
    expect(isGroomNoOpSuppressed('task-1')).toBe(false);
  });

  it('retires the suppression once a task_deps_updated event lands after the commit', () => {
    insertNoOp({ created_at: 1000, updated_at: 1000 });
    recordEvent({
      event_type: 'task_deps_updated',
      actor_type: 'system',
      actor_id: null,
      project_id: 'proj-1',
      task_id: 'task-1',
      payload: {},
    });
    expect(isGroomNoOpSuppressed('task-1')).toBe(false);
  });

  it('does not retire on an edit event for a different task', () => {
    insertNoOp({ created_at: 1000, updated_at: 1000 });
    recordEvent({
      event_type: 'task_body_updated',
      actor_type: 'system',
      actor_id: null,
      project_id: 'proj-1',
      task_id: 'task-2',
      payload: {},
    });
    expect(isGroomNoOpSuppressed('task-1')).toBe(true);
  });

  it('still suppresses after the staging session goes terminal — derived from the committed intent, not the session', () => {
    db.prepare('DELETE FROM sessions').run();
    db.prepare(
      `INSERT INTO sessions (session_id, task_id, task_url, project_context_url,
         status, started_at, ended_at, session_type, archived)
       VALUES ('sess-noop', 'task-1', 'https://notion.so/task', 'https://notion.so/ctx',
         'done', ?, ?, 'groom', 0)`,
    ).run(Date.now() - 10 * 60 * 1000, Date.now());
    insertNoOp();
    expect(isGroomNoOpSuppressed('task-1')).toBe(true);
  });
});

describe('passesDesignDepGate', () => {
  it('requires every dep to be ✅ Done, regardless of Type', () => {
    const t = task({ dependsOn: ['code-dep'] });
    const notDone = new Map([
      [
        'code-dep',
        task({ id: 'code-dep', type: '💻 Code', status: '🗂️ Ready' }),
      ],
    ]);
    expect(passesDesignDepGate(t, notDone)).toBe(false);

    const done = new Map([
      [
        'code-dep',
        task({ id: 'code-dep', type: '💻 Code', status: '✅ Done' }),
      ],
    ]);
    expect(passesDesignDepGate(t, done)).toBe(true);
  });

  it('fails closed when a dep is missing from the board cache', () => {
    const t = task({ dependsOn: ['missing-dep'] });
    expect(passesDesignDepGate(t, new Map())).toBe(false);
  });

  it('passes with no dependencies', () => {
    expect(passesDesignDepGate(task(), new Map())).toBe(true);
  });
});

describe('isDesignCandidate', () => {
  const baseDeps = {
    tasksById: new Map<string, NotionTask>(),
    hasActiveSession: () => false,
    hasActiveDesignSession: () => false,
    inCrashCooldown: () => false,
    armed: true,
  };

  it('excludes a 🗂️ Ready 📐 Design task while the design flow is disarmed', () => {
    const t = task({ status: '🗂️ Ready', type: '📐 Design' });
    expect(isDesignCandidate(t, { ...baseDeps, armed: false })).toBe(false);
  });

  it('includes a 🗂️ Ready 📐 Design task once the design flow is armed', () => {
    const t = task({ status: '🗂️ Ready', type: '📐 Design' });
    expect(isDesignCandidate(t, baseDeps)).toBe(true);
  });

  it('includes a 🗂️ Ready 📋 Planning task once armed', () => {
    const t = task({ status: '🗂️ Ready', type: '📋 Planning' });
    expect(isDesignCandidate(t, baseDeps)).toBe(true);
  });

  it('rejects a task that is not 🗂️ Ready', () => {
    const t = task({ status: '🔲 Backlog', type: '📐 Design' });
    expect(isDesignCandidate(t, baseDeps)).toBe(false);
  });

  it('rejects a Ready task of a non-design/planning Type', () => {
    const t = task({ status: '🗂️ Ready', type: '💻 Code' });
    expect(isDesignCandidate(t, baseDeps)).toBe(false);
  });

  it('skips a task with an active standard session (dedup)', () => {
    const t = task({ status: '🗂️ Ready', type: '📐 Design' });
    expect(
      isDesignCandidate(t, { ...baseDeps, hasActiveSession: () => true }),
    ).toBe(false);
  });

  it('skips a task with an active design session (dedup)', () => {
    const t = task({ status: '🗂️ Ready', type: '📐 Design' });
    expect(
      isDesignCandidate(t, {
        ...baseDeps,
        hasActiveDesignSession: () => true,
      }),
    ).toBe(false);
  });

  it('skips a task within its crash-budget cooldown', () => {
    const t = task({ status: '🗂️ Ready', type: '📐 Design' });
    expect(
      isDesignCandidate(t, { ...baseDeps, inCrashCooldown: () => true }),
    ).toBe(false);
  });

  it('rejects when the design dep-gate fails', () => {
    const t = task({
      status: '🗂️ Ready',
      type: '📐 Design',
      dependsOn: ['code-dep'],
    });
    const notDone = new Map([
      [
        'code-dep',
        task({ id: 'code-dep', type: '💻 Code', status: '🗂️ Ready' }),
      ],
    ]);
    expect(isDesignCandidate(t, { ...baseDeps, tasksById: notDone })).toBe(
      false,
    );
  });
});

describe('isGroomCandidate — post-write candidate suppression via the board-cache write-through', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM task_cache').run();
  });

  const baseDeps = {
    tasksById: new Map<string, NotionTask>(),
    hasActiveSession: () => false,
    hasActiveGroomSession: () => false,
    inCrashCooldown: () => false,
    isNoOpSuppressed: () => false,
  };

  it('a task read back after updateTaskStatusInBoardCaches(Backlog -> Ready) is no longer a groom candidate', () => {
    const rawId = 'abc12345-0000-0000-0000-000000000000';
    db.prepare(
      `INSERT INTO task_cache (task_id, fetched_at, raw_json) VALUES (?, ?, ?)`,
    ).run(
      'board:m1',
      1000,
      JSON.stringify([task({ id: rawId, status: '🔲 Backlog' })]),
    );

    const before = JSON.parse(
      getTaskCache('board:m1')!.raw_json,
    ) as NotionTask[];
    expect(isGroomCandidate(before[0], baseDeps)).toBe(true);

    updateTaskStatusInBoardCaches(`notion:${rawId}`, '🗂️ Ready');

    const after = JSON.parse(
      getTaskCache('board:m1')!.raw_json,
    ) as NotionTask[];
    expect(isGroomCandidate(after[0], baseDeps)).toBe(false);
  });
});
