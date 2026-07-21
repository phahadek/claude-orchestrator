/**
 * The session.requestCapability decision-surface kind: how a dispatched
 * session expresses a write-capability request, and the
 * approval -> grant -> re-dispatch wiring on disposition. Approving must
 * grant EXACTLY the requested capability (nothing broader) and re-dispatch
 * the requesting session; a rejected/pushed-back request must grant nothing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { createStagedIntentsRouter, stageIntent } from '../stagedIntents';
import type { SessionManager } from '../../session/SessionManager';

function makeSessionManager() {
  return {
    grantCapability: vi.fn().mockReturnValue([]),
    enqueueFeedback: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionManager & {
    grantCapability: ReturnType<typeof vi.fn>;
    enqueueFeedback: ReturnType<typeof vi.fn>;
  };
}

function makeApp(sessionManager: ReturnType<typeof makeSessionManager>) {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter(undefined, sessionManager));
  return app;
}

beforeEach(() => {
  db.prepare('DELETE FROM staged_intent').run();
});

describe('session.requestCapability decision-surface kind', () => {
  it('renders and is dispositioned via approve — grants exactly the requested capability and re-dispatches', async () => {
    const sessionManager = makeSessionManager();
    const app = makeApp(sessionManager);

    const intent = stageIntent(
      'session.requestCapability',
      {
        capability: 'Bash(psql:*)',
        plan: 'inspect prod row counts',
        evidence: 'task asks for a row-count audit',
      },
      'proj-1',
      null,
      'sess-1',
    );

    const res = await supertest(app).post(
      `/api/staged-intents/${intent.id}/approve`,
    );

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('committed');

    expect(sessionManager.grantCapability).toHaveBeenCalledTimes(1);
    expect(sessionManager.grantCapability).toHaveBeenCalledWith(
      'sess-1',
      'Bash(psql:*)',
    );

    expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(1);
    const [sessionId, source, message] =
      sessionManager.enqueueFeedback.mock.calls[0];
    expect(sessionId).toBe('sess-1');
    expect(source).toBe('operator-disposition');
    expect(message).toMatch(/approved/i);
    expect(message).toContain('Bash(psql:*)');
  });

  it('never grants a broader or resolved/apply scope than the exact requested capability', async () => {
    const sessionManager = makeSessionManager();
    const app = makeApp(sessionManager);

    const intent = stageIntent(
      'session.requestCapability',
      {
        capability: 'mcp__github__merge_pull_request',
        plan: 'merge the approved PR',
        evidence: 'reviewer approved',
      },
      'proj-1',
      null,
      'sess-2',
    );

    await supertest(app).post(`/api/staged-intents/${intent.id}/approve`);

    expect(sessionManager.grantCapability).toHaveBeenCalledWith(
      'sess-2',
      'mcp__github__merge_pull_request',
    );
  });

  it('a declined request grants nothing, but still resumes the session with the outcome', async () => {
    const sessionManager = makeSessionManager();
    const app = makeApp(sessionManager);

    const intent = stageIntent(
      'session.requestCapability',
      {
        capability: 'Bash(rm:*)',
        plan: 'clean up temp files',
        evidence: 'disk full',
      },
      'proj-1',
      null,
      'sess-3',
    );

    const res = await supertest(app)
      .post(`/api/staged-intents/${intent.id}/reject`)
      .send({ outcome: 'decline', reason: 'too risky' });

    expect(res.status).toBe(200);
    expect(sessionManager.grantCapability).not.toHaveBeenCalled();
    expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(1);
    const [sessionId, , message] = sessionManager.enqueueFeedback.mock.calls[0];
    expect(sessionId).toBe('sess-3');
    expect(message).toMatch(/declined/i);
    expect(message).toContain('too risky');
  });

  it('a pushed-back request grants nothing and carries the reason in the resume message', async () => {
    const sessionManager = makeSessionManager();
    const app = makeApp(sessionManager);

    const intent = stageIntent(
      'session.requestCapability',
      {
        capability: 'Bash(curl:*)',
        plan: 'ping an API',
        evidence: 'debugging',
      },
      'proj-1',
      null,
      'sess-4',
    );

    const res = await supertest(app)
      .post(`/api/staged-intents/${intent.id}/reject`)
      .send({
        outcome: 'pushback',
        reason: 'use the existing loopback client instead',
      });

    expect(res.status).toBe(200);
    expect(sessionManager.grantCapability).not.toHaveBeenCalled();
    const [, , message] = sessionManager.enqueueFeedback.mock.calls[0];
    expect(message).toContain('use the existing loopback client instead');
  });

  it('rejects with 400 when outcome or reason is missing', async () => {
    const sessionManager = makeSessionManager();
    const app = makeApp(sessionManager);

    const intent = stageIntent(
      'session.requestCapability',
      {
        capability: 'Bash(curl:*)',
        plan: 'ping an API',
        evidence: 'debugging',
      },
      'proj-1',
      null,
      'sess-5',
    );

    const missingOutcome = await supertest(app)
      .post(`/api/staged-intents/${intent.id}/reject`)
      .send({ reason: 'no thanks' });
    expect(missingOutcome.status).toBe(400);

    const missingReason = await supertest(app)
      .post(`/api/staged-intents/${intent.id}/reject`)
      .send({ outcome: 'decline', reason: '   ' });
    expect(missingReason.status).toBe(400);

    expect(sessionManager.enqueueFeedback).not.toHaveBeenCalled();
  });
});
