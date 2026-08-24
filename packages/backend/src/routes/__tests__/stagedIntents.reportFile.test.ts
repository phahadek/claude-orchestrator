/**
 * report.file — a dispatched code/review session's route to file an inert
 * investigation report about a defect it must not fix itself. Covers the
 * stage-time hard per-session cap and fingerprint-based duplicate tagging
 * (routeStageTimeBlock's report.file branch), the backend-derived envelope
 * (session/project/milestone never come from the model's payload), and the
 * commit-time apply path that creates a `committed` investigation_report row
 * directly (skipping 'draft').
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { EventEmitter } from 'events';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

const projectServiceMock = vi.hoisted(() => ({
  getById: vi.fn(),
}));

vi.mock('../../projects/ProjectService', () => ({
  ProjectService: projectServiceMock,
}));

import { db } from '../../db/db';
import {
  insertSession,
  updateSessionWorktreePath,
  getStagedIntent,
} from '../../db/queries';
import {
  createStagedIntentsRouter,
  setStagedIntentBroadcast,
  stageIntent,
  routeStageTimeBlock,
} from '../stagedIntents';
import { reserveMigrationNumber } from '../../db/migrationReservation';
import type { SessionManager } from '../../session/SessionManager';

const M1 = {
  id: 'ms-uuid-1',
  name: 'M1',
  canonicalShortId: 'M1',
};

function insertCodeSession(sessionId: string, taskId = 'task-1') {
  insertSession({
    session_id: sessionId,
    task_id: taskId,
    task_url: 'https://notion.so/task-1',
    project_context_url: 'https://notion.so/ctx',
    status: 'idle',
    started_at: Date.now(),
    session_type: 'standard',
  });
  updateSessionWorktreePath(sessionId, '/tmp/wt-report-file');
}

function validPayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    title: 'auth token refresh races under concurrent requests',
    symptom_text: 'two requests both refresh the token, one clobbers the other',
    fingerprint: 'auth-token-refresh-race',
    ...overrides,
  };
}

function stageReportFile(
  sessionId: string,
  payload = validPayload(),
  projectId = 'proj-1',
) {
  return stageIntent(
    'report.file',
    payload,
    projectId,
    null,
    sessionId,
    null,
    null,
    null,
    M1.id,
  );
}

function makeSessionManager(): SessionManager & EventEmitter {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    enqueueFeedback: vi.fn().mockResolvedValue(undefined),
    getLiveSession: vi.fn().mockReturnValue(undefined),
  }) as unknown as SessionManager & EventEmitter;
}

function makeApp() {
  const sessionManager = makeSessionManager();
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter(undefined, sessionManager));
  return { agent: supertest(app), sessionManager };
}

beforeEach(() => {
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM investigation_report').run();
  db.prepare('DELETE FROM migration_reservation_event').run();
  db.prepare('DELETE FROM migration_reservation').run();
  setStagedIntentBroadcast(() => {});
  projectServiceMock.getById.mockReset();
  projectServiceMock.getById.mockReturnValue({
    id: 'proj-1',
    milestones: [M1],
  });
});

describe('report.file — never auto-grants', () => {
  it('stays at `staged` after routeStageTimeBlock — no auto-approve branch fires for it', async () => {
    insertCodeSession('session-single');
    const intent = stageReportFile('session-single');
    expect(intent.state).toBe('staged');

    const checked = await routeStageTimeBlock(intent, undefined);

    expect(checked.state).toBe('staged');
  });
});

describe('report.file — per-session hard cap', () => {
  it('rejects a report.file stage beyond the configured per-session limit', async () => {
    insertCodeSession('session-cap');

    for (let i = 0; i < 5; i++) {
      const intent = stageReportFile(
        'session-cap',
        validPayload({ fingerprint: `fp-${i}` }),
      );
      const checked = await routeStageTimeBlock(intent, undefined);
      expect(checked.state).toBe('staged');
    }

    const overLimit = stageReportFile(
      'session-cap',
      validPayload({ fingerprint: 'fp-over-limit' }),
    );
    const checkedOverLimit = await routeStageTimeBlock(overLimit, undefined);

    expect(checkedOverLimit.state).toBe('rejected');
  });
});

describe('report.file — duplicate fingerprint tagging', () => {
  it('tags a fingerprint match against an existing report.file intent with annotation:{duplicateOf} instead of rejecting/suppressing it', async () => {
    insertCodeSession('session-dup-a');
    insertCodeSession('session-dup-b');

    const first = stageReportFile(
      'session-dup-a',
      validPayload({ fingerprint: 'shared-fingerprint' }),
    );
    await routeStageTimeBlock(first, undefined);

    const second = stageReportFile(
      'session-dup-b',
      validPayload({ fingerprint: 'shared-fingerprint' }),
    );
    const checkedSecond = await routeStageTimeBlock(second, undefined);

    expect(checkedSecond.state).toBe('staged');
    expect(checkedSecond.annotation).toEqual({ duplicateOf: first.id });

    const row = getStagedIntent(second.id);
    expect(row?.state).toBe('staged');
  });

  it('leaves a non-matching fingerprint untagged', async () => {
    insertCodeSession('session-nodup-a');
    insertCodeSession('session-nodup-b');

    const first = stageReportFile(
      'session-nodup-a',
      validPayload({ fingerprint: 'fingerprint-one' }),
    );
    await routeStageTimeBlock(first, undefined);

    const second = stageReportFile(
      'session-nodup-b',
      validPayload({ fingerprint: 'fingerprint-two' }),
    );
    const checkedSecond = await routeStageTimeBlock(second, undefined);

    expect(checkedSecond.annotation).toBeNull();
  });
});

describe('report.file — backend-derived envelope', () => {
  it('carries session/project/milestone as ctx-derived envelope data, never fields the payload supplied', async () => {
    insertCodeSession('session-envelope', 'task-envelope');
    const payload = validPayload();
    const intent = stageIntent(
      'report.file',
      payload,
      'proj-1',
      null,
      'session-envelope',
      null,
      null,
      null,
      M1.id,
    );

    expect(intent.sessionId).toBe('session-envelope');
    expect(intent.projectId).toBe('proj-1');
    expect(intent.milestone).toBe('M1');
    // The payload schema (rejectUnknownPayloadKeys) has no taskId/sessionId/
    // projectId/milestone keys at all — only the report's own content.
    expect(intent.payload).toEqual(payload);
    expect(Object.keys(intent.payload as object).sort()).toEqual(
      ['fingerprint', 'symptom_text', 'title'].sort(),
    );
  });
});

describe('report.file — commit-time apply path', () => {
  it('creates a `committed` investigation_report row (skipping draft) with backend-derived origin_session_id/origin_task_id and a HEAD-sha-carrying evidence_text', async () => {
    insertCodeSession('session-commit', 'task-commit');
    const staged = stageReportFile(
      'session-commit',
      validPayload({ evidence_text: 'src/auth/refresh.ts:42' }),
    );
    const { agent } = makeApp();

    const approveRes = await agent.post(
      `/api/staged-intents/${staged.id}/approve`,
    );
    expect(approveRes.status).toBe(200);

    const applyRes = await agent.post(`/api/staged-intents/${staged.id}/apply`);
    expect(applyRes.status).toBe(200);

    const reportId = applyRes.body.result.id as string;
    const report = db
      .prepare('SELECT * FROM investigation_report WHERE id = ?')
      .get(reportId) as
      | {
          state: string;
          source: string;
          origin_session_id: string | null;
          origin_task_id: string | null;
          evidence_text: string | null;
          project_id: string;
          milestone_id: string;
        }
      | undefined;

    expect(report).toBeDefined();
    expect(report!.state).toBe('committed');
    expect(report!.source).toBe('session');
    expect(report!.origin_session_id).toBe('session-commit');
    expect(report!.origin_task_id).toBe('task-commit');
    expect(report!.project_id).toBe('proj-1');
    expect(report!.milestone_id).toBe(M1.id);
    expect(report!.evidence_text).toContain('HEAD:');
    expect(report!.evidence_text).toContain('src/auth/refresh.ts:42');
  });
});

describe('report.file — migration-number-reassignment claim re-derivation', () => {
  it('auto-dismisses (abandons) a claim the orchestrator cannot confirm against the live reservation table, rather than surfacing it to the operator', async () => {
    insertCodeSession('session-reassign-deny', 'task-no-reservation');
    const staged = stageReportFile(
      'session-reassign-deny',
      validPayload({
        claimKind: 'migration-number-reassignment',
        expectedNumber: 100,
        actualNumber: 101,
        taskId: 'task-no-reservation',
      }),
    );
    const { agent } = makeApp();

    const approveRes = await agent.post(
      `/api/staged-intents/${staged.id}/approve`,
    );
    expect(approveRes.status).toBe(200);

    const applyRes = await agent.post(`/api/staged-intents/${staged.id}/apply`);
    expect(applyRes.status).toBe(200);
    expect(applyRes.body.result.confirmed).toBe(false);

    const reportId = applyRes.body.result.id as string;
    const report = db
      .prepare('SELECT * FROM investigation_report WHERE id = ?')
      .get(reportId) as { state: string } | undefined;

    expect(report).toBeDefined();
    expect(report!.state).toBe('abandoned');
  });

  it('keeps a claim the orchestrator confirms visible for operator disposition (committed, not abandoned)', async () => {
    reserveMigrationNumber({
      project: 'proj-1',
      taskId: 'task-1036',
      dir: 'migrations/postgres/',
      suffix: 'add_thing.sql',
      at: '2026-01-01T00:00:00Z',
    });

    insertCodeSession('session-reassign-confirm', 'task-1036');
    const staged = stageReportFile(
      'session-reassign-confirm',
      validPayload({
        claimKind: 'migration-number-reassignment',
        expectedNumber: 1,
        actualNumber: 2,
        taskId: 'task-1036',
      }),
    );
    const { agent } = makeApp();

    const approveRes = await agent.post(
      `/api/staged-intents/${staged.id}/approve`,
    );
    expect(approveRes.status).toBe(200);

    const applyRes = await agent.post(`/api/staged-intents/${staged.id}/apply`);
    expect(applyRes.status).toBe(200);
    expect(applyRes.body.result.confirmed).toBe(true);

    const reportId = applyRes.body.result.id as string;
    const report = db
      .prepare('SELECT * FROM investigation_report WHERE id = ?')
      .get(reportId) as { state: string } | undefined;

    expect(report).toBeDefined();
    expect(report!.state).toBe('committed');
  });
});
