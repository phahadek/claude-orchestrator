/**
 * Stage-time auto-grant for gate.accrete: unlike the turn-end group-verify
 * auto-grant (stagedIntents.groupVerification.test.ts), this runs the moment
 * the intent is staged — routeStageTimeBlock's maybeAutoApproveGateAccrete —
 * directly off the intent's own payload plus a live task-body fetch, with no
 * dependency on a sibling task.setStatus intent's groomingGate payload
 * having been staged yet.
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
      typeof body === 'function' ? vi.fn(body) : vi.fn().mockResolvedValue(body),
  };
}

function stageGateAccrete(
  sessionId: string,
  groupId: string,
  taskId: string,
  overrides: Partial<{
    items: { text: string }[];
    classification: string;
    reason: string;
  }> = {},
): StagedIntent {
  return stageIntent(
    'gate.accrete',
    {
      sourceTask: { id: taskId, title: 'A task', project: 'proj-1', milestone: 'M1' },
      items: overrides.items ?? [{ text: 'Check it.' }],
      classification: overrides.classification ?? 'items',
      ...(overrides.reason ? { reason: overrides.reason } : {}),
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
        hasManualVerificationSection: true,
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

describe('gate.accrete stage-time auto-grant (routeStageTimeBlock)', () => {
  it('transitions staged -> approved at stage time on a clean content-match, tagged and audited', async () => {
    const taskId = 'notion:stage-auto-1';
    mockGetTaskBackend.mockReturnValue(
      makeBackend('## Summary\nClean.\n\n### 👁️ Manual verification\n- Check it.\n'),
    );
    const intent = stageGateAccrete('session-1', 'group-1', taskId);
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

  it('leaves a mismatched gate.accrete intent in ordinary staged state', async () => {
    const taskId = 'notion:stage-auto-2';
    mockGetTaskBackend.mockReturnValue(
      makeBackend('## Summary\nClean.\n\n### 👁️ Manual verification\n- Check it.\n'),
    );
    const intent = stageGateAccrete('session-2', 'group-2', taskId, {
      items: [{ text: 'Something totally unrelated' }],
    });

    const checked = await routeStageTimeBlock(intent, undefined);

    expect(checked.state).toBe('staged');
    expect(checked.annotation).toBeNull();
    expect(auditEventsFor(intent.id)).toHaveLength(0);
  });

  it("never runs the content-match check for a bare 'none'/'n/a' classification — falls back to ordinary staged state", async () => {
    const taskId = 'notion:stage-auto-3';
    const fetchTaskPage = vi.fn();
    mockGetTaskBackend.mockReturnValue({
      type: 'local' as const,
      updateStatus: vi.fn().mockResolvedValue(undefined),
      setDependsOn: vi.fn().mockResolvedValue(undefined),
      fetchTaskPage,
    });
    const intent = stageGateAccrete('session-3', 'group-3', taskId, {
      items: [],
      classification: 'n/a',
      reason: 'Assessed the change; nothing runtime-observable resulted.',
    });

    const checked = await routeStageTimeBlock(intent, undefined);

    expect(checked.state).toBe('staged');
    expect(checked.annotation).toBeNull();
    expect(fetchTaskPage).not.toHaveBeenCalled();
    expect(auditEventsFor(intent.id)).toHaveLength(0);
  });

  it('never auto-approves when the kill switch is off, regardless of content-match', async () => {
    runtimeSettings.gate_seed_auto_approve_enabled = false;
    const taskId = 'notion:stage-auto-4';
    mockGetTaskBackend.mockReturnValue(
      makeBackend('## Summary\nClean.\n\n### 👁️ Manual verification\n- Check it.\n'),
    );
    const intent = stageGateAccrete('session-4', 'group-4', taskId);

    const checked = await routeStageTimeBlock(intent, undefined);

    expect(checked.state).toBe('staged');
    expect(checked.annotation).toBeNull();
    expect(auditEventsFor(intent.id)).toHaveLength(0);
  });

  it('leaves the intent in ordinary staged state, without erroring the stage call, when the task-body fetch fails', async () => {
    const taskId = 'notion:stage-auto-5';
    mockGetTaskBackend.mockReturnValue(
      makeBackend(() => Promise.reject(new Error('simulated fetch timeout'))),
    );
    const intent = stageGateAccrete('session-5', 'group-5', taskId);

    const checked = await routeStageTimeBlock(intent, undefined);

    expect(checked.state).toBe('staged');
    expect(checked.annotation).toBeNull();
    expect(auditEventsFor(intent.id)).toHaveLength(0);
  });

  it('still cannot commit an auto-approved gate.accrete member until every other live group member is approved', async () => {
    const taskId = 'notion:stage-auto-6';
    mockGetTaskBackend.mockReturnValue(
      makeBackend('## Summary\nClean.\n\n### 👁️ Manual verification\n- Check it.\n'),
    );
    const groupId = 'group-6';
    const gateAccrete = stageGateAccrete('session-6', groupId, taskId);
    const checkedGate = await routeStageTimeBlock(gateAccrete, undefined);
    expect(checkedGate.state).toBe('approved');

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
