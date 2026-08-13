/**
 * Tests for packages/backend/src/routes/reportState.ts — the
 * investigation_report REST surface. Routes are a thin parse/translate
 * layer over reportService, so these tests mock reportService and assert
 * on request validation + status-code translation, mirroring
 * routes/__tests__/gateState.reject.test.ts's convention.
 *
 * AC: POST create rejects a request missing required core fields; commit
 * enforces milestone_id set + draft-only; abandon works from any
 * non-terminal state; list/get support project/milestone/state filters and
 * surface derived inFlight/resolveEligible fields.
 */

import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const reportServiceMock = vi.hoisted(() => ({
  createReport: vi.fn(),
  updateDraftReport: vi.fn(),
  commitReport: vi.fn(),
  abandonReport: vi.fn(),
  getReportWithDerived: vi.fn(),
  listReports: vi.fn(),
}));

vi.mock('../../investigation/reportService.js', () => reportServiceMock);

import { createReportStateRouter } from '../reportState.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createReportStateRouter());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/reports', () => {
  it('creates a draft report when all required core fields are present', async () => {
    const created = { id: 'r-1', state: 'draft' };
    reportServiceMock.createReport.mockReturnValue(created);

    const res = await request(makeApp())
      .post('/api/reports')
      .send({
        projectId: 'proj-1',
        title: 'symptom title',
        symptomText: 'things are broken',
      });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(created);
    expect(reportServiceMock.createReport).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-1',
        title: 'symptom title',
        symptomText: 'things are broken',
      }),
    );
  });

  it('rejects with 400 when the service rejects a missing required field', async () => {
    reportServiceMock.createReport.mockImplementation(() => {
      throw new Error('title is required');
    });

    const res = await request(makeApp())
      .post('/api/reports')
      .send({ projectId: 'proj-1', symptomText: 'oops' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title is required/);
  });

  it('rejects with 400 when projectId is missing entirely', async () => {
    reportServiceMock.createReport.mockImplementation(() => {
      throw new Error('projectId is required');
    });

    const res = await request(makeApp())
      .post('/api/reports')
      .send({ title: 't', symptomText: 's' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/projectId is required/);
  });
});

describe('POST /api/reports/:id/commit', () => {
  it('commits a draft report with milestone_id set', async () => {
    const committed = { id: 'r-1', state: 'committed' };
    reportServiceMock.commitReport.mockReturnValue(committed);

    const res = await request(makeApp()).post('/api/reports/r-1/commit');

    expect(reportServiceMock.commitReport).toHaveBeenCalledWith('r-1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(committed);
  });

  it('400s when the service rejects a commit missing milestone_id', async () => {
    reportServiceMock.commitReport.mockImplementation(() => {
      throw new Error(
        'investigation report r-1 has no milestone_id set — required to commit',
      );
    });

    const res = await request(makeApp()).post('/api/reports/r-1/commit');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no milestone_id set/);
  });

  it('400s when the service rejects committing a report already past draft', async () => {
    reportServiceMock.commitReport.mockImplementation(() => {
      throw new Error(
        'investigation report r-1 is committed, not draft — cannot commit',
      );
    });

    const res = await request(makeApp()).post('/api/reports/r-1/commit');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not draft/);
  });
});

describe('POST /api/reports/:id/abandon', () => {
  it('abandons a draft report', async () => {
    const abandoned = { id: 'r-1', state: 'abandoned' };
    reportServiceMock.abandonReport.mockReturnValue(abandoned);

    const res = await request(makeApp()).post('/api/reports/r-1/abandon');

    expect(reportServiceMock.abandonReport).toHaveBeenCalledWith('r-1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(abandoned);
  });

  it('abandons a committed (non-terminal) report', async () => {
    const abandoned = { id: 'r-2', state: 'abandoned' };
    reportServiceMock.abandonReport.mockReturnValue(abandoned);

    const res = await request(makeApp()).post('/api/reports/r-2/abandon');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(abandoned);
  });

  it('400s when the service rejects abandoning an already-terminal report', async () => {
    reportServiceMock.abandonReport.mockImplementation(() => {
      throw new Error('investigation report r-3 is already resolved — cannot abandon');
    });

    const res = await request(makeApp()).post('/api/reports/r-3/abandon');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already resolved/);
  });
});

describe('GET /api/reports', () => {
  it('forwards project/milestone/state filters and returns derived fields', async () => {
    const result = {
      items: [
        {
          id: 'r-1',
          state: 'committed',
          inFlight: true,
          resolveEligible: false,
        },
      ],
      total: 1,
      page: 1,
    };
    reportServiceMock.listReports.mockReturnValue(result);

    const res = await request(makeApp()).get(
      '/api/reports?project=proj-1&milestone=m-1&state=committed&page=2&limit=10',
    );

    expect(reportServiceMock.listReports).toHaveBeenCalledWith({
      project: 'proj-1',
      milestone: 'm-1',
      state: 'committed',
      page: 2,
      limit: 10,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(result);
    expect(res.body.items[0].inFlight).toBe(true);
    expect(res.body.items[0].resolveEligible).toBe(false);
  });
});

describe('GET /api/reports/:id', () => {
  it('returns 404 when the report does not exist', async () => {
    reportServiceMock.getReportWithDerived.mockReturnValue(undefined);

    const res = await request(makeApp()).get('/api/reports/missing');

    expect(res.status).toBe(404);
  });

  it('returns the report with its derived inFlight/resolveEligible fields', async () => {
    const report = {
      id: 'r-1',
      state: 'draft',
      inFlight: false,
      resolveEligible: false,
    };
    reportServiceMock.getReportWithDerived.mockReturnValue(report);

    const res = await request(makeApp()).get('/api/reports/r-1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(report);
  });
});
