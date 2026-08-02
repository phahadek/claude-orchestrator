/**
 * Tests for the /design route (packages/backend/src/routes/design.ts) — the
 * thin write-through for the completeness-disposition durable store and the
 * advisory trace-coverage signal. AC: a disposition persists and reads back,
 * and the trace-coverage signal is returned as a flag, never an error.
 */

import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import { createDesignRouter } from '../design';
import { upsertTaskCache } from '../../db/queries';

const app = express();
app.use(express.json());
app.use('/api', createDesignRouter());

const PROBED = ['unstated-premises'];

beforeEach(() => {
  db.prepare('DELETE FROM completeness_disposition').run();
  db.prepare('DELETE FROM task_cache').run();
  for (const taskId of [
    'notion:design1',
    'notion:design2',
    'notion:design3',
    'notion:design4',
  ]) {
    upsertTaskCache(taskId, JSON.stringify({ type: '📐 Design' }));
  }
});

describe('POST /api/design/:taskId/completeness-disposition', () => {
  it('persists a disposition record and echoes it back', async () => {
    const res = await request(app)
      .post('/api/design/notion:design1/completeness-disposition')
      .send({
        project: 'demo',
        milestone: 'M12',
        probed: PROBED,
        questions: [
          {
            question: 'Should X be configurable?',
            disposition: 'out-of-scope',
            reason: 'Out of scope.',
          },
        ],
        runAt: '2026-07-20T00:00:00.000Z',
      });

    expect(res.status).toBe(201);
    expect(res.body.source_task_id).toBe('notion:design1');
    expect(res.body.probed).toEqual(PROBED);
    expect(res.body.questions).toEqual([
      {
        question: 'Should X be configurable?',
        disposition: 'out-of-scope',
        reason: 'Out of scope.',
        approvalStatus: 'proposed',
      },
    ]);
  });

  it('rejects a malformed questions array', async () => {
    const res = await request(app)
      .post('/api/design/notion:design1/completeness-disposition')
      .send({
        probed: PROBED,
        questions: [{ question: 'x' }],
        runAt: '2026-07-20T00:00:00.000Z',
      });

    expect(res.status).toBe(400);
  });

  it('rejects a question carrying a legacy accepted/dismissed value instead of a named disposition', async () => {
    const res = await request(app)
      .post('/api/design/notion:design1/completeness-disposition')
      .send({
        probed: PROBED,
        questions: [
          { question: 'Q?', disposition: 'accepted', reason: 'Resolved.' },
        ],
        runAt: '2026-07-20T00:00:00.000Z',
      });

    expect(res.status).toBe(400);
  });

  it('rejects an empty probed array — a clean pass must still name what it checked', async () => {
    const res = await request(app)
      .post('/api/design/notion:design1/completeness-disposition')
      .send({
        probed: [],
        questions: [],
        runAt: '2026-07-20T00:00:00.000Z',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/probed/);
  });

  it('records a clean pass as an affirmative statement of what was probed, not an empty questions array alone', async () => {
    const res = await request(app)
      .post('/api/design/notion:design1/completeness-disposition')
      .send({
        probed: [
          'durability-failure-modes',
          'dual-read-consumer-set',
          'interaction-bugs',
          'missing-scaffolding',
          'state-mutation-granularity',
          'unstated-premises',
        ],
        questions: [],
        runAt: '2026-07-20T00:00:00.000Z',
      });

    expect(res.status).toBe(201);
    expect(res.body.probed).toHaveLength(6);
    expect(res.body.questions).toEqual([]);
  });

  it('rejects a malformed/non-timestamp runAt', async () => {
    const res = await request(app)
      .post('/api/design/notion:design1/completeness-disposition')
      .send({
        probed: PROBED,
        questions: [],
        runAt: 'not-a-timestamp',
      });

    expect(res.status).toBe(400);
  });

  it('rejects a task id that does not resolve, and writes no row', async () => {
    const res = await request(app)
      .post('/api/design/notion:does-not-exist/completeness-disposition')
      .send({
        probed: PROBED,
        questions: [],
        runAt: '2026-07-20T00:00:00.000Z',
      });

    expect(res.status).toBe(400);

    const rows = db
      .prepare('SELECT * FROM completeness_disposition')
      .all() as unknown[];
    expect(rows).toHaveLength(0);
  });

  it('recorded is not approved: defaults a fresh disposition to approvalStatus "proposed", and honors an explicit "approved" override', async () => {
    const defaulted = await request(app)
      .post('/api/design/notion:design2/completeness-disposition')
      .send({
        probed: PROBED,
        questions: [
          { question: 'Q?', disposition: 'resolved', reason: 'Resolved.' },
        ],
        runAt: '2026-07-20T00:00:00.000Z',
      });
    expect(defaulted.body.questions[0].approvalStatus).toBe('proposed');

    const overridden = await request(app)
      .post('/api/design/notion:design2/completeness-disposition')
      .send({
        probed: PROBED,
        questions: [
          {
            question: 'Q?',
            disposition: 'resolved',
            reason: 'Resolved.',
            approvalStatus: 'approved',
          },
        ],
        runAt: '2026-07-20T00:00:00.000Z',
      });
    expect(overridden.body.questions[0].approvalStatus).toBe('approved');
  });
});

describe('POST /api/design/:taskId/completeness-disposition — row-shape parity with the completeness.disposition MCP tool', () => {
  it('normalizes a date-only runAt to a full ISO timestamp, mirroring buildCompletenessDispositionRow', async () => {
    const res = await request(app)
      .post('/api/design/notion:design3/completeness-disposition')
      .send({
        probed: PROBED,
        questions: [
          { question: 'Q?', disposition: 'resolved', reason: 'Resolved.' },
        ],
        runAt: '2026-07-20',
      });

    expect(res.status).toBe(201);
    expect(res.body.run_at).toBe('2026-07-20T00:00:00.000Z');
  });

  it('accepts an explicit "rejected" approvalStatus override', async () => {
    const res = await request(app)
      .post('/api/design/notion:design4/completeness-disposition')
      .send({
        probed: PROBED,
        questions: [
          {
            question: 'Q?',
            disposition: 'resolved',
            reason: 'Resolved.',
            approvalStatus: 'rejected',
          },
        ],
        runAt: '2026-07-20T00:00:00.000Z',
      });

    expect(res.status).toBe(201);
    expect(res.body.questions[0].approvalStatus).toBe('rejected');
  });

  it('round-trips each of the six named dispositions', async () => {
    const named = [
      'resolved',
      'out-of-scope',
      'not-a-decision',
      'fold',
      'file-sibling',
      'sibling-owned',
    ] as const;
    for (const disposition of named) {
      const res = await request(app)
        .post('/api/design/notion:design4/completeness-disposition')
        .send({
          probed: PROBED,
          questions: [{ question: 'Q?', disposition, reason: 'r' }],
          runAt: '2026-07-20T00:00:00.000Z',
        });
      expect(res.status).toBe(201);
      expect(res.body.questions[0].disposition).toBe(disposition);
    }
  });
});

describe('GET /api/design/:taskId/completeness-disposition', () => {
  it('reads back a persisted record for audit', async () => {
    await request(app)
      .post('/api/design/notion:design1/completeness-disposition')
      .send({
        probed: PROBED,
        questions: [
          {
            question: 'Q1?',
            disposition: 'resolved',
            reason: 'Filed as follow-on.',
          },
        ],
        runAt: '2026-07-20T00:00:00.000Z',
      });

    const res = await request(app).get(
      '/api/design/notion:design1/completeness-disposition',
    );
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs[0].source_task_id).toBe('notion:design1');
    expect(res.body.runs[0].probed).toEqual(PROBED);
  });
});

describe('POST /api/design/:taskId/trace-coverage', () => {
  const worklistOptions = {
    sourceRoot: 'packages/backend/src',
    packages: ['billing'],
    areaAliases: {},
    trackedFiles: ['packages/backend/src/billing/invoice.ts'],
  };

  it('returns an advisory flag for an output with no locked decision, never a 4xx/5xx', async () => {
    const res = await request(app)
      .post('/api/design/notion:design1/trace-coverage')
      .send({
        acceptanceCriteria: [],
        lockedDecisions: [],
        followOnTasks: [
          {
            id: 'notion:code1',
            title: 'Rework invoice export',
            filesSection: '`packages/backend/src/billing/invoice.ts`',
            rawMarkdown: 'touch packages/backend/src/billing/invoice.ts',
          },
        ],
        worklistOptions,
      });

    expect(res.status).toBe(200);
    expect(res.body.advisory).toBe(true);
    expect(res.body.flags.length).toBeGreaterThan(0);
    expect(
      res.body.flags.some((f: { kind: string }) => f.kind === 'region'),
    ).toBe(true);
  });

  it('returns an advisory flag for an unlocked acceptance criterion with no follow-on tasks', async () => {
    const res = await request(app)
      .post('/api/design/notion:design1/trace-coverage')
      .send({
        acceptanceCriteria: ['Invoices export as CSV'],
        lockedDecisions: [],
        followOnTasks: [],
        worklistOptions,
      });

    expect(res.status).toBe(200);
    expect(res.body.advisory).toBe(true);
    expect(
      res.body.flags.some(
        (f: { kind: string }) => f.kind === 'acceptance_criterion',
      ),
    ).toBe(true);
  });

  it('returns 400 when worklistOptions omits trackedFiles', async () => {
    const { trackedFiles: _trackedFiles, ...rest } = worklistOptions;
    const res = await request(app)
      .post('/api/design/notion:design1/trace-coverage')
      .send({
        acceptanceCriteria: [],
        lockedDecisions: [],
        followOnTasks: [],
        worklistOptions: rest,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/trackedFiles/);
  });

  it('returns 400 when worklistOptions.trackedFiles is not an array of strings', async () => {
    const res = await request(app)
      .post('/api/design/notion:design1/trace-coverage')
      .send({
        acceptanceCriteria: [],
        lockedDecisions: [],
        followOnTasks: [],
        worklistOptions: { ...worklistOptions, trackedFiles: 'not-an-array' },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/trackedFiles/);
  });
});
