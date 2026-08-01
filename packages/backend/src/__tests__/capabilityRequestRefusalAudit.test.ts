/**
 * A session.requestCapability refused before it ever becomes a staged_intent
 * row (stage-time vocabulary check) or before it ever actually widens
 * --allowed-tools (grant-time denylist check) previously left no trace
 * anywhere but the requesting session's own transcript. This covers the
 * fix: both refusal gates now write a `capability_request_refused` audit
 * event, distinguishable by a `gate` field, carrying the requested
 * capability string verbatim and a non-null project_id so it is reachable
 * through the existing project-scoped audit surface.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';

vi.mock('../db/db', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../db/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/queries')>();
  return {
    ...actual,
    getTaskCache: vi.fn().mockReturnValue(null),
  };
});

import { db } from '../db/db';
import { createStagedIntentsRouter, stageIntent } from '../routes/stagedIntents';
import { queryAuditLogByProject } from '../audit/AuditLog';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter());
  return app;
}

beforeEach(() => {
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM audit_log').run();
});

describe('vocabulary refusal (stage time) records a capability_request_refused audit event', () => {
  it('records the malformed request verbatim, naming the requesting session and the vocabulary gate', () => {
    expect(() =>
      stageIntent(
        'session.requestCapability',
        { capability: 'banana', plan: 'do something', evidence: 'because' },
        'proj-refusal-1',
        null,
        'session-refusal-1',
        null,
      ),
    ).toThrow(/not a supported capability shape/);

    const { entries } = queryAuditLogByProject('proj-refusal-1', {
      eventType: 'capability_request_refused',
    });
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry.projectId).toBe('proj-refusal-1');
    expect(entry.actorId).toBe('session-refusal-1');
    expect(entry.payload).toMatchObject({
      capability: 'banana',
      gate: 'vocabulary',
    });
  });

  it('records a coherent-but-unsupported shape verbatim, distinct from a malformed one', () => {
    expect(() =>
      stageIntent(
        'session.requestCapability',
        {
          capability: 'read:session-events:proj-refusal-2',
          plan: 'aggregate session_events',
          evidence: 'need a count',
        },
        'proj-refusal-2',
        null,
        'session-refusal-2',
        null,
      ),
    ).toThrow(/not a supported capability shape/);

    const { entries } = queryAuditLogByProject('proj-refusal-2', {
      eventType: 'capability_request_refused',
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].payload).toMatchObject({
      capability: 'read:session-events:proj-refusal-2',
      gate: 'vocabulary',
    });
  });

  it('never converts the refusal into a success — the intent still does not reach staged', () => {
    try {
      stageIntent(
        'session.requestCapability',
        { capability: 'banana', plan: 'x', evidence: 'y' },
        'proj-refusal-3',
        null,
        'session-refusal-3',
        null,
      );
    } catch {
      // expected
    }
    const row = db
      .prepare('SELECT COUNT(*) AS cnt FROM staged_intent WHERE project_id = ?')
      .get('proj-refusal-3') as { cnt: number };
    expect(row.cnt).toBe(0);
  });
});

describe('grant-time denylist refusal records a capability_request_refused audit event distinguishable by gate', () => {
  it('records a well-formed but denylisted capability as "denylist", not "vocabulary"', async () => {
    const intent = stageIntent(
      'session.requestCapability',
      {
        capability: 'mcp__orchestrator__task_applyIntent',
        plan: 'apply the intent directly',
        evidence: 'because',
      },
      'proj-refusal-4',
      null,
      'session-refusal-4',
      null,
    );

    const app = makeApp();
    const agent = supertest(app);
    const res = await agent
      .post(`/api/staged-intents/${intent.id}/approve`)
      .send({});
    expect(res.status).toBe(200);

    const { entries } = queryAuditLogByProject('proj-refusal-4', {
      eventType: 'capability_request_refused',
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].payload).toMatchObject({
      capability: 'mcp__orchestrator__task_applyIntent',
      gate: 'denylist',
    });
    expect(entries[0].projectId).toBe('proj-refusal-4');
    expect(entries[0].actorId).toBe('session-refusal-4');
  });

  it('does not record a refusal for a well-formed, grantable capability', async () => {
    const intent = stageIntent(
      'session.requestCapability',
      {
        capability: 'Bash(psql:*)',
        plan: 'query the db',
        evidence: 'because',
      },
      'proj-refusal-5',
      null,
      'session-refusal-5',
      null,
    );

    const app = makeApp();
    const agent = supertest(app);
    await agent.post(`/api/staged-intents/${intent.id}/approve`).send({});

    const { entries } = queryAuditLogByProject('proj-refusal-5', {
      eventType: 'capability_request_refused',
    });
    expect(entries).toHaveLength(0);
  });
});
