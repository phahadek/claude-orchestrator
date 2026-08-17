/**
 * The [operator-disposition] notice resumeCapabilityRequester sends on a
 * session.requestCapability approval must be the same, actionable "granted
 * — use it now" message regardless of grantCapability's respawnApplied
 * flag: a session has no concept of a respawn, so wording that depends on
 * whether one happened either misinforms it (in the common non-tool-shaped
 * case, where no respawn is ever attempted but the grant is already live)
 * or instructs it to stop working (in the tool-shaped case). Whether a
 * respawn actually ran is an operator-facing concern (already logged by
 * respawnForCapabilityGrant), not something to relay to the session.
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

function stageCapabilityRequest(
  sessionId: string,
  capability = 'Bash(psql:*)',
) {
  return stageIntent(
    'session.requestCapability',
    {
      capability,
      plan: 'inspect prod row counts',
      evidence: 'task asks for a row-count audit',
    },
    'proj-1',
    null,
    sessionId,
  );
}

const FORBIDDEN_PHRASES = [/resume/i, /not yet active/i, /do not attempt/i];

function assertNoStopLanguage(message: string) {
  for (const phrase of FORBIDDEN_PHRASES) {
    expect(message).not.toMatch(phrase);
  }
}

describe('resumeCapabilityRequester approved-outcome notice', () => {
  it('a tool-shaped capability whose respawn succeeded is told it is granted and usable now', async () => {
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
      'Capability request approved: "Bash(psql:*)" has been granted — you can use it now.',
    );
    assertNoStopLanguage(message);
  });

  it('a non-tool-shaped capability (never respawned) is told the same thing, not that it must wait', async () => {
    const sessionManager = makeSessionManager(false);
    const app = makeApp(sessionManager);
    const intent = stageCapabilityRequest(
      'sess-non-tool-shaped',
      'read:audit-log:proj-1',
    );

    const res = await supertest(app).post(
      `/api/staged-intents/${intent.id}/approve`,
    );

    expect(res.status).toBe(200);
    const [, , message] = sessionManager.enqueueFeedback.mock.calls[0];
    expect(message).toBe(
      'Capability request approved: "read:audit-log:proj-1" has been granted — you can use it now.',
    );
    assertNoStopLanguage(message);
  });

  it('a capability granted for a session that is not currently live gets the same message', async () => {
    const sessionManager = makeSessionManager(false);
    const app = makeApp(sessionManager);
    const intent = stageCapabilityRequest('sess-not-live');

    const res = await supertest(app).post(
      `/api/staged-intents/${intent.id}/approve`,
    );

    expect(res.status).toBe(200);
    const [, , message] = sessionManager.enqueueFeedback.mock.calls[0];
    expect(message).toBe(
      'Capability request approved: "Bash(psql:*)" has been granted — you can use it now.',
    );
    assertNoStopLanguage(message);
  });

  it('a tool-shaped capability whose respawn failed (worktree missing) still gets the same message, not stop-and-wait wording', async () => {
    const sessionManager = makeSessionManager(false);
    const app = makeApp(sessionManager);
    const intent = stageCapabilityRequest('sess-respawn-failed');

    const res = await supertest(app).post(
      `/api/staged-intents/${intent.id}/approve`,
    );

    expect(res.status).toBe(200);
    const [, , message] = sessionManager.enqueueFeedback.mock.calls[0];
    expect(message).toBe(
      'Capability request approved: "Bash(psql:*)" has been granted — you can use it now.',
    );
    assertNoStopLanguage(message);
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

  it('pushback and decline messages are unchanged', async () => {
    const sessionManager = makeSessionManager(false);
    const app = makeApp(sessionManager);

    const pushbackIntent = stageCapabilityRequest('sess-pushback');
    await supertest(app)
      .post(`/api/staged-intents/${pushbackIntent.id}/reject`)
      .send({ outcome: 'pushback', reason: 'needs more evidence' });
    const [, , pushbackMessage] = sessionManager.enqueueFeedback.mock.calls[0];
    expect(pushbackMessage).toBe(
      'Capability request "Bash(psql:*)" was sent back for revision. Feedback: needs more evidence',
    );

    const declineIntent = stageCapabilityRequest('sess-decline');
    await supertest(app)
      .post(`/api/staged-intents/${declineIntent.id}/reject`)
      .send({ outcome: 'decline', reason: 'not needed' });
    const [, , declineMessage] = sessionManager.enqueueFeedback.mock.calls[1];
    expect(declineMessage).toBe(
      'Capability request "Bash(psql:*)" was declined. Reason: not needed',
    );
  });
});
