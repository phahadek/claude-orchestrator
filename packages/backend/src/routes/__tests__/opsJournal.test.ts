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

vi.mock('../../projects/ProjectService', () => ({
  ProjectService: {
    getById: () => ({
      id: 'polimarket-analyser',
      milestones: [{ id: 'ms-12', name: 'M12', canonicalShortId: 'M12' }],
    }),
  },
}));

import { db } from '../../db/db.js';
import { createOpsJournalRouter } from '../opsJournal.js';
import { normalizeTaskId } from '../../tasks/taskId.js';
import { upsertOpsJournalEntry, upsertTaskCache } from '../../db/queries.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createOpsJournalRouter());
  return app;
}

beforeEach(() => {
  db.prepare('DELETE FROM ops_journal').run();
  db.prepare('DELETE FROM staged_intent').run();
});

function activeJournalMirrors(taskId: string) {
  return db
    .prepare(
      `SELECT * FROM staged_intent WHERE task_id = ? AND kind = 'journal.setState' AND state IN ('staged', 'approved')`,
    )
    .all(taskId) as Array<{ decision_proposal: string; payload: string }>;
}

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

describe('GET /api/ops-journal', () => {
  function seedMs12(taskId: string) {
    seedEntry(taskId);
    db.prepare('UPDATE ops_journal SET milestone = ? WHERE task_id = ?').run(
      'ms-12',
      taskId,
    );
  }

  it('resolves a canonical name with project to the same entries as the row id', async () => {
    seedMs12('task-g1');

    const byName = await request(makeApp()).get(
      '/api/ops-journal?milestone=M12&project=polimarket-analyser',
    );
    const byId = await request(makeApp()).get(
      '/api/ops-journal?milestone=ms-12',
    );
    expect(byName.status).toBe(200);
    expect(byName.body.entries).toHaveLength(1);
    expect(byName.body).toEqual(byId.body);
  });

  it('returns 404, not an empty 200, for an unknown milestone ref', async () => {
    const res = await request(makeApp()).get(
      '/api/ops-journal?milestone=M99&project=polimarket-analyser',
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/M99/);
  });
});

describe('POST /api/ops-journal/:taskId/state', () => {
  it('accepts a candidate -> resolved write carrying a resolution object and persists it', async () => {
    seedEntry('task-1', 'candidate');

    const res = await request(makeApp())
      .post('/api/ops-journal/task-1/state')
      .send({
        state: 'resolved',
        noChangeReason: 'investigation only',
        resolution: { outcome: 'root-caused', filedFollowons: ['task-99'] },
      });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('resolved');
    expect(res.body.resolution).toEqual({
      outcome: 'root-caused',
      filedFollowons: ['task-99'],
    });
  });

  it('rejects pending -> resolved for an Operational task', async () => {
    seedEntry('task-2', 'pending');
    upsertTaskCache(
      normalizeTaskId('task-2'),
      JSON.stringify({ type: '🔧 Operational' }),
    );

    const res = await request(makeApp())
      .post('/api/ops-journal/task-2/state')
      .send({ state: 'resolved', noChangeReason: 'x' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid transition/);
  });

  it('accepts pending -> resolved for an Investigation task', async () => {
    seedEntry('task-2b', 'pending');
    upsertTaskCache(
      normalizeTaskId('task-2b'),
      JSON.stringify({ type: '🔎 Investigation' }),
    );

    const res = await request(makeApp())
      .post('/api/ops-journal/task-2b/state')
      .send({ state: 'resolved' });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('resolved');
  });

  it('rejects an Operational candidate -> resolved without reconciliation or noChangeReason, accepts with either', async () => {
    seedEntry('task-2c', 'candidate');
    upsertTaskCache(
      normalizeTaskId('task-2c'),
      JSON.stringify({ type: '🔧 Operational' }),
    );

    const bad = await request(makeApp())
      .post('/api/ops-journal/task-2c/state')
      .send({ state: 'resolved' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/reconciliation/);
    expect(bad.body.error).toMatch(/noChangeReason/);

    const ok = await request(makeApp())
      .post('/api/ops-journal/task-2c/state')
      .send({ state: 'resolved', noChangeReason: 'nothing to change' });
    expect(ok.status).toBe(200);
  });

  it('mirrors a candidate -> staged-proposal write to exactly one decision, carrying the finding', async () => {
    seedEntry('task-3', 'candidate');

    const res = await request(makeApp())
      .post('/api/ops-journal/task-3/state')
      .send({
        state: 'staged-proposal',
        findingOrProposal: { summary: 'root cause is X' },
      });

    expect(res.status).toBe(200);
    const mirrors = activeJournalMirrors('task-3');
    expect(mirrors).toHaveLength(1);
    expect(JSON.parse(mirrors[0].payload).fields.findingOrProposal).toEqual({
      summary: 'root cause is X',
    });
  });

  it('re-transitioning into staged-proposal still yields exactly one mirrored decision', async () => {
    seedEntry('task-4', 'candidate');

    await request(makeApp())
      .post('/api/ops-journal/task-4/state')
      .send({ state: 'staged-proposal' });
    await request(makeApp())
      .post('/api/ops-journal/task-4/state')
      .send({ state: 'staged-proposal', evidence: { note: 'more context' } });

    expect(activeJournalMirrors('task-4')).toHaveLength(1);
  });
});
