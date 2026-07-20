/**
 * Tests for the arch.createUnit / arch.updateUnit / arch.supersedeUnit
 * staged-intent kinds: apply dispatches through ArchWriteCommands onto the
 * arch_unit store, writing the row + an event-log entry; a split group
 * (updateUnit + sibling createUnit) commits atomically; a stale base_version
 * apply is blocked with an annotation; a supersede blocks subsequent stale
 * edits to the superseded unit.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
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
import { createStagedIntentsRouter } from '../stagedIntents';
import { getUnit, getUnitEvents } from '../../architecture/ArchUnitStore';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter());
  return app;
}

function archMetadata(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'invariant',
    topic: 'architecture-store',
    regions: ['packages/backend/src/architecture'],
    ...overrides,
  };
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  mockGetTaskBackend.mockReturnValue({ type: 'notion' });
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM arch_unit_event').run();
  db.prepare('DELETE FROM arch_unit').run();
  db.prepare('DELETE FROM audit_log').run();
});

describe('arch.createUnit', () => {
  it('applying writes the arch_unit store + a created event row', async () => {
    const app = makeApp();
    const agent = supertest(app);

    const staged = await agent.post('/api/staged-intents').send({
      kind: 'arch.createUnit',
      projectId: 'proj-a',
      payload: {
        title: 'Command layer',
        metadata: archMetadata(),
        body: '# Command layer\nDescribes the staged-intent flow.',
      },
    });
    expect(staged.status).toBe(201);

    const applied = await agent
      .post(`/api/staged-intents/${staged.body.id}/apply`)
      .send({});
    expect(applied.status).toBe(200);
    const unitId = applied.body.result.id as string;

    const unit = getUnit(unitId);
    expect(unit?.title).toBe('Command layer');
    expect(unit?.version).toBe(1);

    const events = getUnitEvents(unitId);
    expect(events.map((e) => e.eventType)).toEqual(['created']);
  });
});

describe('arch.updateUnit', () => {
  async function stageAndCreateUnit(agent: ReturnType<typeof supertest>) {
    const staged = await agent.post('/api/staged-intents').send({
      kind: 'arch.createUnit',
      projectId: 'proj-b',
      payload: {
        title: 'Original title',
        metadata: archMetadata(),
        body: 'original body',
      },
    });
    const applied = await agent
      .post(`/api/staged-intents/${staged.body.id}/apply`)
      .send({});
    return applied.body.result.id as string;
  }

  it('applying a correct base_version writes the update + an updated event row', async () => {
    const app = makeApp();
    const agent = supertest(app);
    const unitId = await stageAndCreateUnit(agent);

    const staged = await agent.post('/api/staged-intents').send({
      kind: 'arch.updateUnit',
      projectId: 'proj-b',
      payload: { unitId, baseVersion: 1, body: 'revised body' },
    });
    const applied = await agent
      .post(`/api/staged-intents/${staged.body.id}/apply`)
      .send({});

    expect(applied.status).toBe(200);
    const unit = getUnit(unitId);
    expect(unit?.body).toBe('revised body');
    expect(unit?.version).toBe(2);

    const events = getUnitEvents(unitId);
    expect(events.map((e) => e.eventType)).toEqual(['created', 'updated']);
  });

  it('blocks a stale base_version apply with a blocked annotation', async () => {
    const app = makeApp();
    const agent = supertest(app);
    const unitId = await stageAndCreateUnit(agent);

    // Advance the unit to version 2 out from under the staged intent.
    const firstEdit = await agent.post('/api/staged-intents').send({
      kind: 'arch.updateUnit',
      projectId: 'proj-b',
      payload: { unitId, baseVersion: 1, body: 'edit one' },
    });
    await agent.post(`/api/staged-intents/${firstEdit.body.id}/apply`).send({});

    // A second edit composed against the now-stale version 1.
    const staleEdit = await agent.post('/api/staged-intents').send({
      kind: 'arch.updateUnit',
      projectId: 'proj-b',
      payload: { unitId, baseVersion: 1, body: 'edit two (stale)' },
    });
    const applied = await agent
      .post(`/api/staged-intents/${staleEdit.body.id}/apply`)
      .send({});

    expect(applied.status).toBe(409);
    expect(applied.body.error).toMatch(/stale edit/i);

    const list = await agent
      .get('/api/staged-intents')
      .query({ projectId: 'proj-b' });
    const row = list.body.intents.find(
      (i: { id: string }) => i.id === staleEdit.body.id,
    );
    expect(row.annotation).toEqual({
      blocked: true,
      reasons: [expect.stringMatching(/stale edit/i)],
    });

    // The stale edit never landed.
    expect(getUnit(unitId)?.body).toBe('edit one');
  });
});

describe('arch.supersedeUnit', () => {
  it('applying writes the supersede + created/superseded event rows', async () => {
    const app = makeApp();
    const agent = supertest(app);

    const createStaged = await agent.post('/api/staged-intents').send({
      kind: 'arch.createUnit',
      projectId: 'proj-c',
      payload: {
        title: 'Old decision',
        metadata: archMetadata({ kind: 'decision' }),
        body: 'old body',
      },
    });
    const createApplied = await agent
      .post(`/api/staged-intents/${createStaged.body.id}/apply`)
      .send({});
    const unitId = createApplied.body.result.id as string;

    const supersedeStaged = await agent.post('/api/staged-intents').send({
      kind: 'arch.supersedeUnit',
      projectId: 'proj-c',
      payload: {
        unitId,
        baseVersion: 1,
        replacement: {
          title: 'New decision',
          metadata: archMetadata({ kind: 'decision' }),
          body: 'new body',
        },
      },
    });
    const supersedeApplied = await agent
      .post(`/api/staged-intents/${supersedeStaged.body.id}/apply`)
      .send({});

    expect(supersedeApplied.status).toBe(200);
    const nextId = supersedeApplied.body.result.nextId as string;

    const previous = getUnit(unitId);
    expect(previous?.status).toBe('superseded');
    expect(previous?.supersededBy).toBe(nextId);

    const next = getUnit(nextId);
    expect(next?.title).toBe('New decision');
    expect(next?.supersedes).toBe(unitId);

    expect(getUnitEvents(unitId).map((e) => e.eventType)).toEqual([
      'created',
      'superseded',
    ]);
    expect(getUnitEvents(nextId).map((e) => e.eventType)).toEqual(['created']);
  });

  it('blocks a subsequent stale edit staged against the now-superseded unit', async () => {
    const app = makeApp();
    const agent = supertest(app);

    const createStaged = await agent.post('/api/staged-intents').send({
      kind: 'arch.createUnit',
      projectId: 'proj-d',
      payload: {
        title: 'Old decision',
        metadata: archMetadata({ kind: 'decision' }),
        body: 'old body',
      },
    });
    const createApplied = await agent
      .post(`/api/staged-intents/${createStaged.body.id}/apply`)
      .send({});
    const unitId = createApplied.body.result.id as string;

    // Stage an edit against the current (pre-supersede) version.
    const pendingEdit = await agent.post('/api/staged-intents').send({
      kind: 'arch.updateUnit',
      projectId: 'proj-d',
      payload: { unitId, baseVersion: 1, body: 'racing edit' },
    });

    // Supersede lands first.
    const supersedeStaged = await agent.post('/api/staged-intents').send({
      kind: 'arch.supersedeUnit',
      projectId: 'proj-d',
      payload: {
        unitId,
        baseVersion: 1,
        replacement: {
          title: 'New decision',
          metadata: archMetadata({ kind: 'decision' }),
          body: 'new body',
        },
      },
    });
    const supersedeApplied = await agent
      .post(`/api/staged-intents/${supersedeStaged.body.id}/apply`)
      .send({});
    expect(supersedeApplied.status).toBe(200);

    // The pending edit against the now-superseded unit is blocked, not applied.
    const editApplied = await agent
      .post(`/api/staged-intents/${pendingEdit.body.id}/apply`)
      .send({});

    expect(editApplied.status).toBe(409);
    expect(editApplied.body.error).toMatch(/already been superseded/i);
    expect(getUnit(unitId)?.body).toBe('old body');
  });
});

describe('unit split — a groupId-correlated arch.updateUnit + sibling arch.createUnit', () => {
  it('commits atomically via the group commit endpoint', async () => {
    const app = makeApp();
    const agent = supertest(app);

    const createStaged = await agent.post('/api/staged-intents').send({
      kind: 'arch.createUnit',
      projectId: 'proj-e',
      payload: {
        title: 'Monolithic subsystem doc',
        metadata: archMetadata({ kind: 'subsystem' }),
        body: 'covers both halves',
      },
    });
    const createApplied = await agent
      .post(`/api/staged-intents/${createStaged.body.id}/apply`)
      .send({});
    const unitId = createApplied.body.result.id as string;

    const groupId = 'split-group-1';
    const updateStaged = await agent.post('/api/staged-intents').send({
      kind: 'arch.updateUnit',
      projectId: 'proj-e',
      groupId,
      payload: {
        unitId,
        baseVersion: 1,
        body: 'covers only the first half',
      },
    });
    const siblingCreateStaged = await agent.post('/api/staged-intents').send({
      kind: 'arch.createUnit',
      projectId: 'proj-e',
      groupId,
      payload: {
        title: 'Second half subsystem doc',
        metadata: archMetadata({ kind: 'subsystem' }),
        body: 'covers the second half',
      },
    });

    await agent
      .post(`/api/staged-intents/${updateStaged.body.id}/approve`)
      .send({});
    await agent
      .post(`/api/staged-intents/${siblingCreateStaged.body.id}/approve`)
      .send({});

    const commit = await agent
      .post(`/api/staged-intents/group/${groupId}/commit`)
      .send({});

    expect(commit.status).toBe(200);
    expect(commit.body.committed.sort()).toEqual(
      [updateStaged.body.id, siblingCreateStaged.body.id].sort(),
    );

    const updatedUnit = getUnit(unitId);
    expect(updatedUnit?.body).toBe('covers only the first half');
    expect(updatedUnit?.version).toBe(2);

    const list = await agent
      .get('/api/staged-intents')
      .query({ projectId: 'proj-e' });
    expect(list.body.intents).toHaveLength(0);
  });
});
