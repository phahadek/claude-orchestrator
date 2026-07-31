/**
 * Measured (not inspected) regression guard for the GET /api/prs payload-size
 * fix. Reproduces the reported scenario — 924 terminal rows for a project,
 * ~70% of the payload being reviewResult — against a real sqlite db and a
 * real route (only GitHubClient/PRReviewService/SessionManager are stubbed),
 * then asserts the serialized response is at least an order of magnitude
 * smaller than the recorded 2,826,425-byte baseline.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const REPO = 'owner/repo';
const RECORDED_BASELINE_BYTES = 2_826_425;
const ROW_COUNT = 924;

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../routes/tasks.js', () => ({ emitTaskUpdated: vi.fn() }));
vi.mock('../audit/AuditLog.js', () => ({ recordEvent: vi.fn() }));

const projectFixture = {
  id: 'proj-1',
  name: 'claude-dashboard',
  projectDir: '/test',
  contextUrl: 'https://notion.so/ctx',
  boardId: 'board-1',
  githubRepo: REPO,
  gitMode: 'github',
  autoMergeEnabled: false,
};

vi.mock('../config.js', () => ({
  getProjectById: vi.fn((id: string) =>
    id === 'proj-1' ? projectFixture : undefined,
  ),
  getProjectByGithubRepo: vi.fn((repo: string) =>
    repo === REPO ? projectFixture : undefined,
  ),
  getAllProjects: vi.fn(() => [projectFixture]),
}));

import { db } from '../db/db.js';
import { createPrsRouter } from '../routes/prs.js';
import type { GitHubClient } from '../github/GitHubClient.js';
import type { PRReviewService } from '../github/PRReviewService.js';
import type { SessionManager } from '../session/SessionManager.js';

function makeMockGitHub(): GitHubClient {
  return {
    listOpenPRs: vi.fn().mockResolvedValue([]),
    getPRState: vi.fn().mockResolvedValue({ state: 'merged', headSha: null }),
  } as unknown as GitHubClient;
}

// ~2.1KB reviewResult, sized so 924 rows carrying it reproduces the reported
// "reviewResult is 70% of a 2.8MB payload across 924 rows" ratio.
function makeReviewResultJson(i: number): string {
  const notes = `Findings for PR #${i}: `.padEnd(400, 'x');
  return JSON.stringify({
    verdict: i % 3 === 0 ? 'needs_changes' : 'approved',
    summary: `Automated review summary for PR #${i}. `.padEnd(600, 'y'),
    dimensions: [
      { name: 'correctness', passed: true, notes },
      { name: 'tests', passed: i % 3 !== 0, notes },
      { name: 'style', passed: true, notes },
    ],
  });
}

function insertRow(i: number): void {
  const state = i === 0 ? 'open' : i % 2 === 0 ? 'merged' : 'closed';
  db.prepare(
    `
    INSERT INTO pull_requests
      (pr_number, pr_url, repo, title, state, draft, review_result, review_at,
       created_at, updated_at, synced_at)
    VALUES
      (@pr_number, @pr_url, @repo, @title, @state, 0, @review_result, @review_at,
       @created_at, @updated_at, @synced_at)
  `,
  ).run({
    pr_number: i + 1,
    pr_url: `https://github.com/${REPO}/pull/${i + 1}`,
    repo: REPO,
    title: `feat: change #${i + 1}`,
    state,
    review_result: makeReviewResultJson(i),
    review_at: '2026-01-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
    synced_at: '2026-01-01T00:00:00Z',
  });
}

beforeEach(() => {
  db.prepare('DELETE FROM pull_requests').run();
  for (let i = 0; i < ROW_COUNT; i++) insertRow(i);
});

describe('GET /api/prs — measured payload size', () => {
  it('is at least an order of magnitude smaller than the recorded 2,826,425-byte baseline', async () => {
    const app = express();
    app.use(express.json());
    const github = makeMockGitHub();
    app.use(
      '/api',
      createPrsRouter(
        github,
        {} as PRReviewService,
        {} as SessionManager,
      ),
    );

    const res = await supertest(app).get('/api/prs?projectId=proj-1');
    expect(res.status).toBe(200);

    const responseBytes = Buffer.byteLength(res.text, 'utf8');
    expect(responseBytes).toBeLessThan(RECORDED_BASELINE_BYTES / 10);

    // Sanity: the fix is what's producing the reduction, not just a smaller
    // row count — no row on the wire carries the full reviewResult object.
    for (const item of res.body as Array<Record<string, unknown>>) {
      expect(item.reviewResult).toBeUndefined();
    }
  });
});
