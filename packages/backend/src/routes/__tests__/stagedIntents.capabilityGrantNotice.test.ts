/**
 * The [operator-disposition] notice resumeCapabilityRequester sends on a
 * session.requestCapability approval must reflect whether the grant's
 * respawn actually applied — not just that grantCapability was called.
 * grantCapability's persistence (the granted set) and its live-application
 * (respawnApplied) are independent: this exercises both wordings the
 * approved-outcome message can take, keyed off grantCapability's returned
 * respawnApplied flag.
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

function makeSessionManager(respawnApplied: boolean) {
  return {
    grantCapability: vi
      .fn()
      .mockResolvedValue({ granted: ['Bash(psql:*)'], respawnApplied }),
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

function stageCapabilityRequest(sessionId: string) {
  return stageIntent(
    'session.requestCapability',
    {
      capability: 'Bash(psql:*)',
      plan: 'inspect prod row counts',
      evidence: 'task asks for a row-count audit',
    },
    'proj-1',
    null,
    sessionId,
  );
}

describe('resumeCapabilityRequester approved-outcome notice', () => {
  it('respawnApplied: true produces the existing "has been granted for this session" wording', async () => {
    const sessionManager = makeSessionManager(true);
    const app = makeApp(sessionManager);
    const intent = stageCapabilityRequest('sess-respawn-applied');

    const res = await supertest(app).post(
      `/api/staged-intents/${intent.id}/approve`,
    );

    expect(res.status).toBe(200);
    expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(1);
    const [, source, message] = sessionManager.enqueueFeedback.mock.calls[0];
    expect(source).toBe('operator-disposition');
    expect(message).toBe(
      'Capability request approved: "Bash(psql:*)" has been granted for this session.',
    );
  });

  it('respawnApplied: false produces a notice stating the capability is recorded but not yet active, effective next resume — not this turn', async () => {
    const sessionManager = makeSessionManager(false);
    const app = makeApp(sessionManager);
    const intent = stageCapabilityRequest('sess-respawn-not-applied');

    const res = await supertest(app).post(
      `/api/staged-intents/${intent.id}/approve`,
    );

    expect(res.status).toBe(200);
    expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(1);
    const [, , message] = sessionManager.enqueueFeedback.mock.calls[0];
    expect(message).toContain('Bash(psql:*)');
    expect(message).not.toContain('has been granted for this session');
    expect(message).toMatch(/not yet active/i);
    expect(message).toMatch(/next resume|not this turn/i);
  });

  it('both wordings are delivered under the operator-disposition source, preserving the message shape sessions and the transcript reader key on', async () => {
    const applied = makeSessionManager(true);
    const appApplied = makeApp(applied);
    const intentApplied = stageCapabilityRequest('sess-a');
    await supertest(appApplied).post(
      `/api/staged-intents/${intentApplied.id}/approve`,
    );
    expect(applied.enqueueFeedback.mock.calls[0][1]).toBe(
      'operator-disposition',
    );

    const notApplied = makeSessionManager(false);
    const appNotApplied = makeApp(notApplied);
    const intentNotApplied = stageCapabilityRequest('sess-b');
    await supertest(appNotApplied).post(
      `/api/staged-intents/${intentNotApplied.id}/approve`,
    );
    expect(notApplied.enqueueFeedback.mock.calls[0][1]).toBe(
      'operator-disposition',
    );
  });
});
