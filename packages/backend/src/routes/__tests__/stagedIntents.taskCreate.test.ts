/**
 * A dispatched planning session (groom/design/ops) now has task.create in
 * its allowed intent kinds (procedureAssembler.ts's PLANNING_INTENT_KINDS)
 * so it can stage mandated follow-on Code tasks instead of handing the spec
 * back in chat. This covers the apply-path guarantee that makes staging safe:
 * a task.create staged through the orchestrator MCP tool surface (the
 * transport a dispatched planning session actually uses — see
 * mcp/tools/stageProposalTools.ts, which stages through the exact same
 * `stageIntent` chokepoint called directly below) commits, on operator
 * approval, to a task the backend always creates at 🔲 Backlog — never
 * Ready — regardless of the staged payload.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const {
  mockGetTaskBackend,
  mockGetSession,
  mockRecordEvent,
  mockResolveMilestoneDatabaseId,
} = vi.hoisted(() => ({
  mockGetTaskBackend: vi.fn(),
  mockGetSession: vi.fn(),
  mockRecordEvent: vi.fn(),
  mockResolveMilestoneDatabaseId: vi.fn(),
}));

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: mockGetTaskBackend,
}));

vi.mock('../../projects/milestoneResolver', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../projects/milestoneResolver')>();
  return {
    ...actual,
    resolveMilestoneDatabaseId: mockResolveMilestoneDatabaseId,
  };
});

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../../db/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/queries')>();
  return {
    ...actual,
    getSession: mockGetSession,
    getTaskCache: vi.fn().mockReturnValue(null),
  };
});

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: mockRecordEvent,
}));

import { db } from '../../db/db';
import {
  createStagedIntentsRouter,
  stageIntent,
  runStageTimeReadyChecks,
} from '../stagedIntents';

/** Wired like the real server: the human/device-authed staged-intents apply surface. */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter());
  return app;
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  mockGetSession.mockReset();
  mockRecordEvent.mockReset();
  mockResolveMilestoneDatabaseId.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
});

describe('task.create staged by a planning session', () => {
  it('applies through createTask, which the backend hard-codes to Backlog regardless of the payload', async () => {
    const createTask = vi.fn().mockResolvedValue('notion:new-task-id');
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      createTask,
    });

    // Stage directly through stageIntent — the exact chokepoint the
    // `mcp__orchestrator__task.create` tool calls (see
    // mcp/tools/stageProposalTools.ts's `stage()` helper), rather than
    // exercising the retired loopback REST route.
    const intent = stageIntent(
      'task.create',
      {
        databaseId: 'db-1',
        title: 'Fix the thing the investigation found',
        type: '💻 Code',
        // A planning session cannot smuggle a Ready status through the
        // payload — NewTaskFields carries no status field at all, and the
        // backend enforces Backlog unconditionally.
      },
      'proj-1',
      null,
      'session-ops-1',
      'Follow-on Code task filed by a dispatched ops session',
    );
    const staged = await runStageTimeReadyChecks(intent);
    expect(staged.sessionId).toBe('session-ops-1');
    expect(staged.state).toBe('staged');
    expect(mockGetTaskBackend).not.toHaveBeenCalled();

    const app = buildApp();
    const agent = supertest(app);
    const applied = await agent
      .post(`/api/staged-intents/${staged.id}/apply`)
      .send({});
    expect(applied.status).toBe(200);
    expect(applied.body.result).toEqual({ id: 'notion:new-task-id' });

    expect(createTask).toHaveBeenCalledTimes(1);
    const [fields] = createTask.mock.calls[0];
    expect(fields).toEqual({
      databaseId: 'db-1',
      title: 'Fix the thing the investigation found',
      type: '💻 Code',
    });
    expect(fields).not.toHaveProperty('status');
  });

  it('resolves the board databaseId server-side from a milestone reference — a session never supplies a raw databaseId', async () => {
    const createTask = vi.fn().mockResolvedValue('notion:new-task-id');
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      createTask,
    });
    mockResolveMilestoneDatabaseId.mockReturnValue(
      '6614adb5-5bec-4b9a-b9a4-208ae0f00f3c',
    );

    const intent = stageIntent(
      'task.create',
      {
        milestone: 'M12',
        title: 'Fix the thing the investigation found',
        type: '💻 Code',
      },
      'proj-1',
      null,
      'session-ops-1',
      null,
    );
    const staged = await runStageTimeReadyChecks(intent);

    const app = buildApp();
    const agent = supertest(app);
    const applied = await agent
      .post(`/api/staged-intents/${staged.id}/apply`)
      .send({});
    expect(applied.status).toBe(200);
    expect(applied.body.result).toEqual({ id: 'notion:new-task-id' });

    expect(mockResolveMilestoneDatabaseId).toHaveBeenCalledWith(
      'proj-1',
      'M12',
    );
    expect(createTask).toHaveBeenCalledWith(
      {
        databaseId: '6614adb5-5bec-4b9a-b9a4-208ae0f00f3c',
        title: 'Fix the thing the investigation found',
        type: '💻 Code',
      },
      { source: 'human' },
    );
  });

  it('fails with a clear "which milestone/board?" error, not an opaque Notion parent error, when the milestone is unresolvable', async () => {
    const createTask = vi.fn();
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      createTask,
    });
    mockResolveMilestoneDatabaseId.mockImplementation(() => {
      throw new Error(
        '"M99" is not a known milestone for project "proj-1" — expected one of: M11, M12',
      );
    });

    const intent = stageIntent(
      'task.create',
      {
        milestone: 'M99',
        title: 'Fix the thing the investigation found',
      },
      'proj-1',
      null,
      'session-ops-1',
      null,
    );
    const staged = await runStageTimeReadyChecks(intent);

    const app = buildApp();
    const agent = supertest(app);
    const applied = await agent
      .post(`/api/staged-intents/${staged.id}/apply`)
      .send({});
    expect(applied.status).toBe(500);
    expect(applied.body.error).toMatch(/not a known milestone/);
    expect(createTask).not.toHaveBeenCalled();
  });
});

describe('task.setDependsOn symbolic reference to a sibling task.create — stage-time validation', () => {
  it('rejects a symbolic reference naming a task.create staged in a different group', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      createTask: vi.fn(),
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
    });
    const app = buildApp();
    const agent = supertest(app);

    const create = await agent.post('/api/staged-intents').send({
      kind: 'task.create',
      projectId: 'proj-1',
      groupId: 'g-other',
      payload: {
        databaseId: 'db-1',
        title: 'Sibling staged in a different group',
        type: '💻 Code',
      },
    });
    expect(create.status).toBe(201);

    const dependsOn = await agent.post('/api/staged-intents').send({
      kind: 'task.setDependsOn',
      projectId: 'proj-1',
      groupId: 'g-mine',
      payload: {
        taskId: 't-1',
        dependsOn: [`staged-intent:${create.body.id}`],
      },
    });

    expect(dependsOn.status).toBe(400);
    expect(dependsOn.body.error).toMatch(
      /does not resolve to a live task\.create intent in this same staged-intent group/,
    );
  });

  it('rejects a symbolic reference naming a non-existent staged intent', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
    });
    const app = buildApp();
    const agent = supertest(app);

    const dependsOn = await agent.post('/api/staged-intents').send({
      kind: 'task.setDependsOn',
      projectId: 'proj-1',
      groupId: 'g-mine-2',
      payload: {
        taskId: 't-1',
        dependsOn: ['staged-intent:does-not-exist'],
      },
    });

    expect(dependsOn.status).toBe(400);
    expect(dependsOn.body.error).toMatch(
      /does not resolve to a live task\.create intent in this same staged-intent group/,
    );
  });

  it('rejects a symbolic reference when the intent is staged with no groupId at all', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
    });
    const app = buildApp();
    const agent = supertest(app);

    const dependsOn = await agent.post('/api/staged-intents').send({
      kind: 'task.setDependsOn',
      projectId: 'proj-1',
      payload: {
        taskId: 't-1',
        dependsOn: ['staged-intent:whatever'],
      },
    });

    expect(dependsOn.status).toBe(400);
  });
});
