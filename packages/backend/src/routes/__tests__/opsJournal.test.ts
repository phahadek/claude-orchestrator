/**
 * Tests for the ops_journal route (packages/backend/src/routes/opsJournal.ts).
 *
 * AC: POST /api/ops-journal/:taskId/state accepts a candidate -> resolved
 * write carrying a resolution object and persists it — the direct terminal
 * path for an Investigation that never applies a change.
 */

import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import { createOpsJournalRouter } from '../opsJournal.js';
import { upsertOpsJournalEntry } from '../../db/queries.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createOpsJournalRouter());
  return app;
}

beforeEach(() => {
  db.prepare('DELETE FROM ops_journal').run();
});

function seedEntry(taskId: string, state = 'candidate') {
  upsertOpsJournalEntry({
    task_id: taskId,
    project: 'polimarket-analyser',
    milestone: 'M12',
    state,
    disposition: null,
    worked_in: null,
    evidence: null,
    finding_or_proposal: null,
    falsification: null,
    filed_followons: null,
    needs_from_operator: null,
    resolution: null,
    updated_at: new Date(0).toISOString(),
  } as any);
}

describe('POST /api/ops-journal/:taskId/state', () => {
  it('accepts a candidate -> resolved write carrying a resolution object and persists it', async () => {
    seedEntry('task-1', 'candidate');

    const res = await request(makeApp())
      .post('/api/ops-journal/task-1/state')
      .send({
        state: 'resolved',
        resolution: { outcome: 'root-caused', filedFollowons: ['task-99'] },
      });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('resolved');
    expect(res.body.resolution).toEqual({
      outcome: 'root-caused',
      filedFollowons: ['task-99'],
    });
  });

  it('still rejects pending -> resolved', async () => {
    seedEntry('task-2', 'pending');

    const res = await request(makeApp())
      .post('/api/ops-journal/task-2/state')
      .send({ state: 'resolved' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid transition/);
  });
});
