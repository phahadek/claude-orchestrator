/**
 * GET /api/staged-intents?milestone= canonicalization: the read route must
 * resolve a caller-supplied milestone reference (DB UUID, full display name,
 * or already-canonical short id) through resolveMilestoneForProject before
 * querying — otherwise a caller asking in a different form than a row was
 * written in gets a false-empty {"intents":[]}, which reads as "nothing to
 * decide" instead of an error. See stagedIntents.milestoneNormalization.test.ts
 * for the write-side (stageIntent) half of this normalization.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import {
  insertStagedIntent,
  UNATTRIBUTED_MILESTONE_BUCKET,
} from '../../db/queries';
import type { StagedIntentRow } from '../../db/types';
import {
  createStagedIntentsRouter,
  setStagedIntentBroadcast,
} from '../stagedIntents';

const M13 = {
  id: 'ms-uuid-13',
  name: 'M13 — Orchestrator-Owned Planning',
  canonicalShortId: 'M13',
};

function seedProjectWithMilestone(projectId: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO projects (id, name, project_dir, task_source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(projectId, projectId, `/tmp/${projectId}`, 'notion', now, now);
  db.prepare(
    `INSERT INTO milestones (id, project_id, name, canonical_short_id, display_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(M13.id, projectId, M13.name, M13.canonicalShortId, 0, now, now);
}

let counter = 0;
function makeRow(overrides: Partial<StagedIntentRow> = {}): StagedIntentRow {
  counter += 1;
  const now = Date.now();
  return {
    id: `intent-${counter}`,
    kind: 'task.setStatus',
    payload: JSON.stringify({ taskId: `task-${counter}` }),
    payload_hash: `hash-${counter}`,
    task_id: `task-${counter}`,
    project_id: 'proj-1',
    session_id: null,
    group_id: null,
    milestone: null,
    state: 'staged',
    supersedes: null,
    annotation: null,
    decision_proposal: null,
    groom_proposal: null,
    advisory: null,
    disposition_reason: null,
    answer: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function makeApp() {
  const app = express();
  app.use(express.json());
  setStagedIntentBroadcast(() => {});
  app.use('/api', createStagedIntentsRouter());
  return app;
}

beforeEach(() => {
  counter = 0;
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM milestones').run();
  db.prepare('DELETE FROM projects').run();
  seedProjectWithMilestone('proj-1');
});

describe('GET /api/staged-intents?milestone= canonicalization', () => {
  it('returns the same row set whether queried by display name or by DB UUID', async () => {
    const staged = makeRow({ milestone: 'M13' });
    insertStagedIntent(staged);
    const agent = supertest(makeApp());

    const byName = await agent
      .get('/api/staged-intents')
      .query({ projectId: 'proj-1', milestone: M13.name });
    const byId = await agent
      .get('/api/staged-intents')
      .query({ projectId: 'proj-1', milestone: M13.id });
    const byCanonical = await agent
      .get('/api/staged-intents')
      .query({ projectId: 'proj-1', milestone: 'M13' });

    for (const res of [byName, byId, byCanonical]) {
      expect(res.status).toBe(200);
      expect(res.body.intents.map((i: { id: string }) => i.id)).toEqual([
        staged.id,
      ]);
    }
  });

  it('rejects an unresolvable milestone with a 400 naming the known milestones', async () => {
    const agent = supertest(makeApp());
    const res = await agent
      .get('/api/staged-intents')
      .query({ projectId: 'proj-1', milestone: 'not-a-real-milestone' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(M13.name);
  });

  it('the "unattributed" sentinel bypasses canonicalization and returns milestone-IS-NULL rows', async () => {
    const attributed = makeRow({ milestone: 'M13' });
    const unattributed = makeRow({ milestone: null });
    insertStagedIntent(attributed);
    insertStagedIntent(unattributed);
    const agent = supertest(makeApp());

    const res = await agent.get('/api/staged-intents').query({
      projectId: 'proj-1',
      milestone: UNATTRIBUTED_MILESTONE_BUCKET,
    });

    expect(res.status).toBe(200);
    expect(res.body.intents.map((i: { id: string }) => i.id)).toEqual([
      unattributed.id,
    ]);
  });

  it('a routinely-staged intent with a resolvable milestone does not land in the unattributed bucket', async () => {
    const attributed = makeRow({ milestone: 'M13' });
    insertStagedIntent(attributed);
    const agent = supertest(makeApp());

    const unattributedRes = await agent.get('/api/staged-intents').query({
      projectId: 'proj-1',
      milestone: UNATTRIBUTED_MILESTONE_BUCKET,
    });
    expect(
      unattributedRes.body.intents.map((i: { id: string }) => i.id),
    ).not.toContain(attributed.id);

    const milestoneRes = await agent
      .get('/api/staged-intents')
      .query({ projectId: 'proj-1', milestone: 'M13' });
    expect(
      milestoneRes.body.intents.map((i: { id: string }) => i.id),
    ).toContain(attributed.id);
  });

  it('an intent staged under any accepted milestone form appears in the milestone-scoped decision-surface result set', async () => {
    const stagedByCanonical = makeRow({ milestone: 'M13' });
    insertStagedIntent(stagedByCanonical);
    const agent = supertest(makeApp());

    const res = await agent
      .get('/api/staged-intents')
      .query({ projectId: 'proj-1', milestone: M13.id });

    expect(
      res.body.intents.some(
        (i: { id: string }) => i.id === stagedByCanonical.id,
      ),
    ).toBe(true);
  });
});
