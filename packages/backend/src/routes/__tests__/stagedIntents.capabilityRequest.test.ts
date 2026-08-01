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

  it('grants the own-record read capability (session_events/audit_log by target session id) through the same approve -> grant -> re-dispatch loop', async () => {
    const sessionManager = makeSessionManager();
    const app = makeApp(sessionManager);

    const intent = stageIntent(
      'session.requestCapability',
      {
        capability: 'read:session-record:target-session-9',
        plan: "verify gate item d9a3d3e2 by reading the target session's own record",
        evidence:
          "no other grantable capability reaches this orchestrator's own DB",
      },
      'proj-1',
      null,
      'sess-verify-1',
    );

    const res = await supertest(app).post(
      `/api/staged-intents/${intent.id}/approve`,
    );

    expect(res.status).toBe(200);
    expect(sessionManager.grantCapability).toHaveBeenCalledWith(
      'sess-verify-1',
      'read:session-record:target-session-9',
    );
  });

  it('grants the audit-log read capability (audit_log by project id) through the same approve -> grant -> re-dispatch loop', async () => {
    const sessionManager = makeSessionManager();
    const app = makeApp(sessionManager);

    const intent = stageIntent(
      'session.requestCapability',
      {
        capability: 'read:audit-log:proj-9',
        plan: "verify a prior session's staged writes for this project",
        evidence:
          "no other grantable capability reaches this orchestrator's own DB",
      },
      'proj-1',
      null,
      'sess-verify-2',
    );

    const res = await supertest(app).post(
      `/api/staged-intents/${intent.id}/approve`,
    );

    expect(res.status).toBe(200);
    expect(sessionManager.grantCapability).toHaveBeenCalledWith(
      'sess-verify-2',
      'read:audit-log:proj-9',
    );
  });

  it('grants the session-events read capability (session_events aggregated by project id) through the same approve -> grant -> re-dispatch loop', async () => {
    const sessionManager = makeSessionManager();
    const app = makeApp(sessionManager);

    const intent = stageIntent(
      'session.requestCapability',
      {
        capability: 'read:session-events:proj-9',
        plan: 'verify a gate item asking whether an event occurred across any session in this project',
        evidence:
          "no other grantable capability reaches this orchestrator's own DB in aggregate",
      },
      'proj-1',
      null,
      'sess-verify-3',
    );

    const res = await supertest(app).post(
      `/api/staged-intents/${intent.id}/approve`,
    );

    expect(res.status).toBe(200);
    expect(sessionManager.grantCapability).toHaveBeenCalledWith(
      'sess-verify-3',
      'read:session-events:proj-9',
    );
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

  it('rejects a non-conforming capability shape at stage time, before any row is written', () => {
    let caught: unknown;
    try {
      stageIntent(
        'session.requestCapability',
        {
          capability: 'banana',
          plan: 'do something',
          evidence: 'because',
        },
        'proj-1',
        null,
        'sess-6',
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/not a supported capability shape/);
    expect((caught as Error).name).toBe('CapabilityRequestValidationError');

    const rows = db
      .prepare(
        "SELECT * FROM staged_intent WHERE kind = 'session.requestCapability'",
      )
      .all();
    expect(rows).toHaveLength(0);
  });

  it.each(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])(
    'rejects a denylisted bare tool name "%s" as denied, not as an unsupported shape',
    (capability) => {
      let caught: unknown;
      try {
        stageIntent(
          'session.requestCapability',
          { capability, plan: 'edit a file directly', evidence: 'because' },
          'proj-1',
          null,
          'sess-denied',
        );
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).name).toBe('CapabilityRequestDeniedError');
      expect((caught as Error).message).toMatch(/is denied/);
      expect((caught as Error).message).not.toMatch(
        /not a supported capability shape/,
      );

      const rows = db
        .prepare(
          "SELECT * FROM staged_intent WHERE kind = 'session.requestCapability'",
        )
        .all();
      expect(rows).toHaveLength(0);
    },
  );

  it('stages a well-formed but isGrantable-denylisted capability normally — denylist enforcement stays at grant time, not stage time', () => {
    const intent = stageIntent(
      'session.requestCapability',
      {
        capability: 'mcp__github__resolve_review_thread',
        plan: 'resolve the review thread directly',
        evidence: 'reviewer asked for it',
      },
      'proj-1',
      null,
      'sess-7',
    );

    expect(intent.state).toBe('staged');
  });

  it('refuses at stage time when a groupId is supplied — a capability grant applies via SessionManager.grantCapability + respawn, never a group commit', () => {
    expect(() =>
      stageIntent(
        'session.requestCapability',
        {
          capability: 'Bash(psql:*)',
          plan: 'inspect prod row counts',
          evidence: 'task asks for a row-count audit',
        },
        'proj-1',
        'retire-arch-pages-proposal-2026-07-28',
        'sess-8',
      ),
    ).toThrow(/cannot belong to a group/);
  });

  it('without a groupId stages normally, unaffected by the groupId guard', () => {
    const intent = stageIntent(
      'session.requestCapability',
      {
        capability: 'Bash(psql:*)',
        plan: 'inspect prod row counts',
        evidence: 'task asks for a row-count audit',
      },
      'proj-1',
      null,
      'sess-9',
    );
    expect(intent.state).toBe('staged');
    expect(intent.groupId).toBeNull();
  });

  it('marks a Bash(...) capability that confers file mutation on the staged intent', () => {
    const intent = stageIntent(
      'session.requestCapability',
      {
        capability: 'Bash(sed:*)',
        plan: "Run: sed -i '/- name: Build/i - name: Test frontend' build.yml",
        evidence: 'operator directed this session to edit the workflow',
      },
      'proj-1',
      null,
      'sess-10',
    );
    expect(intent.confersFileMutation).toBe(true);
  });

  it('does not mark a Bash(...) capability that does not confer file mutation', () => {
    const intent = stageIntent(
      'session.requestCapability',
      {
        capability: 'Bash(psql:*)',
        plan: 'inspect prod row counts',
        evidence: 'task asks for a row-count audit',
      },
      'proj-1',
      null,
      'sess-11',
    );
    expect(intent.confersFileMutation).toBe(false);
  });

  it('leaves the mark advisory — the intent still stages and remains approvable', async () => {
    const sessionManager = makeSessionManager();
    const app = makeApp(sessionManager);

    const intent = stageIntent(
      'session.requestCapability',
      {
        capability: 'Bash(tee:*)',
        plan: 'write build output to a log file',
        evidence: 'debugging a failing build',
      },
      'proj-1',
      null,
      'sess-12',
    );
    expect(intent.state).toBe('staged');
    expect(intent.confersFileMutation).toBe(true);

    const res = await supertest(app).post(
      `/api/staged-intents/${intent.id}/approve`,
    );
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('committed');
    expect(sessionManager.grantCapability).toHaveBeenCalledWith(
      'sess-12',
      'Bash(tee:*)',
    );
  });
});
