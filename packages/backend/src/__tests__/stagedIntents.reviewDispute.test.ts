/**
 * review.dispute — a code session's route out of a needs_changes/incomplete
 * PR review verdict it concludes is wrong. Covers the acceptance criteria
 * from the "code session disputes a verdict" task: refused with no
 * outstanding blocking verdict, staged when one exists, approval clears the
 * verdict without a new head SHA and lets the PR proceed, and pushback
 * resumes the authoring session for a revision turn.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { EventEmitter } from 'events';

const { mockRecordEvent } = vi.hoisted(() => ({
  mockRecordEvent: vi.fn(),
}));

vi.mock('../audit/AuditLog', () => ({
  recordEvent: mockRecordEvent,
}));

vi.mock('../db/db', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db/db';
import {
  insertSession,
  insertStagedIntent,
  getPRByNumber,
} from '../db/queries';
import type { StagedIntentRow } from '../db/types';
import {
  createStagedIntentsRouter,
  setStagedIntentBroadcast,
  stageIntent,
} from '../routes/stagedIntents';
import type { SessionManager } from '../session/SessionManager';
import type { PRReviewService } from '../github/PRReviewService';

const NOW = '2024-01-01T00:00:00Z';
const SESSION_ID = 'session-review-dispute';

function insertPR(opts: {
  pr_number: number;
  task_id?: string | null;
  session_id?: string | null;
  review_result?: string | null;
}): void {
  db.prepare(
    `
    INSERT INTO pull_requests
      (pr_number, pr_url, task_id, session_id, repo, state,
       review_result, created_at, updated_at, synced_at)
    VALUES
      (@pr_number, @pr_url, @task_id, @session_id, 'owner/repo', 'open',
       @review_result, @created_at, @updated_at, @synced_at)
  `,
  ).run({
    pr_number: opts.pr_number,
    pr_url: `https://github.com/owner/repo/pull/${opts.pr_number}`,
    task_id: opts.task_id ?? null,
    session_id: opts.session_id ?? null,
    review_result: opts.review_result ?? null,
    created_at: NOW,
    updated_at: NOW,
    synced_at: NOW,
  });
}

function insertAuthoringSession(taskId: string): void {
  insertSession({
    session_id: SESSION_ID,
    task_id: taskId,
    task_url: 'https://notion.so/task-1',
    project_context_url: 'https://notion.so/ctx',
    status: 'idle',
    started_at: Date.now(),
    session_type: 'standard',
  });
}

function makeSessionManager(): SessionManager & EventEmitter {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    enqueueFeedback: vi.fn().mockResolvedValue(undefined),
    getLiveSession: vi.fn().mockReturnValue(undefined),
  }) as unknown as SessionManager & EventEmitter;
}

function makePRReviewService(): PRReviewService {
  return {
    handleApprovedVerdict: vi.fn().mockResolvedValue(true),
  } as unknown as PRReviewService;
}

beforeEach(() => {
  mockRecordEvent.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM pull_requests').run();
  db.prepare('DELETE FROM sessions').run();
  setStagedIntentBroadcast(() => {});
});

describe('review.dispute — stage-time validation', () => {
  it('refuses staging when the PR has no outstanding blocking verdict', () => {
    insertAuthoringSession('task-1');
    insertPR({
      pr_number: 42,
      task_id: 'task-1',
      review_result: JSON.stringify({ verdict: 'approved' }),
    });

    expect(() =>
      stageIntent(
        'review.dispute',
        { taskId: 'task-1', prNumber: 42, repo: 'owner/repo', rationale: 'the file is already green on dev' },
        'proj-1',
        null,
        SESSION_ID,
        'Reviewer objection rested on a stale claim in the task spec.',
      ),
    ).toThrow(/no outstanding blocking verdict/);
  });

  it('refuses staging when the PR is not found', () => {
    insertAuthoringSession('task-1');

    expect(() =>
      stageIntent(
        'review.dispute',
        { taskId: 'task-1', prNumber: 999, repo: 'owner/repo', rationale: 'evidence' },
        'proj-1',
        null,
        SESSION_ID,
        'substantive rationale',
      ),
    ).toThrow(/was not found/);
  });

  it('refuses a groupId', () => {
    insertAuthoringSession('task-1');
    insertPR({
      pr_number: 42,
      task_id: 'task-1',
      review_result: JSON.stringify({ verdict: 'needs_changes' }),
    });

    expect(() =>
      stageIntent(
        'review.dispute',
        { taskId: 'task-1', prNumber: 42, repo: 'owner/repo', rationale: 'evidence' },
        'proj-1',
        'some-group',
        SESSION_ID,
        'substantive rationale',
      ),
    ).toThrow(/cannot belong to a group/);
  });

  it('stages successfully when the PR carries a needs_changes verdict', () => {
    insertAuthoringSession('task-1');
    insertPR({
      pr_number: 42,
      task_id: 'task-1',
      review_result: JSON.stringify({ verdict: 'needs_changes' }),
    });

    const intent = stageIntent(
      'review.dispute',
      {
        taskId: 'task-1',
        prNumber: 42,
        repo: 'owner/repo',
        rationale: 'All 7 target files pass — 302 tests. No code change needed.',
      },
      'proj-1',
      null,
      SESSION_ID,
      'The reviewer objection rested on a stale claim; verified green on current base.',
    );

    expect(intent.kind).toBe('review.dispute');
    expect(intent.state).toBe('staged');
  });
});

describe('review.dispute — disposition', () => {
  let counter = 0;
  function stageRow(overrides: Partial<StagedIntentRow> = {}): StagedIntentRow {
    counter += 1;
    const now = Date.now();
    const row: StagedIntentRow = {
      id: `intent-${counter}`,
      kind: 'review.dispute',
      payload: JSON.stringify({
        taskId: 'task-1',
        prNumber: 42,
        repo: 'owner/repo',
        rationale: 'All 7 target files pass — 302 tests.',
      }),
      payload_hash: `hash-${counter}`,
      task_id: 'task-1',
      project_id: 'proj-1',
      session_id: SESSION_ID,
      group_id: null,
      milestone: null,
      state: 'staged',
      supersedes: null,
      annotation: null,
      decision_proposal: 'evidence',
      groom_proposal: null,
      advisory: null,
      disposition_reason: null,
      answer: null,
      created_at: now,
      updated_at: now,
      ...overrides,
    };
    insertStagedIntent(row);
    return row;
  }

  it('approving clears the blocking verdict without a new head SHA and lets the PR proceed', async () => {
    insertAuthoringSession('task-1');
    insertPR({
      pr_number: 42,
      task_id: 'task-1',
      review_result: JSON.stringify({
        verdict: 'needs_changes',
        dimensions: [{ name: 'Diff vs Acceptance Criteria', passed: false, notes: 'stale claim' }],
      }),
    });
    const staged = stageRow();

    const sessionManager = makeSessionManager();
    const prReviewService = makePRReviewService();
    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createStagedIntentsRouter(undefined, sessionManager, prReviewService),
    );
    const agent = supertest(app);

    const res = await agent.post(`/api/staged-intents/${staged.id}/approve`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('committed');

    const pr = getPRByNumber(42, 'owner/repo');
    const result = JSON.parse(pr!.review_result!);
    expect(result.verdict).toBe('approved');

    expect(prReviewService.handleApprovedVerdict).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'task-1',
      'proj-1',
    );
  });

  it('pushing back resumes the authoring session for a revision turn and does not clear the verdict', async () => {
    insertAuthoringSession('task-1');
    insertPR({
      pr_number: 42,
      task_id: 'task-1',
      review_result: JSON.stringify({ verdict: 'needs_changes' }),
    });
    const staged = stageRow();

    const sessionManager = makeSessionManager();
    const app = express();
    app.use(express.json());
    app.use('/api', createStagedIntentsRouter(undefined, sessionManager));
    const agent = supertest(app);

    const res = await agent
      .post(`/api/staged-intents/${staged.id}/reject`)
      .send({ outcome: 'pushback', reason: 'The task spec was current when authored; verify again.' });
    expect(res.status).toBe(200);

    expect(sessionManager.enqueueFeedback).toHaveBeenCalledWith(
      SESSION_ID,
      'operator-disposition',
      expect.stringContaining('not upheld'),
      { attemptTerminalResume: false },
    );

    const pr = getPRByNumber(42, 'owner/repo');
    const result = JSON.parse(pr!.review_result!);
    expect(result.verdict).toBe('needs_changes');
  });

  it('apply is refused — approval is the sole terminal action', async () => {
    insertAuthoringSession('task-1');
    insertPR({
      pr_number: 42,
      task_id: 'task-1',
      review_result: JSON.stringify({ verdict: 'needs_changes' }),
    });
    const staged = stageRow();

    const app = express();
    app.use(express.json());
    app.use('/api', createStagedIntentsRouter());
    const agent = supertest(app);

    const res = await agent.post(`/api/staged-intents/${staged.id}/apply`);
    expect(res.status).toBe(409);
  });
});
