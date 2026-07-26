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

const app = express();
app.use(express.json());
app.use('/api', createDesignRouter());

beforeEach(() => {
  db.prepare('DELETE FROM completeness_disposition').run();
});

describe('POST /api/design/:taskId/completeness-disposition', () => {
  it('persists a disposition record and echoes it back', async () => {
    const res = await request(app)
      .post('/api/design/notion:design1/completeness-disposition')
      .send({
        project: 'demo',
        milestone: 'M12',
        questions: [
          {
            question: 'Should X be configurable?',
            disposition: 'dismissed',
            reason: 'Out of scope.',
          },
        ],
        runAt: '2026-07-20T00:00:00.000Z',
      });

    expect(res.status).toBe(201);
    expect(res.body.source_task_id).toBe('notion:design1');
    expect(res.body.questions).toEqual([
      {
        question: 'Should X be configurable?',
        disposition: 'dismissed',
        reason: 'Out of scope.',
        approvalStatus: 'proposed',
      },
    ]);
  });

  it('rejects a malformed questions array', async () => {
    const res = await request(app)
      .post('/api/design/notion:design1/completeness-disposition')
      .send({
        questions: [{ question: 'x' }],
        runAt: '2026-07-20T00:00:00.000Z',
      });

    expect(res.status).toBe(400);
  });

  it('recorded is not approved: defaults a fresh disposition to approvalStatus "proposed", and honors an explicit "approved" override', async () => {
    const defaulted = await request(app)
      .post('/api/design/notion:design2/completeness-disposition')
      .send({
        questions: [
          { question: 'Q?', disposition: 'accepted', reason: 'Resolved.' },
        ],
        runAt: '2026-07-20T00:00:00.000Z',
      });
    expect(defaulted.body.questions[0].approvalStatus).toBe('proposed');

    const overridden = await request(app)
      .post('/api/design/notion:design2/completeness-disposition')
      .send({
        questions: [
          {
            question: 'Q?',
            disposition: 'accepted',
            reason: 'Resolved.',
            approvalStatus: 'approved',
          },
        ],
        runAt: '2026-07-20T00:00:00.000Z',
      });
    expect(overridden.body.questions[0].approvalStatus).toBe('approved');
  });
});

describe('GET /api/design/:taskId/completeness-disposition', () => {
  it('reads back a persisted record for audit', async () => {
    await request(app)
      .post('/api/design/notion:design1/completeness-disposition')
      .send({
        questions: [
          {
            question: 'Q1?',
            disposition: 'accepted',
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
  });
});
