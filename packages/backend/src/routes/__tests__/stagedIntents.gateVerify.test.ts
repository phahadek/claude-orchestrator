/**
 * Tests for the gate.verify staged-intent kind: a gate-verify session's
 * reported disposition lands as a normal staged intent, and only an
 * operator's approval (never the session, never the backend automatically)
 * turns it into a gate_item_event write — see the task "Retire the
 * gate-verify adjudication layer".
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const { createTaskMock } = vi.hoisted(() => ({
  createTaskMock: vi.fn(async () => 'notion:new-followup-task'),
}));
vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn().mockReturnValue({
    type: 'notion',
    createTask: createTaskMock,
  }),
}));

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import { insertItem, getItem } from '../../gate/gateStore.js';
import { createStagedIntentsRouter } from '../stagedIntents';
import { PLANNING_INTENT_KINDS } from '../../planning/planningIntentKinds';
import { KNOWN_INTENT_KINDS } from '../stagedIntents';
import { ProjectService } from '../../projects/ProjectService.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter());
  return app;
}

function makeGateItem(
  overrides: Partial<Parameters<typeof insertItem>[0]> = {},
) {
  return insertItem({
    project: 'proj-a',
    milestone: 'M12',
    text: 'the record is admitted for auto-dispatch with no manual DB intervention',
    classification: 'Read-Only',
    sources: [{ sourceTaskId: 'notion:abc', sourceTaskTitle: 'Some task' }],
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  });
}

// M13's row id below deliberately mirrors the legacy composite id-space
// (`<projectId>:<notionBoardId>`) production milestones M1-M3 carry — the
// same shape the old boardId fallback silently handed to createTask as a
// Notion database id. Its canonical_short_id ('M13') is what
// gate_item.milestone actually stores in production, and its sourceId is a
// distinct, valid-looking Notion database id — so a test that resolved via
// the retired board.id/name lookup (or the boardId fallback) would either
// miss entirely or hand createTask the wrong id, not vacuously pass.
const M13_SOURCE_ID = 'db00d3a1-aaaa-bbbb-cccc-1234567890ab';

beforeAll(() => {
  ProjectService.create({
    id: 'proj-a',
    name: 'Project A',
    projectDir: '/tmp/proj-a',
  });
  ProjectService.createMilestone({
    id: 'proj-a:legacyboard13',
    projectId: 'proj-a',
    name: 'M13',
    canonicalShortId: 'M13',
    sourceId: M13_SOURCE_ID,
  });
});

beforeEach(() => {
  db.prepare('DELETE FROM gate_item_event').run();
  db.prepare('DELETE FROM gate_item_source').run();
  db.prepare('DELETE FROM gate_item').run();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM audit_log').run();
  createTaskMock.mockClear();
});

describe('gate.verify — intent-kind registration', () => {
  it('is a genuine PLANNING_INTENT_KINDS.ops staged-intent kind and a known intent kind', () => {
    expect(PLANNING_INTENT_KINDS.ops).toContain('gate.verify');
    expect(KNOWN_INTENT_KINDS.has('gate.verify')).toBe(true);
  });
});

describe('gate.verify — stage then apply', () => {
  it('stages, and only records the gate_item_event on operator approval — with the reported disposition/evidence unmodified', async () => {
    const item = makeGateItem();
    const app = makeApp();
    const agent = supertest(app);

    const verbatimEvidence = {
      basis: 'operational',
      note:
        'queried audit_log with a windowed since/until range; there are no ' +
        'audit_log rows of any kind for this task in between, confirming ' +
        'no manual database intervention occurred.',
    };

    const staged = await agent.post('/api/staged-intents').send({
      kind: 'gate.verify',
      projectId: 'proj-a',
      payload: {
        gateItemId: item.id,
        disposition: 'pass',
        evidence: verbatimEvidence,
      },
    });
    expect(staged.status).toBe(201);
    expect(staged.body.state).toBe('staged');

    // Nothing written to the gate item yet — staging alone never mutates
    // gate state.
    expect(getItem(item.id)?.currentDisposition).toBeUndefined();

    const approved = await agent
      .post(`/api/staged-intents/${staged.body.id}/approve`)
      .send({});
    expect(approved.status).toBe(200);

    const applied = await agent
      .post(`/api/staged-intents/${staged.body.id}/apply`)
      .send({});
    expect(applied.status).toBe(200);

    const updated = getItem(item.id);
    expect(updated?.events.at(-1)).toMatchObject({
      disposition: 'pass',
      evidence: verbatimEvidence,
    });

    const row = db
      .prepare('SELECT state FROM staged_intent WHERE id = ?')
      .get(staged.body.id) as { state: string };
    expect(row.state).toBe('committed');
  });

  it('a genuinely abstaining needs-setup verdict leaves state and current_disposition untouched on apply', async () => {
    const item = makeGateItem();
    const app = makeApp();
    const agent = supertest(app);

    const staged = await agent.post('/api/staged-intents').send({
      kind: 'gate.verify',
      projectId: 'proj-a',
      payload: {
        gateItemId: item.id,
        disposition: 'needs-setup',
        evidence: { reason: 'ran out of turn budget' },
      },
    });
    await agent.post(`/api/staged-intents/${staged.body.id}/approve`).send({});
    await agent.post(`/api/staged-intents/${staged.body.id}/apply`).send({});

    const updated = getItem(item.id);
    expect(updated?.state).toBe(item.state);
    expect(updated?.currentDisposition).toBeUndefined();
    expect(updated?.events.at(-1)).toMatchObject({
      disposition: 'needs-setup',
    });
  });

  it('a rejection routes the intent to needs_revision — a normal turn for the session to revise, with no appeal cap', async () => {
    const item = makeGateItem();
    const app = makeApp();
    const agent = supertest(app);

    const staged = await agent.post('/api/staged-intents').send({
      kind: 'gate.verify',
      projectId: 'proj-a',
      payload: {
        gateItemId: item.id,
        disposition: 'pass',
        evidence: { basis: 'source', note: 'read the component' },
      },
    });

    const rejected = await agent
      .post(`/api/staged-intents/${staged.body.id}/reject`)
      .send({
        outcome: 'pushback',
        reason: 'this is source-only, not operational evidence',
      });
    expect(rejected.status).toBe(200);

    const row = db
      .prepare('SELECT state FROM staged_intent WHERE id = ?')
      .get(staged.body.id) as { state: string };
    expect(['needs_revision', 'rejected']).toContain(row.state);

    // No gate_item_event was ever written for the rejected intent.
    expect(getItem(item.id)?.events).toHaveLength(0);

    // The session can re-stage a revised gate.verify for the same item —
    // no cap on revisions, unlike the retired one-shot appeal.
    const restaged = await agent.post('/api/staged-intents').send({
      kind: 'gate.verify',
      projectId: 'proj-a',
      payload: {
        gateItemId: item.id,
        disposition: 'pass',
        evidence: { basis: 'operational', note: 'audit_log confirms it' },
      },
    });
    expect(restaged.status).toBe(201);

    // And that revised report can itself be pushed back on again — a
    // second round, still accepted.
    const rejectedAgain = await agent
      .post(`/api/staged-intents/${restaged.body.id}/reject`)
      .send({
        outcome: 'pushback',
        reason: 'still not enough — cite the specific row',
      });
    expect(rejectedAgain.status).toBe(200);
  });
});

describe('gate.verify — requires a full gate item id', () => {
  it('rejects an 8-character short form at stage time, naming the expected full-uuid shape', async () => {
    const item = makeGateItem();
    const app = makeApp();
    const agent = supertest(app);

    const staged = await agent.post('/api/staged-intents').send({
      kind: 'gate.verify',
      projectId: 'proj-a',
      payload: {
        gateItemId: item.id.slice(0, 8),
        disposition: 'pass',
        evidence: { basis: 'operational', note: 'checked audit_log' },
      },
    });

    expect(staged.status).toBe(400);
    expect(staged.body.error).toMatch(/full gate item id/i);
    expect(staged.body.error).toMatch(/uuid/i);

    // No gate state or staged-intent row was written for the rejected call.
    expect(getItem(item.id)?.events).toHaveLength(0);
    const rows = db
      .prepare('SELECT COUNT(*) as n FROM staged_intent')
      .get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it('accepts a full gate item uuid unchanged', async () => {
    const item = makeGateItem();
    const app = makeApp();
    const agent = supertest(app);

    const staged = await agent.post('/api/staged-intents').send({
      kind: 'gate.verify',
      projectId: 'proj-a',
      payload: {
        gateItemId: item.id,
        disposition: 'pass',
        evidence: { basis: 'operational', note: 'checked audit_log' },
      },
    });

    expect(staged.status).toBe(201);
    expect(staged.body.state).toBe('staged');
  });
});

describe('gate.verify — fail disposition files a follow-up task via resolveMilestoneDatabaseId', () => {
  it('applies cleanly and reaches appendGateItemEvent, with no routeApplyTimeFailure pushback (regression for the 2026-08-01 auto-rejections)', async () => {
    const item = makeGateItem({ milestone: 'M13' });
    const app = makeApp();
    const agent = supertest(app);

    const staged = await agent.post('/api/staged-intents').send({
      kind: 'gate.verify',
      projectId: 'proj-a',
      payload: {
        gateItemId: item.id,
        disposition: 'fail',
        evidence: { basis: 'operational', note: 'the env var is missing' },
      },
    });
    expect(staged.status).toBe(201);

    await agent.post(`/api/staged-intents/${staged.body.id}/approve`).send({});
    const applied = await agent
      .post(`/api/staged-intents/${staged.body.id}/apply`)
      .send({});

    // Before the fix, resolveMilestoneDatabaseId's boardId fallback would
    // hand createTask the legacy composite milestone row id instead of a
    // Notion database id, the real backend would reject it, and this apply
    // would come back 500 with redrivenToSession — exactly what happened to
    // the five gate items auto-rejected on 2026-08-01.
    expect(applied.status).toBe(200);
    expect(applied.body.redrivenToSession).toBeUndefined();

    expect(createTaskMock).toHaveBeenCalledTimes(1);
    expect(createTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({ databaseId: M13_SOURCE_ID }),
    );

    const updated = getItem(item.id);
    expect(updated?.events.at(-1)).toMatchObject({ disposition: 'fail' });

    const row = db
      .prepare('SELECT state FROM staged_intent WHERE id = ?')
      .get(staged.body.id) as { state: string };
    expect(row.state).toBe('committed');
  });
});
