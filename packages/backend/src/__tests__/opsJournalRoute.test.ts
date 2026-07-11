import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db/db.js';
import { upsertOpsJournalEntry } from '../db/queries.js';
import { createOpsJournalRouter } from '../routes/opsJournal.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createOpsJournalRouter());
  return app;
}

function seedEntry(
  taskId: string,
  milestone: string,
  overrides: Partial<Record<string, unknown>> = {},
) {
  upsertOpsJournalEntry({
    task_id: taskId,
    project: 'polimarket-analyser',
    milestone,
    state: 'pending',
    disposition: null,
    worked_in: null,
    evidence: null,
    finding_or_proposal: null,
    falsification: null,
    filed_followons: null,
    needs_from_operator: null,
    resolution: null,
    updated_at: new Date(0).toISOString(),
    ...overrides,
  } as any);
}

beforeEach(() => {
  db.prepare('DELETE FROM ops_journal').run();
});

describe('GET /api/ops-journal', () => {
  it('returns 400 when milestone is missing', async () => {
    const res = await request(makeApp()).get('/api/ops-journal');
    expect(res.status).toBe(400);
  });

  it('returns ops_journal rows for the given milestone only', async () => {
    seedEntry('task-1', 'M12', { state: 'candidate' });
    seedEntry('task-2', 'M12', { state: 'pending' });
    seedEntry('task-3', 'M13', { state: 'resolved' });

    const res = await request(makeApp()).get('/api/ops-journal?milestone=M12');

    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(2);
    const taskIds = res.body.entries.map((e: { taskId: string }) => e.taskId);
    expect(taskIds.sort()).toEqual(['task-1', 'task-2']);
    const states = res.body.entries.map((e: { state: string }) => e.state);
    expect(states.sort()).toEqual(['candidate', 'pending']);
  });

  it('returns an empty list when no entries exist for the milestone', async () => {
    seedEntry('task-1', 'M12');
    const res = await request(makeApp()).get('/api/ops-journal?milestone=M99');
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
  });
});
