import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const { mockGetTaskBackend } = vi.hoisted(() => ({
  mockGetTaskBackend: vi.fn(),
}));

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: mockGetTaskBackend,
}));

// Isolated in-memory db, matching stagedIntents.accretionFeedback.test.ts's
// setup — otherwise staged_intent / gate_accretion / seed_accretion rows
// persist across test cases and produce spurious dedup collisions.
vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { createStagedIntentsRouter } from '../stagedIntents';
import { recordAccretionMarker } from '../../gate/gateStore';
import { recordAccretionMarker as recordSeedAccretionMarker } from '../../seed/seedStore';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter());
  return app;
}

function makeBackend(body: string) {
  return {
    type: 'local' as const,
    updateStatus: vi.fn().mockResolvedValue(undefined),
    setDependsOn: vi.fn().mockResolvedValue(undefined),
    fetchTaskPage: vi.fn().mockResolvedValue(body),
  };
}

/** A fully-groomed grooming-gate payload for a 💻 Code task, minus the field under test. */
function wellFormedGroomingGate() {
  return {
    size_check: { decision: 'n/a' },
    type_check: { decision: 'none' },
    type: '💻 Code',
    filesPathsEntries: [
      {
        raw: 'packages/backend/src/foo.ts',
        isNew: true,
        existsInRepo: false,
      },
    ],
  };
}

function recordAccretion(taskId: string) {
  recordAccretionMarker({
    sourceTaskId: taskId,
    project: 'polimarket-analyser',
    milestone: 'M12',
    decision: 'n/a',
    accretedAt: new Date(0).toISOString(),
  });
  recordSeedAccretionMarker({
    sourceTaskId: taskId,
    project: 'polimarket-analyser',
    milestone: 'M12',
    decision: 'n/a',
    accretedAt: new Date(0).toISOString(),
  });
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM gate_accretion').run();
  db.prepare('DELETE FROM seed_accretion').run();
});

describe('POST /api/staged-intents — stage-time readiness-gate feedback', () => {
  it('annotates a task.setStatus -> Ready intent whose proposed body still has a live Open Questions section', async () => {
    mockGetTaskBackend.mockReturnValue(
      makeBackend('## Open Questions\n- Still unresolved?\n'),
    );
    recordAccretion('notion:open-questions');

    const app = buildApp();
    const res = await supertest(app)
      .post('/api/staged-intents')
      .send({
        kind: 'task.setStatus',
        payload: {
          taskId: 'notion:open-questions',
          status: 'Ready',
          groomingGate: wellFormedGroomingGate(),
        },
        projectId: 'proj-1',
      });

    expect(res.status).toBe(201);
    expect(res.body.annotation).toBeTruthy();
    expect(res.body.annotation.blocked).toBe(true);
    expect(
      res.body.annotation.violations.some((v: { detail: string }) =>
        v.detail.includes('Open Questions'),
      ),
    ).toBe(true);
  });

  it('does not annotate a well-formed, fully-groomed task.setStatus -> Ready intent', async () => {
    mockGetTaskBackend.mockReturnValue(makeBackend('## Summary\nClean.'));
    recordAccretion('notion:well-formed');

    const app = buildApp();
    const res = await supertest(app)
      .post('/api/staged-intents')
      .send({
        kind: 'task.setStatus',
        payload: {
          taskId: 'notion:well-formed',
          status: 'Ready',
          groomingGate: wellFormedGroomingGate(),
        },
        projectId: 'proj-1',
      });

    expect(res.status).toBe(201);
    expect(res.body.annotation).toBeNull();
    expect(res.body.state).toBe('staged');
  });

  it('grooming-gate reasons take priority over readiness violations when both apply', async () => {
    mockGetTaskBackend.mockReturnValue(
      makeBackend('## Open Questions\n- Still unresolved?\n'),
    );
    // No accretion markers recorded, and no filesPathsEntries — the
    // grooming-promotion gate (missing fields) should surface before the
    // readiness gate (body content) is even checked.
    const app = buildApp();
    const res = await supertest(app)
      .post('/api/staged-intents')
      .send({
        kind: 'task.setStatus',
        payload: {
          taskId: 'notion:doubly-incomplete',
          status: 'Ready',
          groomingGate: {
            size_check: { decision: 'n/a' },
            type_check: { decision: 'none' },
            type: '💻 Code',
          },
        },
        projectId: 'proj-1',
      });

    expect(res.status).toBe(201);
    expect(res.body.annotation).toBeTruthy();
    expect(res.body.annotation.reasons).toBeTruthy();
    expect(res.body.annotation.violations).toBeUndefined();
  });
});
