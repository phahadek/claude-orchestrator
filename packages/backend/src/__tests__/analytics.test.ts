import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const NOW = 10_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

// ── mock the db module with an in-memory SQLite instance ────────────────────
// NOTE: vi.mock factories are hoisted above all top-level statements
// (including const declarations), so NOW/DAY_MS can't be referenced here —
// literal timestamps are duplicated instead and must stay in sync with the
// module-level NOW/DAY_MS used by the test bodies below.
vi.mock('../db/db.js', async () => {
  const NOW = 10_000_000_000;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  const db = setupTestDb();

  // Two sessions on the same task (different sources/formatting of the same
  // board id) — must roll up into a single task-rollup row.
  db.prepare(
    `
    INSERT INTO sessions (session_id, project_id, task_id, status, started_at, session_type, total_input_tokens, total_output_tokens, model, task_name)
    VALUES (?, ?, ?, 'done', ?, 'standard', ?, ?, ?, ?)
  `,
  ).run(
    's1',
    'proj-a',
    'notion:task-ABC123',
    NOW - 1 * DAY_MS,
    1000,
    500,
    'claude-sonnet-4-6',
    'Task A',
  );

  db.prepare(
    `
    INSERT INTO sessions (session_id, project_id, task_id, status, started_at, session_type, total_input_tokens, total_output_tokens, model, task_name)
    VALUES (?, ?, ?, 'done', ?, 'review', ?, ?, ?, ?)
  `,
  ).run(
    's2',
    'proj-a',
    'taskabc123',
    NOW - 2 * DAY_MS,
    500,
    200,
    'claude-haiku-4-5',
    'Task A (review)',
  );

  // Different project.
  db.prepare(
    `
    INSERT INTO sessions (session_id, project_id, task_id, status, started_at, session_type, total_input_tokens, total_output_tokens, model, task_name)
    VALUES (?, ?, ?, 'done', ?, 'standard', ?, ?, ?, ?)
  `,
  ).run(
    's3',
    'proj-b',
    'notion:task-XYZ789',
    NOW - 1 * DAY_MS,
    300,
    150,
    'claude-opus-4-6',
    'Task C',
  );

  // Zero-token session, planning type.
  db.prepare(
    `
    INSERT INTO sessions (session_id, project_id, task_id, status, started_at, session_type, total_input_tokens, total_output_tokens, task_name)
    VALUES (?, ?, ?, 'done', ?, 'groom', 0, 0, ?)
  `,
  ).run(
    's4',
    'proj-a',
    'notion:task-ZERO',
    NOW - 1 * DAY_MS,
    'Zero-token task',
  );

  // Archived session — must still appear (analytics is historical).
  db.prepare(
    `
    INSERT INTO sessions (session_id, project_id, task_id, status, started_at, session_type, total_input_tokens, total_output_tokens, model, task_name, archived)
    VALUES (?, ?, ?, 'done', ?, 'standard', ?, ?, ?, ?, 1)
  `,
  ).run(
    's5',
    'proj-a',
    'notion:task-ARCH',
    NOW - 1 * DAY_MS,
    800,
    400,
    'claude-sonnet-4-6',
    'Archived task',
  );

  // Outside the default 30-day window.
  db.prepare(
    `
    INSERT INTO sessions (session_id, project_id, task_id, status, started_at, session_type, total_input_tokens, total_output_tokens, model, task_name)
    VALUES (?, ?, ?, 'done', ?, 'standard', ?, ?, ?, ?)
  `,
  ).run(
    's6',
    'proj-a',
    'notion:task-OLD',
    NOW - 90 * DAY_MS,
    900,
    100,
    'claude-sonnet-4-6',
    'Old task',
  );

  // Pre-migration row: cache columns default to 0 even though this row
  // predates cache-token capture — simulated by writing without cache values
  // (the ALTER TABLE ... DEFAULT 0 semantics), landing in the same date
  // range as a post-migration row with non-zero cache spend on a distinct task.
  db.prepare(
    `
    INSERT INTO sessions (session_id, project_id, task_id, status, started_at, session_type, total_input_tokens, total_output_tokens, model, task_name)
    VALUES (?, ?, ?, 'done', ?, 'standard', ?, ?, ?, ?)
  `,
  ).run(
    's7-pre-migration',
    'proj-a',
    'notion:task-PREMIG',
    NOW - 3 * DAY_MS,
    1000,
    500,
    'claude-sonnet-4-6',
    'Pre-migration task',
  );

  db.prepare(
    `
    INSERT INTO sessions (session_id, project_id, task_id, status, started_at, session_type, total_input_tokens, total_output_tokens, cache_read_tokens, cache_creation_tokens, model, task_name)
    VALUES (?, ?, ?, 'done', ?, 'standard', ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    's8-post-migration',
    'proj-a',
    'notion:task-POSTMIG',
    NOW - 2 * DAY_MS,
    1000,
    500,
    2000,
    3000,
    'claude-sonnet-4-6',
    'Post-migration task',
  );

  // Task with a cached Notion type — proves the rollup joins task name/type,
  // not just the bare board id.
  db.prepare(
    `
    INSERT INTO sessions (session_id, project_id, task_id, status, started_at, session_type, total_input_tokens, total_output_tokens, model, task_name)
    VALUES (?, ?, ?, 'done', ?, 'standard', ?, ?, ?, ?)
  `,
  ).run(
    's9-typed',
    'proj-a',
    'notion:task-TYPED',
    NOW - 1 * DAY_MS,
    100,
    50,
    'claude-sonnet-4-6',
    'Typed task',
  );
  db.prepare(
    `INSERT INTO task_cache (task_id, fetched_at, raw_json) VALUES (?, ?, ?)`,
  ).run(
    'notion:task-TYPED',
    NOW,
    JSON.stringify({ title: 'Typed task', type: '💻 Code' }),
  );

  return { db };
});

import { analyticsRouter } from '../routes/analytics.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/analytics', analyticsRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/analytics/tokens', () => {
  it('rolls up sessions on the same normalized task id into one task-rollup row', async () => {
    const res = await supertest(buildApp()).get(
      `/api/analytics/tokens?projectId=proj-a&from=${NOW - 10 * DAY_MS}&to=${NOW}`,
    );
    expect(res.status).toBe(200);
    const rollup = res.body.taskRollups.find(
      (r: { boardId: string }) => r.boardId === 'taskabc123',
    );
    expect(rollup).toBeDefined();
    expect(rollup.sessionCount).toBe(2);
    expect(rollup.inputTokens).toBe(1000 + 500);
    expect(rollup.outputTokens).toBe(500 + 200);
  });

  it('breaks down by session type with planning vs execution categorization', async () => {
    const res = await supertest(buildApp()).get(
      `/api/analytics/tokens?projectId=proj-a&from=${NOW - 10 * DAY_MS}&to=${NOW}`,
    );
    expect(res.status).toBe(200);
    const groom = res.body.sessionTypeBreakdown.find(
      (s: { sessionType: string }) => s.sessionType === 'groom',
    );
    expect(groom).toBeDefined();
    expect(groom.category).toBe('planning');
    const standard = res.body.sessionTypeBreakdown.find(
      (s: { sessionType: string }) => s.sessionType === 'standard',
    );
    expect(standard.category).toBe('execution');
  });

  it('bounds by project_id — excludes other projects', async () => {
    const res = await supertest(buildApp()).get(
      `/api/analytics/tokens?projectId=proj-b&from=${NOW - 10 * DAY_MS}&to=${NOW}`,
    );
    expect(res.status).toBe(200);
    const boardIds = res.body.taskRollups.map(
      (r: { boardId: string }) => r.boardId,
    );
    expect(boardIds).toEqual(['taskxyz789']);
  });

  it('defaults to a bounded date range when from/to are omitted', async () => {
    const res = await supertest(buildApp()).get(
      '/api/analytics/tokens?projectId=proj-a',
    );
    expect(res.status).toBe(200);
    expect(res.body.range.from).toBeLessThan(res.body.range.to);
    // s6 (90 days old) falls outside the default 30-day window.
    const boardIds = res.body.taskRollups.map(
      (r: { boardId: string }) => r.boardId,
    );
    expect(boardIds).not.toContain('taskold');
  });

  it('respects an explicit date range, excluding rows outside it', async () => {
    const res = await supertest(buildApp()).get(
      `/api/analytics/tokens?projectId=proj-a&from=${NOW - 100 * DAY_MS}&to=${NOW - 80 * DAY_MS}`,
    );
    expect(res.status).toBe(200);
    const boardIds = res.body.taskRollups.map(
      (r: { boardId: string }) => r.boardId,
    );
    expect(boardIds).toEqual(['taskold']);
  });

  it('includes archived sessions (analytics is historical)', async () => {
    const res = await supertest(buildApp()).get(
      `/api/analytics/tokens?projectId=proj-a&from=${NOW - 10 * DAY_MS}&to=${NOW}`,
    );
    expect(res.status).toBe(200);
    const boardIds = res.body.taskRollups.map(
      (r: { boardId: string }) => r.boardId,
    );
    expect(boardIds).toContain('taskarch');
  });

  it('returns zero cost for zero-token sessions without errors', async () => {
    const res = await supertest(buildApp()).get(
      `/api/analytics/tokens?projectId=proj-a&from=${NOW - 10 * DAY_MS}&to=${NOW}`,
    );
    expect(res.status).toBe(200);
    const zero = res.body.taskRollups.find(
      (r: { boardId: string }) => r.boardId === 'taskzero',
    );
    expect(zero).toBeDefined();
    expect(zero.inputTokens).toBe(0);
    expect(zero.totalCost).toBe(0);
  });

  it('distinguishes pre-migration cache spend (defaulted to 0) from post-migration cache spend within the same date range', async () => {
    const res = await supertest(buildApp()).get(
      `/api/analytics/tokens?projectId=proj-a&from=${NOW - 10 * DAY_MS}&to=${NOW}`,
    );
    expect(res.status).toBe(200);
    const preMigration = res.body.taskRollups.find(
      (r: { boardId: string }) => r.boardId === 'taskpremig',
    );
    const postMigration = res.body.taskRollups.find(
      (r: { boardId: string }) => r.boardId === 'taskpostmig',
    );
    expect(preMigration).toBeDefined();
    expect(postMigration).toBeDefined();
    expect(preMigration.cacheReadTokens).toBe(0);
    expect(preMigration.cacheCreationTokens).toBe(0);
    expect(postMigration.cacheReadTokens).toBe(2000);
    expect(postMigration.cacheCreationTokens).toBe(3000);
    // Same input/output tokens on both, but post-migration costs more because
    // of its cache spend — proving cache tokens are actually priced in.
    expect(postMigration.totalCost).toBeGreaterThan(preMigration.totalCost);
  });

  it('includes task name and type per rollup row, joined from the task cache', async () => {
    const res = await supertest(buildApp()).get(
      `/api/analytics/tokens?projectId=proj-a&from=${NOW - 10 * DAY_MS}&to=${NOW}`,
    );
    expect(res.status).toBe(200);
    const typed = res.body.taskRollups.find(
      (r: { boardId: string }) => r.boardId === 'tasktyped',
    );
    expect(typed).toBeDefined();
    expect(typed.taskName).toBe('Typed task');
    expect(typed.taskType).toBe('💻 Code');
  });

  it('sums totals in SQL rather than fetching unbounded rows', async () => {
    const res = await supertest(buildApp()).get(
      `/api/analytics/tokens?projectId=proj-a&from=${NOW - 10 * DAY_MS}&to=${NOW}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.sessions).toBeUndefined();
    expect(typeof res.body.totals.totalCost).toBe('number');
    expect(res.body.totals.sessionCount).toBeGreaterThan(0);
  });
});
