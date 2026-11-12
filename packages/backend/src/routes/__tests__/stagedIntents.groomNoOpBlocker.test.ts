import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockGetTaskBackend, mockProbe, mockGetProjectById, mockRecordEvent } =
  vi.hoisted(() => ({
    mockGetTaskBackend: vi.fn(),
    mockProbe: vi.fn(),
    mockGetProjectById: vi.fn(),
    mockRecordEvent: vi.fn(),
  }));

vi.mock('../../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config')>();
  return { ...actual, getProjectById: mockGetProjectById };
});
vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: mockGetTaskBackend,
}));
vi.mock('../../audit/AuditLog', () => ({ recordEvent: mockRecordEvent }));
vi.mock('../../gate/gateService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../gate/gateService')>()),
  probeGitAncestry: mockProbe,
}));
vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import {
  insertSession,
  upsertTaskCache,
  insertStagedIntent,
} from '../../db/queries';
import { assertGroomNoOpBlocker } from '../stagedIntents';

const SHA = 'b'.repeat(40);
const TASK = 'notion:3fa22f91-52f3-818a-88d3-c421a9252c01';
const UP = 'notion:3fa22f91-52f3-818a-88d3-c421a9252c02';

function seedSession(sessionId: string, sessionType: string) {
  insertSession({
    session_id: sessionId,
    task_id: TASK,
    task_url: null,
    project_context_url: null,
    status: 'idle',
    started_at: 0,
    session_type: sessionType as never,
  });
}

function seedBoard(upStatus: string, upType = '📐 Design') {
  upsertTaskCache(
    'board:M1',
    JSON.stringify([
      { id: TASK, status: '🔲 Backlog', dependsOn: [UP] },
      { id: UP, status: upStatus, dependsOn: [] },
    ]),
  );
  upsertTaskCache(UP, JSON.stringify({ type: upType, status: upStatus }));
}

const noOp = (blocker?: unknown, extra: object = {}) => ({
  taskId: TASK,
  reason: 'r',
  ...(blocker !== undefined ? { blocker } : {}),
  ...extra,
});

beforeEach(() => {
  mockProbe.mockReset();
  mockRecordEvent.mockReset();
  mockGetProjectById.mockReturnValue({
    projectDir: '/repo/p',
    baseBranch: 'dev',
  });
  mockGetTaskBackend.mockReset();
  for (const t of ['staged_intent', 'sessions', 'task_cache']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  seedSession('g1', 'groom');
});

describe('groom whole-turn planning.noOp blocker', () => {
  it('rejects a missing blocker and audits it', async () => {
    await expect(assertGroomNoOpBlocker(noOp(), 'p', 'g1')).rejects.toThrow(
      /noop-blocker/,
    );
    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'stage_guard_rejected' }),
    );
  });

  it('rejects an unknown code', async () => {
    await expect(
      assertGroomNoOpBlocker(
        noOp({ code: 'operator-must-act', ref: 'x' }),
        'p',
        'g1',
      ),
    ).rejects.toThrow(/noop-blocker/);
  });

  it('upstream-not-done: accepts a non-Done upstream, rejects Done', async () => {
    seedBoard('🗂️ Ready');
    await expect(
      assertGroomNoOpBlocker(
        noOp({ code: 'upstream-not-done', ref: UP }),
        'p',
        'g1',
      ),
    ).resolves.toBeUndefined();
    seedBoard('✅ Done');
    await expect(
      assertGroomNoOpBlocker(
        noOp({ code: 'upstream-not-done', ref: UP }),
        'p',
        'g1',
      ),
    ).rejects.toThrow(/already Done/);
  });

  it('superseded: rejects a nonexistent task, accepts an existing one', async () => {
    mockGetTaskBackend.mockReturnValue({
      fetchTaskSummary: vi.fn().mockResolvedValue(null),
    });
    await expect(
      assertGroomNoOpBlocker(noOp({ code: 'superseded', ref: UP }), 'p', 'g1'),
    ).rejects.toThrow(/does not resolve/);
    mockGetTaskBackend.mockReturnValue({
      fetchTaskSummary: vi.fn().mockResolvedValue({ archived: false }),
    });
    await expect(
      assertGroomNoOpBlocker(noOp({ code: 'superseded', ref: UP }), 'p', 'g1'),
    ).resolves.toBeUndefined();
  });

  it('already-satisfied: checks the SHA against base', async () => {
    mockProbe.mockResolvedValue(false);
    await expect(
      assertGroomNoOpBlocker(
        noOp({ code: 'already-satisfied', ref: SHA }),
        'p',
        'g1',
      ),
    ).rejects.toThrow(/not on origin\/dev/);
    mockProbe.mockResolvedValue(true);
    await expect(
      assertGroomNoOpBlocker(
        noOp({ code: 'already-satisfied', ref: SHA }),
        'p',
        'g1',
      ),
    ).resolves.toBeUndefined();
  });

  it('capability-pending: requires this session’s own capability request', async () => {
    seedSession('g2', 'groom');
    const mk = (id: string, sessionId: string) =>
      insertStagedIntent({
        id,
        kind: 'session.requestCapability',
        payload: JSON.stringify({ capability: 'x', plan: 'p', evidence: 'e' }),
        payload_hash: id,
        task_id: null,
        project_id: 'p',
        session_id: sessionId,
        group_id: null,
        milestone: null,
        state: 'staged',
        supersedes: null,
        annotation: null,
        decision_proposal: null,
        investigation: null,
        groom_proposal: null,
        advisory: null,
        disposition_reason: null,
        answer: null,
        applied_task_id: null,
        created_at: 0,
        updated_at: 0,
      } as never);
    mk('cap-other', 'g2');
    mk('cap-mine', 'g1');
    for (const ref of ['cap-other', 'missing']) {
      await expect(
        assertGroomNoOpBlocker(
          noOp({ code: 'capability-pending', ref }),
          'p',
          'g1',
        ),
      ).rejects.toThrow(/noop-blocker/);
    }
    await expect(
      assertGroomNoOpBlocker(
        noOp({ code: 'capability-pending', ref: 'cap-mine' }),
        'p',
        'g1',
      ),
    ).resolves.toBeUndefined();
  });

  it('leaves skippedKind, non-groom and ops no-ops untouched', async () => {
    await expect(
      assertGroomNoOpBlocker(
        noOp(undefined, { skippedKind: 'task.create' }),
        'p',
        'g1',
      ),
    ).resolves.toBeUndefined();
    seedSession('d1', 'design');
    await expect(
      assertGroomNoOpBlocker(noOp(), 'p', 'd1'),
    ).resolves.toBeUndefined();
    seedSession('o1', 'ops');
    await expect(
      assertGroomNoOpBlocker(
        noOp(undefined, { satisfiedByCommit: SHA }),
        'p',
        'o1',
      ),
    ).resolves.toBeUndefined();
  });
});
