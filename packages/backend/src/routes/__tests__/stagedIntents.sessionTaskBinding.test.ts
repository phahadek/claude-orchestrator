/**
 * The confirmed-bug guard: a dispatched planning session staged a
 * task.updateBody whose payload taskId was a different, unrelated task,
 * picked by mistake from its candidate-blockers list — the two ids shared a
 * long structured prefix that this project's context.md documents as a
 * recurring trap. Nothing bound the staged intent's target task to the
 * dispatching session's own task, so the mismatched intent reached
 * state='committed' and overwrote an unrelated task's body.
 *
 * This covers stageIntent's new session/task binding check: every kind
 * whose payload names an existing target task must match the dispatching
 * session's own `sessions.task_id`, normalized so hyphenation/`notion:`
 * prefix differences never cause a false mismatch — and never a false
 * match either, when two ids merely share a prefix.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetSession } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
}));

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../../db/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/queries')>();
  return {
    ...actual,
    getSession: mockGetSession,
  };
});

import { db } from '../../db/db';
import { stageIntent, SessionTaskBindingError } from '../stagedIntents';

const SESSION_TASK_ID = 'notion:3a822f9152f381acb47ec994a1a00723';
// Shares the same 16-hex-char prefix as SESSION_TASK_ID, differs beyond it —
// the exact shape of the observed failure (3a822f91-52f3-81ac vs -81a3).
const OTHER_TASK_ID_SAME_PREFIX = 'notion:3a822f9152f381a3992dc565e5de218f';

function stagedIntentCount(): number {
  return (
    db.prepare('SELECT COUNT(*) AS c FROM staged_intent').get() as {
      c: number;
    }
  ).c;
}

beforeEach(() => {
  mockGetSession.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
});

const BINDING_CASES: Array<{ kind: string; payload: unknown }> = [
  {
    kind: 'task.updateBody',
    payload: {
      taskId: OTHER_TASK_ID_SAME_PREFIX,
      sections: { summary: 'x' },
    },
  },
  {
    kind: 'task.patchBodySection',
    payload: {
      taskId: OTHER_TASK_ID_SAME_PREFIX,
      section: 'Context',
      operation: 'append',
      text: 'x',
    },
  },
  {
    kind: 'task.setStatus',
    payload: { taskId: OTHER_TASK_ID_SAME_PREFIX, status: 'In Progress' },
  },
  {
    kind: 'task.setProperties',
    payload: {
      taskId: OTHER_TASK_ID_SAME_PREFIX,
      patch: { priority: 'High' },
    },
  },
  {
    kind: 'task.setDependsOn',
    payload: { taskId: OTHER_TASK_ID_SAME_PREFIX, dependsOn: [] },
  },
];

describe('stageIntent — session/task binding', () => {
  for (const { kind, payload } of BINDING_CASES) {
    it(`rejects staging ${kind} against a task that is not the dispatching session's own task`, () => {
      mockGetSession.mockReturnValue({
        session_id: 'sess-1',
        task_id: SESSION_TASK_ID,
      });

      expect(() =>
        stageIntent(kind, payload, 'proj-1', 'group-1', 'sess-1'),
      ).toThrow(SessionTaskBindingError);

      expect(stagedIntentCount()).toBe(0);
    });
  }

  it('treats two task ids sharing a 16-hex prefix but differing in full as different tasks', () => {
    mockGetSession.mockReturnValue({
      session_id: 'sess-1',
      task_id: SESSION_TASK_ID,
    });

    expect(() =>
      stageIntent(
        'task.updateBody',
        { taskId: OTHER_TASK_ID_SAME_PREFIX, sections: { summary: 'x' } },
        'proj-1',
        null,
        'sess-1',
      ),
    ).toThrow(SessionTaskBindingError);
  });

  it('succeeds when the payload taskId is bare and the session task_id is notion:-prefixed', () => {
    mockGetSession.mockReturnValue({
      session_id: 'sess-1',
      task_id: SESSION_TASK_ID,
    });
    const bareTaskId = SESSION_TASK_ID.replace('notion:', '');

    const intent = stageIntent(
      'task.setStatus',
      { taskId: bareTaskId, status: 'In Progress' },
      'proj-1',
      null,
      'sess-1',
    );

    expect(intent.state).toBe('staged');
  });

  it('succeeds when the payload taskId is hyphenated and the session task_id is not (or vice versa)', () => {
    const hyphenated = 'notion:3a822f91-5231-81ac-b47e-c994a1a00723';
    const bareEquivalent = 'notion:3a822f91523181acb47ec994a1a00723';
    mockGetSession.mockReturnValue({
      session_id: 'sess-1',
      task_id: hyphenated,
    });

    const intent = stageIntent(
      'task.setStatus',
      { taskId: bareEquivalent, status: 'In Progress' },
      'proj-1',
      null,
      'sess-1',
    );

    expect(intent.state).toBe('staged');
  });

  it('leaves task.create unaffected — it stages regardless of the session task_id', () => {
    mockGetSession.mockReturnValue({
      session_id: 'sess-1',
      task_id: SESSION_TASK_ID,
    });

    const intent = stageIntent(
      'task.create',
      { title: 'A brand new sibling task' },
      'proj-1',
      null,
      'sess-1',
    );

    expect(intent.state).toBe('staged');
  });

  it('allows a task.setDependsOn targeting a task created by the same session earlier in the same group', () => {
    mockGetSession.mockReturnValue({
      session_id: 'sess-1',
      task_id: SESSION_TASK_ID,
    });

    stageIntent(
      'task.create',
      { title: 'Follow-on task' },
      'proj-1',
      'group-1',
      'sess-1',
    );

    const intent = stageIntent(
      'task.setDependsOn',
      { taskId: OTHER_TASK_ID_SAME_PREFIX, dependsOn: [] },
      'proj-1',
      'group-1',
      'sess-1',
    );

    expect(intent.state).toBe('staged');
  });

  it('does not extend the create-then-wire escape hatch to a different group', () => {
    mockGetSession.mockReturnValue({
      session_id: 'sess-1',
      task_id: SESSION_TASK_ID,
    });

    stageIntent(
      'task.create',
      { title: 'Follow-on task' },
      'proj-1',
      'group-1',
      'sess-1',
    );

    expect(() =>
      stageIntent(
        'task.setDependsOn',
        { taskId: OTHER_TASK_ID_SAME_PREFIX, dependsOn: [] },
        'proj-1',
        'group-2',
        'sess-1',
      ),
    ).toThrow(SessionTaskBindingError);
  });

  it('does not check kinds that carry no task-targeting taskId (e.g. session.requestCapability)', () => {
    mockGetSession.mockReturnValue({
      session_id: 'sess-1',
      task_id: SESSION_TASK_ID,
    });

    const intent = stageIntent(
      'session.requestCapability',
      { capability: 'Bash(ls:*)', plan: 'look around', evidence: 'debug' },
      'proj-1',
      null,
      'sess-1',
    );

    expect(intent.state).toBe('staged');
  });

  it('skips the check when the session has no recorded task_id', () => {
    mockGetSession.mockReturnValue({ session_id: 'sess-1', task_id: null });

    const intent = stageIntent(
      'task.setStatus',
      { taskId: OTHER_TASK_ID_SAME_PREFIX, status: 'In Progress' },
      'proj-1',
      null,
      'sess-1',
    );

    expect(intent.state).toBe('staged');
  });
});
