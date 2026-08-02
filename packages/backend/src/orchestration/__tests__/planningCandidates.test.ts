import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NotionTask } from '../../notion/types';
import {
  isGroomCandidate,
  passesGroomDepGate,
  groomBlockingDepTitles,
  isDesignCandidate,
  passesDesignDepGate,
  isDesignEligibleType,
} from '../planningCandidates';
import { normalizeBoardId } from '../../tasks/taskId';

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
  isPlanningKillSuppressed,
  insertStagedIntent,
  insertSession,
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

/** Builds a tasksById map keyed the same way DispatchTriggerEvaluator does — normalized, so lookups match regardless of hyphenation/prefix. */
function depsMap(tasks: NotionTask[]): Map<string, NotionTask> {
  return new Map(tasks.map((t) => [normalizeBoardId(t.id), t]));
}

describe('passesGroomDepGate', () => {
  it('requires a 📐 Design/📋 Planning dep to be ✅ Done', () => {
    const t = task({ dependsOn: ['design-dep'] });
    const notDone = depsMap([
      task({ id: 'design-dep', type: '📐 Design', status: '📐 In Progress' }),
    ]);
    expect(passesGroomDepGate(t, notDone)).toBe(false);

    const done = depsMap([
      task({ id: 'design-dep', type: '📐 Design', status: '✅ Done' }),
    ]);
    expect(passesGroomDepGate(t, done)).toBe(true);
  });

  it('never blocks on a 💻 Code dep sitting at 🔲 Backlog — grooming is not dispatch', () => {
    const t = task({ dependsOn: ['code-dep'] });
    const stillBacklog = depsMap([
      task({ id: 'code-dep', type: '💻 Code', status: '🔲 Backlog' }),
    ]);
    expect(passesGroomDepGate(t, stillBacklog)).toBe(true);
  });

  it('passes for a 💻 Code dep at 🔄 In Progress, 👀 In Review, or 🗂️ Ready', () => {
    for (const status of ['🔄 In Progress', '👀 In Review', '🗂️ Ready']) {
      const t = task({ dependsOn: ['code-dep'] });
      const tasksById = depsMap([
        task({ id: 'code-dep', type: '💻 Code', status }),
      ]);
      expect(passesGroomDepGate(t, tasksById)).toBe(true);
    }
  });

  it('requires a 🔎 Investigation dep to be ✅ Done, like Design/Planning', () => {
    const t = task({ dependsOn: ['investigation-dep'] });
    const ready = depsMap([
      task({
        id: 'investigation-dep',
        type: '🔎 Investigation',
        status: '🗂️ Ready',
      }),
    ]);
    expect(passesGroomDepGate(t, ready)).toBe(false);

    const inProgress = depsMap([
      task({
        id: 'investigation-dep',
        type: '🔎 Investigation',
        status: '🔄 In Progress',
      }),
    ]);
    expect(passesGroomDepGate(t, inProgress)).toBe(false);

    const done = depsMap([
      task({
        id: 'investigation-dep',
        type: '🔎 Investigation',
        status: '✅ Done',
      }),
    ]);
    expect(passesGroomDepGate(t, done)).toBe(true);
  });

  it('blocks on a ⏭️ Deferred dep of any Type, including non-decision types', () => {
    const t = task({ dependsOn: ['code-dep'] });
    const deferred = depsMap([
      task({ id: 'code-dep', type: '💻 Code', status: '⏭️ Deferred' }),
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

  it('resolves a hyphenless dependsOn id against a hyphenated tasksById key', () => {
    const t = task({
      dependsOn: ['ab12cd34ef5678900000000000000000'],
    });
    const tasksById = depsMap([
      task({
        id: 'ab12cd34-ef56-7890-0000-000000000000',
        type: '💻 Code',
        status: '🗂️ Ready',
      }),
    ]);
    expect(passesGroomDepGate(t, tasksById)).toBe(true);
  });

  it('resolves a hyphenated dependsOn id against a hyphenless tasksById key', () => {
    const t = task({
      dependsOn: ['ab12cd34-ef56-7890-0000-000000000000'],
    });
    const tasksById = depsMap([
      task({
        id: 'ab12cd34ef5678900000000000000000',
        type: '💻 Code',
        status: '🗂️ Ready',
      }),
    ]);
    expect(passesGroomDepGate(t, tasksById)).toBe(true);
  });

  it('resolves a notion:-prefixed dependsOn id against an unprefixed board id', () => {
    const t = task({
      dependsOn: ['notion:ab12cd34-ef56-7890-0000-000000000000'],
    });
    const tasksById = depsMap([
      task({
        id: 'ab12cd34-ef56-7890-0000-000000000000',
        type: '💻 Code',
        status: '🗂️ Ready',
      }),
    ]);
    expect(passesGroomDepGate(t, tasksById)).toBe(true);
  });

  it('resolves an unprefixed dependsOn id against a notion:-prefixed board id', () => {
    const t = task({
      dependsOn: ['ab12cd34-ef56-7890-0000-000000000000'],
    });
    const tasksById = depsMap([
      task({
        id: 'notion:ab12cd34-ef56-7890-0000-000000000000',
        type: '💻 Code',
        status: '🗂️ Ready',
      }),
    ]);
    expect(passesGroomDepGate(t, tasksById)).toBe(true);
  });

  it('still fails closed when a normalized dependsOn id matches no board task', () => {
    const t = task({ dependsOn: ['zz99zz99-zz99-zz99-zz99-zz99zz99zz99'] });
    const tasksById = depsMap([
      task({
        id: 'ab12cd34-ef56-7890-0000-000000000000',
        type: '💻 Code',
        status: '🗂️ Ready',
      }),
    ]);
    expect(passesGroomDepGate(t, tasksById)).toBe(false);
  });

  it('logs an unresolved dependency distinguishably from a resolved-but-unsatisfied one', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const unresolved = task({
        id: 'task-unresolved',
        dependsOn: ['missing-dep'],
      });
      passesGroomDepGate(unresolved, new Map());
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('unresolved dependency'),
      );
      warnSpy.mockClear();

      const unsatisfied = task({
        id: 'task-unsatisfied',
        dependsOn: ['code-dep'],
      });
      const tasksById = depsMap([
        task({ id: 'code-dep', type: '💻 Code', status: '🔲 Backlog' }),
      ]);
      passesGroomDepGate(unsatisfied, tasksById);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('falls back to resolveDep for a dep absent from tasksById, and evaluates its status normally', () => {
    const t = task({ dependsOn: ['cross-board-dep'] });
    const crossBoardDone = task({
      id: 'cross-board-dep',
      type: '💻 Code',
      status: '✅ Done',
    });
    expect(
      passesGroomDepGate(t, new Map(), (depId) =>
        normalizeBoardId(depId) === normalizeBoardId(crossBoardDone.id)
          ? crossBoardDone
          : undefined,
      ),
    ).toBe(true);

    const crossBoardBacklog = task({
      id: 'cross-board-dep',
      type: '📐 Design',
      status: '🔲 Backlog',
    });
    expect(
      passesGroomDepGate(t, new Map(), (depId) =>
        normalizeBoardId(depId) === normalizeBoardId(crossBoardBacklog.id)
          ? crossBoardBacklog
          : undefined,
      ),
    ).toBe(false);
  });

  it('prefers a same-board tasksById hit over resolveDep', () => {
    const t = task({ dependsOn: ['dep-1'] });
    const tasksById = depsMap([
      task({ id: 'dep-1', type: '💻 Code', status: '🔲 Backlog' }),
    ]);
    const resolveDep = vi.fn();
    expect(passesGroomDepGate(t, tasksById, resolveDep)).toBe(true);
    expect(resolveDep).not.toHaveBeenCalled();
  });

  it('still fails closed when resolveDep also finds nothing', () => {
    const t = task({ dependsOn: ['missing-dep'] });
    expect(passesGroomDepGate(t, new Map(), () => undefined)).toBe(false);
  });
});

describe('groomBlockingDepTitles', () => {
  it('never lists a 💻 Code dep sitting at 🔲 Backlog', () => {
    const t = task({ dependsOn: ['code-dep'] });
    const stillBacklog = depsMap([
      task({
        id: 'code-dep',
        title: 'Code dep',
        type: '💻 Code',
        status: '🔲 Backlog',
      }),
    ]);
    expect(groomBlockingDepTitles(t, stillBacklog)).toEqual([]);
  });

  it('is empty for a 💻 Code dep at 🔄 In Progress, 👀 In Review, or 🗂️ Ready', () => {
    for (const status of ['🔄 In Progress', '👀 In Review', '🗂️ Ready']) {
      const t = task({ dependsOn: ['code-dep'] });
      const tasksById = depsMap([
        task({ id: 'code-dep', title: 'Code dep', type: '💻 Code', status }),
      ]);
      expect(groomBlockingDepTitles(t, tasksById)).toEqual([]);
    }
  });

  it('lists a ⏭️ Deferred 💻 Code dep by title', () => {
    const t = task({ dependsOn: ['code-dep'] });
    const deferred = depsMap([
      task({
        id: 'code-dep',
        title: 'Code dep',
        type: '💻 Code',
        status: '⏭️ Deferred',
      }),
    ]);
    expect(groomBlockingDepTitles(t, deferred)).toEqual(['Code dep']);
  });

  it('lists a non-Done 📐 Design dep by title', () => {
    const t = task({ dependsOn: ['design-dep'] });
    const notDone = depsMap([
      task({
        id: 'design-dep',
        title: 'Design dep',
        type: '📐 Design',
        status: '📐 In Progress',
      }),
    ]);
    expect(groomBlockingDepTitles(t, notDone)).toEqual(['Design dep']);
  });
});

describe('isGroomCandidate', () => {
  const baseDeps = {
    tasksById: new Map<string, NotionTask>(),
    hasActiveSession: () => false,
    hasActiveGroomSession: () => false,
    inCrashCooldown: () => false,
    isNoOpSuppressed: () => false,
    isKillSuppressed: () => false,
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

  it('skips a task whose most recent groom session was killed by the operator and not yet retired', () => {
    const t = task();
    expect(
      isGroomCandidate(t, { ...baseDeps, isKillSuppressed: () => true }),
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

function insertKilledSession(overrides: {
  sessionId?: string;
  taskId?: string;
  sessionType?: 'groom' | 'design' | 'ops';
  endedAt?: number;
}): { sessionId: string; endedAt: number } {
  const sessionId = overrides.sessionId ?? `sess-${Math.random()}`;
  const taskId = overrides.taskId ?? 'task-1';
  // Deliberately well in the past (not Date.now()) so a subsequently
  // recorded audit event — always stamped with the live clock — is
  // unambiguously "after" the kill, with no same-millisecond tie risk.
  const endedAt = overrides.endedAt ?? Date.now() - 60_000;
  insertSession({
    session_id: sessionId,
    task_id: taskId,
    task_url: 'https://notion.so/task',
    project_context_url: 'https://notion.so/ctx',
    project_id: 'proj-1',
    status: 'killed',
    started_at: endedAt - 10 * 60 * 1000,
    ended_at: endedAt,
    session_type: overrides.sessionType ?? 'groom',
  } as never);
  return { sessionId, endedAt };
}

describe('isPlanningKillSuppressed', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM sessions').run();
    db.prepare('DELETE FROM audit_log').run();
  });

  it('suppresses while the most recent groom session was killed with reason user_kill', () => {
    const { sessionId } = insertKilledSession({ taskId: 'task-1' });
    recordEvent({
      event_type: 'session_errored',
      actor_type: 'system',
      actor_id: sessionId,
      project_id: null,
      task_id: null,
      payload: { sessionId, status: 'killed', reason: 'user_kill' },
    });
    expect(isPlanningKillSuppressed('task-1', 'groom')).toBe(true);
  });

  it('does not suppress when the task has no session for that flow', () => {
    expect(isPlanningKillSuppressed('task-1', 'groom')).toBe(false);
  });

  it('does not suppress when the most recent session ended for a non-kill reason (done)', () => {
    const sessionId = 'sess-done';
    insertSession({
      session_id: sessionId,
      task_id: 'task-1',
      task_url: 'https://notion.so/task',
      project_context_url: 'https://notion.so/ctx',
      project_id: 'proj-1',
      status: 'done',
      started_at: Date.now() - 10 * 60 * 1000,
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
    expect(isPlanningKillSuppressed('task-1', 'groom')).toBe(false);
  });

  it.each(['error', 'launch_failed'])(
    'does not suppress when the session errored with reason %s rather than user_kill',
    (reason) => {
      const { sessionId } = insertKilledSession({ taskId: 'task-1' });
      recordEvent({
        event_type: 'session_errored',
        actor_type: 'system',
        actor_id: sessionId,
        project_id: null,
        task_id: null,
        payload: { sessionId, status: 'killed', reason },
      });
      expect(isPlanningKillSuppressed('task-1', 'groom')).toBe(false);
    },
  );

  it('is consistent across groom, design and ops flows', () => {
    for (const flow of ['groom', 'design', 'ops'] as const) {
      db.prepare('DELETE FROM sessions').run();
      db.prepare('DELETE FROM audit_log').run();
      const { sessionId } = insertKilledSession({
        taskId: 'task-1',
        sessionType: flow,
      });
      recordEvent({
        event_type: 'session_errored',
        actor_type: 'system',
        actor_id: sessionId,
        project_id: null,
        task_id: null,
        payload: { sessionId, status: 'killed', reason: 'user_kill' },
      });
      expect(isPlanningKillSuppressed('task-1', flow)).toBe(true);
    }
  });

  it('does not suppress a different flow than the one the kill happened on', () => {
    const { sessionId } = insertKilledSession({
      taskId: 'task-1',
      sessionType: 'groom',
    });
    recordEvent({
      event_type: 'session_errored',
      actor_type: 'system',
      actor_id: sessionId,
      project_id: null,
      task_id: null,
      payload: { sessionId, status: 'killed', reason: 'user_kill' },
    });
    expect(isPlanningKillSuppressed('task-1', 'design')).toBe(false);
  });

  it('retires the suppression once a task_body_updated event lands after the kill', () => {
    const { sessionId, endedAt } = insertKilledSession({ taskId: 'task-1' });
    recordEvent({
      event_type: 'session_errored',
      actor_type: 'system',
      actor_id: sessionId,
      project_id: null,
      task_id: null,
      payload: { sessionId, status: 'killed', reason: 'user_kill' },
    });
    expect(isPlanningKillSuppressed('task-1', 'groom')).toBe(true);

    recordEvent({
      event_type: 'task_body_updated',
      actor_type: 'system',
      actor_id: null,
      project_id: 'proj-1',
      task_id: 'task-1',
      payload: {},
    });
    expect(isPlanningKillSuppressed('task-1', 'groom')).toBe(false);
    expect(endedAt).toBeGreaterThan(0);
  });

  it('retires the suppression once a task_deps_updated event lands after the kill', () => {
    const { sessionId } = insertKilledSession({ taskId: 'task-1' });
    recordEvent({
      event_type: 'session_errored',
      actor_type: 'system',
      actor_id: sessionId,
      project_id: null,
      task_id: null,
      payload: { sessionId, status: 'killed', reason: 'user_kill' },
    });
    recordEvent({
      event_type: 'task_deps_updated',
      actor_type: 'system',
      actor_id: null,
      project_id: 'proj-1',
      task_id: 'task-1',
      payload: {},
    });
    expect(isPlanningKillSuppressed('task-1', 'groom')).toBe(false);
  });

  it('does not retire on an edit event for a different task', () => {
    const { sessionId } = insertKilledSession({ taskId: 'task-1' });
    recordEvent({
      event_type: 'session_errored',
      actor_type: 'system',
      actor_id: sessionId,
      project_id: null,
      task_id: null,
      payload: { sessionId, status: 'killed', reason: 'user_kill' },
    });
    recordEvent({
      event_type: 'task_body_updated',
      actor_type: 'system',
      actor_id: null,
      project_id: 'proj-1',
      task_id: 'task-2',
      payload: {},
    });
    expect(isPlanningKillSuppressed('task-1', 'groom')).toBe(true);
  });
});

describe('passesDesignDepGate', () => {
  it('requires every dep to be ✅ Done, regardless of Type', () => {
    const t = task({ dependsOn: ['code-dep'] });
    const notDone = depsMap([
      task({ id: 'code-dep', type: '💻 Code', status: '🗂️ Ready' }),
    ]);
    expect(passesDesignDepGate(t, notDone)).toBe(false);

    const done = depsMap([
      task({ id: 'code-dep', type: '💻 Code', status: '✅ Done' }),
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

  it('falls back to resolveDep for a dep absent from tasksById, and evaluates its status normally', () => {
    const t = task({ dependsOn: ['cross-board-dep'] });
    const crossBoardDone = task({
      id: 'cross-board-dep',
      type: '💻 Code',
      status: '✅ Done',
    });
    expect(
      passesDesignDepGate(t, new Map(), (depId) =>
        normalizeBoardId(depId) === normalizeBoardId(crossBoardDone.id)
          ? crossBoardDone
          : undefined,
      ),
    ).toBe(true);

    const crossBoardNotDone = task({
      id: 'cross-board-dep',
      type: '💻 Code',
      status: '🗂️ Ready',
    });
    expect(
      passesDesignDepGate(t, new Map(), (depId) =>
        normalizeBoardId(depId) === normalizeBoardId(crossBoardNotDone.id)
          ? crossBoardNotDone
          : undefined,
      ),
    ).toBe(false);
  });

  it('still fails closed when resolveDep also finds nothing', () => {
    const t = task({ dependsOn: ['missing-dep'] });
    expect(passesDesignDepGate(t, new Map(), () => undefined)).toBe(false);
  });
});

describe('isDesignCandidate', () => {
  const baseDeps = {
    tasksById: new Map<string, NotionTask>(),
    hasActiveSession: () => false,
    hasActiveDesignSession: () => false,
    inCrashCooldown: () => false,
    armed: true,
    isKillSuppressed: () => false,
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

  it('skips a task whose most recent design session was killed by the operator and not yet retired', () => {
    const t = task({ status: '🗂️ Ready', type: '📐 Design' });
    expect(
      isDesignCandidate(t, { ...baseDeps, isKillSuppressed: () => true }),
    ).toBe(false);
  });

  it('rejects when the design dep-gate fails', () => {
    const t = task({
      status: '🗂️ Ready',
      type: '📐 Design',
      dependsOn: ['code-dep'],
    });
    const notDone = depsMap([
      task({ id: 'code-dep', type: '💻 Code', status: '🗂️ Ready' }),
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
    isKillSuppressed: () => false,
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

describe('isDesignEligibleType — the shared predicate design-armed groom narrowing reuses', () => {
  it('admits 📐 Design and 📋 Planning Types', () => {
    expect(isDesignEligibleType('📐 Design')).toBe(true);
    expect(isDesignEligibleType('📋 Planning')).toBe(true);
  });

  it('rejects 💻 Code and other non-design Types', () => {
    expect(isDesignEligibleType('💻 Code')).toBe(false);
    expect(isDesignEligibleType('🔧 Operational')).toBe(false);
    expect(isDesignEligibleType('🔎 Investigation')).toBe(false);
  });

  it('is the exact predicate isDesignCandidate gates its Type check with', () => {
    const baseDeps = {
      tasksById: new Map<string, NotionTask>(),
      hasActiveSession: () => false,
      inCrashCooldown: () => false,
      hasActiveDesignSession: () => false,
      armed: true,
      isKillSuppressed: () => false,
    };
    const readyTask = task({ status: '🗂️ Ready', type: '💻 Code' });
    // isDesignEligibleType('💻 Code') is false, so isDesignCandidate must
    // reject it too — same predicate, same verdict, by construction.
    expect(isDesignEligibleType(readyTask.type)).toBe(false);
    expect(isDesignCandidate(readyTask, baseDeps)).toBe(false);
  });

  it('a design-eligible task admitted by groom narrowing still needs its dep gate cleared', () => {
    const t = task({
      type: '📐 Design',
      status: '🔲 Backlog',
      dependsOn: ['code-dep'],
    });
    const deferred = depsMap([
      task({ id: 'code-dep', type: '💻 Code', status: '⏭️ Deferred' }),
    ]);
    expect(isDesignEligibleType(t.type)).toBe(true);
    expect(passesGroomDepGate(t, deferred)).toBe(false);

    const baseDeps = {
      tasksById: deferred,
      hasActiveSession: () => false,
      hasActiveGroomSession: () => false,
      inCrashCooldown: () => false,
      isNoOpSuppressed: () => false,
      isKillSuppressed: () => false,
    };
    expect(isGroomCandidate(t, baseDeps)).toBe(false);
  });
});
