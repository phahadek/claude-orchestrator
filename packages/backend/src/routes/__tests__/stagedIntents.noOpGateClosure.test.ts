import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const { mockGetTaskBackend, mockProbe } = vi.hoisted(() => ({
  mockGetTaskBackend: vi.fn(),
  mockProbe: vi.fn(),
}));

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: mockGetTaskBackend,
}));

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

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
  isStructurallyUnresolvableSource,
} from '../../db/queries';
import * as gateStore from '../../gate/gateStore';
import {
  stageIntent,
  assertNoOpSatisfiedByCommit,
  createStagedIntentsRouter,
} from '../stagedIntents';

const SHA = 'a'.repeat(40);
const TASK = 'notion:3fa22f91-52f3-818a-88d3-c421a9252c01';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter(undefined));
  return app;
}

function seedSession(sessionId: string, sessionType = 'standard') {
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

function seedGateItem(): string {
  upsertTaskCache(TASK, JSON.stringify({ type: '💻 Code', status: '✅ Done' }));
  return gateStore.insertItem({
    project: 'proj-1',
    milestone: 'M1',
    text: 'item',
    classification: 'needs-triage',
    sources: [{ sourceTaskId: TASK, sourceTaskTitle: 'T' }],
    updatedAt: new Date(0).toISOString(),
  }).id;
}

function sourceRow(itemId: string) {
  return db
    .prepare(
      `SELECT merge_commit, closed_without_merge_at FROM gate_item_source WHERE gate_item_id = ?`,
    )
    .get(itemId) as {
    merge_commit: string | null;
    closed_without_merge_at: string | null;
  };
}

beforeEach(() => {
  mockProbe.mockReset();
  mockGetTaskBackend.mockReset();
  mockGetTaskBackend.mockReturnValue({
    type: 'notion',
    updateStatus: vi.fn().mockResolvedValue(undefined),
    appendImplementationNote: vi.fn().mockResolvedValue(undefined),
  });
  for (const t of [
    'staged_intent',
    'sessions',
    'gate_item_source',
    'gate_item',
  ]) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
});

describe('planning.noOp satisfiedByCommit — stage-time check', () => {
  it('accepts an ancestor of origin/<base>', async () => {
    seedSession('s1');
    mockProbe.mockResolvedValue(true);
    await expect(
      assertNoOpSatisfiedByCommit(
        { taskId: TASK, reason: 'r', satisfiedByCommit: SHA },
        'proj-1',
        's1',
      ),
    ).resolves.toBeUndefined();
    expect(mockProbe).toHaveBeenCalledWith(
      undefined,
      SHA,
      expect.stringMatching(/^origin\//),
    );
  });

  it('rejects a non-ancestor', async () => {
    seedSession('s1');
    mockProbe.mockResolvedValue(false);
    await expect(
      assertNoOpSatisfiedByCommit(
        { taskId: TASK, reason: 'r', satisfiedByCommit: SHA },
        'proj-1',
        's1',
      ),
    ).rejects.toThrow(/commit is not on origin\//);
  });

  it('rejects an unknown object with the fetch message', async () => {
    seedSession('s1');
    mockProbe.mockResolvedValue(null);
    await expect(
      assertNoOpSatisfiedByCommit(
        { taskId: TASK, reason: 'r', satisfiedByCommit: SHA },
        'proj-1',
        's1',
      ),
    ).rejects.toThrow(
      /commit unknown to the project checkout — fetch and re-stage/,
    );
  });

  it('accepts a payload without the field without probing git', async () => {
    seedSession('s1');
    await expect(
      assertNoOpSatisfiedByCommit(
        { taskId: TASK, reason: 'r' },
        'proj-1',
        's1',
      ),
    ).resolves.toBeUndefined();
    expect(mockProbe).not.toHaveBeenCalled();
  });

  it('rejects a non-40-hex value', () => {
    seedSession('s1');
    expect(() =>
      stageIntent(
        'planning.noOp',
        { taskId: TASK, reason: 'r', satisfiedByCommit: 'abc123' },
        'proj-1',
        null,
        's1',
      ),
    ).toThrow(/satisfiedByCommit/);
  });
});

describe('operator approval of a planning.noOp records the closure on gate sources', () => {
  async function approve(satisfiedByCommit?: string) {
    seedSession('s1');
    const intent = stageIntent(
      'planning.noOp',
      { taskId: TASK, reason: 'already satisfied', satisfiedByCommit },
      'proj-1',
      null,
      's1',
    );
    const res = await supertest(makeApp())
      .post(`/api/staged-intents/${intent.id}/approve`)
      .send({});
    expect(res.status).toBe(200);
  }

  it('with satisfiedByCommit fills merge_commit and min_deployed_commit and leaves the marker NULL', async () => {
    const itemId = seedGateItem();
    await approve(SHA);

    expect(sourceRow(itemId)).toEqual({
      merge_commit: SHA,
      closed_without_merge_at: null,
    });
    expect(gateStore.getItem(itemId)?.minDeployedCommit).toBe(SHA);
  });

  it('without it sets the marker; the task leaves the unfilled set and reads as structurally unresolvable', async () => {
    const itemId = seedGateItem();
    expect(gateStore.unfilledSourceTaskIds()).toContain(TASK);

    await approve();

    const row = sourceRow(itemId);
    expect(row.merge_commit).toBeNull();
    expect(row.closed_without_merge_at).not.toBeNull();
    expect(gateStore.unfilledSourceTaskIds()).not.toContain(TASK);
    expect(isStructurallyUnresolvableSource(TASK)).toBe(true);
  });
});
