/**
 * task.move re-parents an already-groomed task onto a different milestone
 * board — it copies the body verbatim, it does not re-author it. The
 * authoring readiness gate is an authoring-time check that already ran (and
 * passed) when the task first reached Ready, so a move must not re-run it as
 * a hard block: a task legitimately groomed to Ready under an earlier
 * authoring standard must stay movable even if it would fail today's gate.
 * See TaskWriteCommands.moveTask/restoreStatus.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const { mockGetTaskBackend, mockGetSession, mockRecordEvent } = vi.hoisted(
  () => ({
    mockGetTaskBackend: vi.fn(),
    mockGetSession: vi.fn(),
    mockRecordEvent: vi.fn(),
  }),
);

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: mockGetTaskBackend,
}));

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

const mockGetTaskCache = vi.fn();

vi.mock('../../db/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/queries')>();
  return {
    ...actual,
    getSession: mockGetSession,
    getTaskCache: (...args: unknown[]) => mockGetTaskCache(...args),
  };
});

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: mockRecordEvent,
}));

vi.mock('../../projects/ProjectService', () => ({
  ProjectService: {
    getById: (id: string) =>
      id === 'proj-1'
        ? {
            id,
            milestones: [
              { id: 'ms-source', name: 'M14', canonicalShortId: 'M14' },
              { id: 'ms-target', name: 'M13', canonicalShortId: 'M13' },
            ],
          }
        : undefined,
  },
}));

import { db } from '../../db/db';
import { createStagedIntentsRouter, stageIntent } from '../stagedIntents';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter());
  return app;
}

function cacheRowWithStatusAndType(display: string, type: string) {
  return { raw_json: JSON.stringify({ status: display, type }) };
}

/** Operational body missing the required "Targets / surfaces affected" heading — carries "Files / paths affected" instead, per the worked incident this task fixes. */
const NOT_GATE_CLEAN_OPERATIONAL_BODY =
  '## Files / paths affected\n- some/file.ts\n\n### 👁️ Manual verification\n- looks fine\n';

function makeMoveBackend(overrides: Record<string, unknown> = {}) {
  return {
    type: 'notion',
    fetchReadyTasks: vi
      .fn()
      .mockResolvedValue([
        { task: { id: 'notion:source-task', dependsOn: [] } },
      ]),
    createTask: vi.fn().mockResolvedValue('notion:new-task-id'),
    updateBodyRaw: vi.fn().mockResolvedValue(undefined),
    fetchTaskPage: vi.fn().mockResolvedValue(NOT_GATE_CLEAN_OPERATIONAL_BODY),
    setDependsOn: vi.fn().mockResolvedValue(undefined),
    archive: vi.fn().mockResolvedValue(undefined),
    appendImplementationNote: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  mockGetSession.mockReset();
  mockRecordEvent.mockReset();
  mockGetTaskCache.mockReset();
  mockGetTaskCache.mockReturnValue(
    cacheRowWithStatusAndType('Ready', '🔧 Operational'),
  );
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
});

describe('task.move — no longer re-runs the authoring readiness gate', () => {
  function stageMoveIntent() {
    return stageIntent(
      'task.move',
      {
        taskId: 'notion:source-task',
        content: {
          title: 'Wire the analyst MCP into dispatched sessions',
          bodyMarkdown: NOT_GATE_CLEAN_OPERATIONAL_BODY,
          type: '🔧 Operational',
          status: 'Ready',
        },
        sourceMilestone: { id: 'ms-source', displayOrder: 13 },
        targetMilestone: {
          id: 'ms-target',
          displayOrder: 14,
          databaseId: 'db-target',
        },
        originalDisposition: 'defer',
      },
      'proj-1',
      null,
      null,
      'Move task 3a622f91 from M14 to M13',
    );
  }

  it('completes the move and preserves Ready status even though the body would fail the gate', async () => {
    const backend = makeMoveBackend();
    mockGetTaskBackend.mockReturnValue(backend);

    const staged = stageMoveIntent();
    const app = buildApp();
    const agent = supertest(app);
    const applied = await agent
      .post(`/api/staged-intents/${staged.id}/apply`)
      .send({});

    expect(applied.status).toBe(200);
    expect(applied.body.ok).toBe(true);
    expect(applied.body.result.newTaskId).toBe('notion:new-task-id');

    expect(backend.updateStatus).toHaveBeenCalledWith(
      'notion:new-task-id',
      '🗂️ Ready',
      expect.anything(),
    );
    expect(backend.archive).not.toHaveBeenCalledWith(
      'notion:new-task-id',
      expect.anything(),
    );
  });

  it('never returns a 409 for a readiness-gate violation on the move path, and records the violation as a non-blocking annotation', async () => {
    const backend = makeMoveBackend();
    mockGetTaskBackend.mockReturnValue(backend);

    const staged = stageMoveIntent();
    const app = buildApp();
    const agent = supertest(app);
    const applied = await agent
      .post(`/api/staged-intents/${staged.id}/apply`)
      .send({});

    expect(applied.status).not.toBe(409);
    expect(applied.body.error).toBeUndefined();

    const row = db
      .prepare('SELECT state, annotation FROM staged_intent WHERE id = ?')
      .get(staged.id) as { state: string; annotation: string | null };
    expect(row.state).toBe('committed');
    expect(row.annotation).not.toBeNull();
    const annotation = JSON.parse(row.annotation as string);
    expect(annotation.advisory).toBe(true);
    expect('blocked' in annotation).toBe(false);
    expect(annotation.violations.length).toBeGreaterThan(0);
  });
});
