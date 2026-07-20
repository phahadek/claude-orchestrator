import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockLoadDesignContext } = vi.hoisted(() => ({
  mockLoadDesignContext: vi.fn(),
}));

vi.mock('../design/designLoad.js', () => ({
  loadDesignContext: mockLoadDesignContext,
}));

import { createDesignContextRouter } from '../routes/designContext.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createDesignContextRouter());
  return app;
}

beforeEach(() => {
  mockLoadDesignContext.mockReset();
});

describe('GET /api/design-context', () => {
  it('returns 400 when milestone is missing', async () => {
    const res = await request(makeApp()).get('/api/design-context?task=t1');
    expect(res.status).toBe(400);
  });

  it('returns 400 when task is missing', async () => {
    const res = await request(makeApp()).get(
      '/api/design-context?milestone=m1',
    );
    expect(res.status).toBe(400);
  });

  it('returns the design digest', async () => {
    const digest = {
      task: {
        id: 't1',
        title: 'Design the widget',
        status: '🗂️ Ready',
        type: '📐 Design',
        url: 'https://notion.so/t1',
      },
      markdown: '## Open questions\n- A or B?',
      openQuestions: { items: ['A or B?'], source: 'explicit_heading' },
      archUnits: [],
      unresolvedPageRefs: [],
      codeMapGrounding: {},
    };
    mockLoadDesignContext.mockResolvedValue(digest);

    const res = await request(makeApp()).get(
      '/api/design-context?milestone=m1&task=t1&project=p1',
    );

    expect(res.status).toBe(200);
    expect(mockLoadDesignContext).toHaveBeenCalledWith('m1', 't1', {
      project: 'p1',
    });
    expect(res.body).toEqual(digest);
  });

  it('returns 500 when the loader throws', async () => {
    mockLoadDesignContext.mockRejectedValue(new Error('unknown milestone'));
    const res = await request(makeApp()).get(
      '/api/design-context?milestone=m1&task=t1',
    );
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('unknown milestone');
  });
});
