/**
 * Stage-time auto-grant for seed.stage: the seed_contribution twin of
 * stagedIntents.gateAccreteAutoApprove.test.ts — runs the moment the intent
 * is staged via routeStageTimeBlock's maybeAutoApproveSeedStage, directly off
 * the intent's own payload plus a live task-body fetch, with no dependency on
 * a sibling task.setStatus intent's groomingGate payload having been staged
 * yet.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const { mockGetTaskBackend } = vi.hoisted(() => ({
  mockGetTaskBackend: vi.fn(),
}));

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: mockGetTaskBackend,
}));

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import {
  createStagedIntentsRouter,
  stageIntent,
  routeStageTimeBlock,
  type StagedIntent,
} from '../stagedIntents';
import { runtimeSettings } from '../../config';

function makeBackend(body: string | (() => Promise<string>)) {
  return {
    type: 'local' as const,
    updateStatus: vi.fn().mockResolvedValue(undefined),
    setDependsOn: vi.fn().mockResolvedValue(undefined),
    fetchTaskPage:
      typeof body === 'function'
        ? vi.fn(body)
        : vi.fn().mockResolvedValue(body),
  };
}

function stageSeedStage(
  sessionId: string,
  groupId: string,
  taskId: string,
  overrides: Partial<{
    seeds: { spec: string }[];
    decision: string;
  }> = {},
): StagedIntent {
  return stageIntent(
    'seed.stage',
    {
      sourceTask: {
        id: taskId,
        title: 'A task',
        project: 'proj-1',
        milestone: 'M1',
      },
      seeds: overrides.seeds ?? [{ spec: 'Seed the thing.' }],
      decision: overrides.decision ?? 'seeds',
    },
    'proj-1',
    groupId,
    sessionId,
  );
}

function stageArmingReady(sessionId: string, groupId: string, taskId: string) {
  return stageIntent(
    'task.setStatus',
    {
      taskId,
      status: 'Ready',
      groomingGate: {
        size_check: { decision: 'n/a' },
        type_check: { decision: 'none' },
        type: '💻 Code',
        filesPathsEntries: [],
        seedContributionCandidates: ['Seed the thing.'],
      },
    },
    'proj-1',
    groupId,
    sessionId,
  );
}

function auditEventsFor(intentId: string) {
  return (
    db
      .prepare(
        "SELECT actor_type, payload FROM audit_log WHERE event_type = 'staged_intent_disposition'",
      )
      .all() as { actor_type: string; payload: string }[]
  ).filter((row) => JSON.parse(row.payload).intentId === intentId);
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter());
  return app;
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM audit_log').run();
  runtimeSettings.gate_seed_auto_approve_enabled = true;
});

describe('seed.stage stage-time auto-grant (routeStageTimeBlock)', () => {
  it('transitions staged -> approved at stage time on a clean content-match, tagged and audited', async () => {
    const taskId = 'notion:seed-stage-auto-1';
    mockGetTaskBackend.mockReturnValue(
      makeBackend(
        '## Summary\nClean.\n\n## Operational seed\n- Seed the thing.\n',
      ),
    );
    const intent = stageSeedStage('session-1', 'group-1', taskId);
    expect(intent.state).toBe('staged');

    const checked = await routeStageTimeBlock(intent, undefined);

    expect(checked.state).toBe('approved');
    expect(checked.annotation).toEqual({ autoApproved: true });

    const events = auditEventsFor(intent.id);
    expect(events).toHaveLength(1);
    expect(events[0].actor_type).toBe('system');
    expect(JSON.parse(events[0].payload)).toEqual(
      expect.objectContaining({
        intentId: intent.id,
        disposition: 'auto_approved',
        provenance: 'auto',
      }),
    );
  });

  it('leaves a mismatched seed.stage intent in ordinary staged state', async () => {
    const taskId = 'notion:seed-stage-auto-2';
    mockGetTaskBackend.mockReturnValue(
      makeBackend(
        '## Summary\nClean.\n\n## Operational seed\n- Seed the thing.\n',
      ),
    );
    const intent = stageSeedStage('session-2', 'group-2', taskId, {
      seeds: [{ spec: 'Something totally unrelated' }],
    });

    const checked = await routeStageTimeBlock(intent, undefined);

    expect(checked.state).toBe('staged');
    expect(checked.annotation).toBeNull();
    expect(auditEventsFor(intent.id)).toHaveLength(0);
  });

  it("never runs the content-match check for a bare 'none'/'n/a' decision — falls back to ordinary staged state", async () => {
    const taskId = 'notion:seed-stage-auto-3';
    const fetchTaskPage = vi.fn();
    mockGetTaskBackend.mockReturnValue({
      type: 'local' as const,
      updateStatus: vi.fn().mockResolvedValue(undefined),
      setDependsOn: vi.fn().mockResolvedValue(undefined),
      fetchTaskPage,
    });
    const intent = stageSeedStage('session-3', 'group-3', taskId, {
      seeds: [],
      decision: 'n/a',
    });

    const checked = await routeStageTimeBlock(intent, undefined);

    expect(checked.state).toBe('staged');
    expect(checked.annotation).toBeNull();
    expect(fetchTaskPage).not.toHaveBeenCalled();
    expect(auditEventsFor(intent.id)).toHaveLength(0);
  });

  it('never auto-approves when the kill switch is off, regardless of content-match', async () => {
    runtimeSettings.gate_seed_auto_approve_enabled = false;
    const taskId = 'notion:seed-stage-auto-4';
    mockGetTaskBackend.mockReturnValue(
      makeBackend(
        '## Summary\nClean.\n\n## Operational seed\n- Seed the thing.\n',
      ),
    );
    const intent = stageSeedStage('session-4', 'group-4', taskId);

    const checked = await routeStageTimeBlock(intent, undefined);

    expect(checked.state).toBe('staged');
    expect(checked.annotation).toBeNull();
    expect(auditEventsFor(intent.id)).toHaveLength(0);
  });

  it('leaves the intent in ordinary staged state, without erroring the stage call, when the task-body fetch fails', async () => {
    const taskId = 'notion:seed-stage-auto-5';
    mockGetTaskBackend.mockReturnValue(
      makeBackend(() => Promise.reject(new Error('simulated fetch timeout'))),
    );
    const intent = stageSeedStage('session-5', 'group-5', taskId);

    const checked = await routeStageTimeBlock(intent, undefined);

    expect(checked.state).toBe('staged');
    expect(checked.annotation).toBeNull();
    expect(auditEventsFor(intent.id)).toHaveLength(0);
  });

  it('still cannot commit an auto-approved seed.stage member until every other live group member is approved', async () => {
    const taskId = 'notion:seed-stage-auto-6';
    mockGetTaskBackend.mockReturnValue(
      makeBackend(
        '## Summary\nClean.\n\n## Operational seed\n- Seed the thing.\n',
      ),
    );
    const groupId = 'group-6';
    const seedStage = stageSeedStage('session-6', groupId, taskId);
    const checkedSeed = await routeStageTimeBlock(seedStage, undefined);
    expect(checkedSeed.state).toBe('approved');

    // The arming task.setStatus sibling is staged but never individually
    // approved — the group must not be committable yet.
    stageArmingReady('session-6', groupId, taskId);

    const app = buildApp();
    const res = await supertest(app).post(
      `/api/staged-intents/group/${groupId}/commit`,
    );

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('not yet approved');
  });
});
