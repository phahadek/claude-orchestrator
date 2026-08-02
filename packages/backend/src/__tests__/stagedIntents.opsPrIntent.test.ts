/**
 * ops.prIntent — an Ops session's mid-execution "I intend to open a PR for
 * X, here's the diff scope and why" declaration. Covers the acceptance
 * criteria from the "Add an Ops PR-intent staged-intent kind" task:
 * stage-time payload validation, membership in KNOWN_INTENT_KINDS /
 * PLANNING_INTENT_KINDS.ops, and that operator approval is terminal
 * (transitions straight to `committed`, with no separate apply step).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { EventEmitter } from 'events';

vi.mock('../db/db', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db/db';
import { insertSession, getStagedIntent } from '../db/queries';
import {
  createStagedIntentsRouter,
  setStagedIntentBroadcast,
  stageIntent,
  KNOWN_INTENT_KINDS,
} from '../routes/stagedIntents';
import { PLANNING_INTENT_KINDS } from '../planning/planningIntentKinds';
import type { SessionManager } from '../session/SessionManager';

const SESSION_ID = 'session-ops-pr-intent';

function insertOpsSession(taskId: string): void {
  insertSession({
    session_id: SESSION_ID,
    task_id: taskId,
    task_url: 'https://notion.so/task-1',
    project_context_url: 'https://notion.so/ctx',
    status: 'idle',
    started_at: Date.now(),
    session_type: 'ops',
  });
}

function makeSessionManager(): SessionManager & EventEmitter {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    enqueueFeedback: vi.fn().mockResolvedValue(undefined),
    getLiveSession: vi.fn().mockReturnValue(undefined),
  }) as unknown as SessionManager & EventEmitter;
}

const VALID_PAYLOAD = {
  taskId: 'task-1',
  title: 'add retry to the poller',
  scope: 'src/ops/poller.ts and its test — add exponential backoff retry',
  reason: 'poller has been dropping events under transient network errors',
};

beforeEach(() => {
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM sessions').run();
  setStagedIntentBroadcast(() => {});
});

describe('ops.prIntent — kind registry membership', () => {
  it('is a KNOWN_INTENT_KINDS member', () => {
    expect(KNOWN_INTENT_KINDS.has('ops.prIntent')).toBe(true);
  });

  it('is in PLANNING_INTENT_KINDS.ops', () => {
    expect(PLANNING_INTENT_KINDS.ops).toContain('ops.prIntent');
  });

  it('is not granted to groom or design sessions', () => {
    expect(PLANNING_INTENT_KINDS.groom).not.toContain('ops.prIntent');
    expect(PLANNING_INTENT_KINDS.design).not.toContain('ops.prIntent');
  });
});

describe('ops.prIntent — stage-time validation', () => {
  it('rejects a missing taskId', () => {
    insertOpsSession('task-1');
    expect(() =>
      stageIntent(
        'ops.prIntent',
        { ...VALID_PAYLOAD, taskId: undefined },
        'proj-1',
        null,
        SESSION_ID,
      ),
    ).toThrow(/payload\.taskId is required/);
  });

  it('rejects a missing title', () => {
    insertOpsSession('task-1');
    expect(() =>
      stageIntent(
        'ops.prIntent',
        { ...VALID_PAYLOAD, title: '' },
        'proj-1',
        null,
        SESSION_ID,
      ),
    ).toThrow(/payload\.title is required/);
  });

  it('rejects a missing scope', () => {
    insertOpsSession('task-1');
    expect(() =>
      stageIntent(
        'ops.prIntent',
        { ...VALID_PAYLOAD, scope: '   ' },
        'proj-1',
        null,
        SESSION_ID,
      ),
    ).toThrow(/payload\.scope/);
  });

  it('rejects a missing reason', () => {
    insertOpsSession('task-1');
    expect(() =>
      stageIntent(
        'ops.prIntent',
        { ...VALID_PAYLOAD, reason: undefined },
        'proj-1',
        null,
        SESSION_ID,
      ),
    ).toThrow(/payload\.reason/);
  });

  it('rejects a groupId — applies via direct approval, not a group commit', () => {
    insertOpsSession('task-1');
    expect(() =>
      stageIntent(
        'ops.prIntent',
        VALID_PAYLOAD,
        'proj-1',
        'some-group',
        SESSION_ID,
      ),
    ).toThrow(/cannot belong to a group/);
  });

  it('stages successfully with a complete payload', () => {
    insertOpsSession('task-1');
    const intent = stageIntent(
      'ops.prIntent',
      VALID_PAYLOAD,
      'proj-1',
      null,
      SESSION_ID,
    );
    expect(intent.kind).toBe('ops.prIntent');
    expect(intent.state).toBe('staged');
    expect((intent.payload as { taskId: string }).taskId).toBe('task-1');
  });
});

describe('ops.prIntent — approval is terminal', () => {
  it('transitions straight to committed with no separate apply step', async () => {
    insertOpsSession('task-1');
    const staged = stageIntent(
      'ops.prIntent',
      VALID_PAYLOAD,
      'proj-1',
      null,
      SESSION_ID,
    );

    const sessionManager = makeSessionManager();
    const app = express();
    app.use(express.json());
    app.use('/api', createStagedIntentsRouter(undefined, sessionManager));
    const agent = supertest(app);

    const res = await agent.post(`/api/staged-intents/${staged.id}/approve`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('committed');

    const row = getStagedIntent(staged.id);
    expect(row?.state).toBe('committed');
  });
});
