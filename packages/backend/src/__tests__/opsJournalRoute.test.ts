import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

const mockUpdateStatus = vi.fn(async () => {});
const mockFetchTaskSummary = vi.fn(async () => null as { status: string } | null);

vi.mock('../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn(() => ({
    type: 'notion',
    fetchReadyTasks: vi.fn(async () => []),
    attachPR: vi.fn(async () => {}),
    updateStatus: mockUpdateStatus,
    fetchTaskPage: vi.fn(async () => ''),
    fetchTaskSummary: mockFetchTaskSummary,
    fetchNonMilestoneReadyTasks: vi.fn(async () => []),
    updateNotes: vi.fn(async () => {}),
    appendImplementationNote: vi.fn(async () => {}),
    listTasksByStatus: vi.fn(async () => []),
  })),
}));

import { db } from '../db/db.js';
import {
  upsertOpsJournalEntry,
  listStagedIntentsBySession,
  listStagedIntentsByProject,
  insertSession,
  insertStagedIntent,
  setSessionTerminalCompletionReason,
} from '../db/queries.js';
import { createOpsJournalRouter } from '../routes/opsJournal.js';
import { DESIGN_DONE_STATUS } from '../orchestration/PlanningOrchestrator.js';

function seedOpsSession(
  sessionId: string,
  taskId: string,
  reason: string,
  overrides: Partial<{ projectId: string }> = {},
) {
  insertSession({
    session_id: sessionId,
    task_id: taskId,
    task_url: null,
    project_context_url: null,
    project_id: overrides.projectId ?? 'polimarket-analyser',
    status: 'done',
    started_at: 0,
    ended_at: 0,
    session_type: 'ops',
  } as any);
  setSessionTerminalCompletionReason(sessionId, reason);
}

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
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM sessions').run();
  mockUpdateStatus.mockClear();
  mockFetchTaskSummary.mockClear();
  mockFetchTaskSummary.mockResolvedValue(null);
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

describe('POST /api/ops-journal/:taskId/state', () => {
  it('returns 400 when state is missing', async () => {
    seedEntry('task-1', 'M12', { state: 'pending' });
    const res = await request(makeApp())
      .post('/api/ops-journal/task-1/state')
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 404 when the task has no journal entry', async () => {
    const res = await request(makeApp())
      .post('/api/ops-journal/unknown-task/state')
      .send({ state: 'candidate' });
    expect(res.status).toBe(404);
  });

  it('writes via setEntryState on a valid transition', async () => {
    seedEntry('task-1', 'M12', { state: 'pending' });
    const res = await request(makeApp())
      .post('/api/ops-journal/task-1/state')
      .send({ state: 'candidate' });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('candidate');

    const getRes = await request(makeApp()).get(
      '/api/ops-journal?milestone=M12',
    );
    expect(getRes.body.entries[0].state).toBe('candidate');
  });

  it('rejects an invalid transition', async () => {
    seedEntry('task-1', 'M12', { state: 'pending' });
    const res = await request(makeApp())
      .post('/api/ops-journal/task-1/state')
      .send({ state: 'resolved' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid transition/);

    const getRes = await request(makeApp()).get(
      '/api/ops-journal?milestone=M12',
    );
    expect(getRes.body.entries[0].state).toBe('pending');
  });

  it('carries optional resolution and disposition fields', async () => {
    seedEntry('task-1', 'M12', { state: 'applied-pending-confirm' });
    const res = await request(makeApp())
      .post('/api/ops-journal/task-1/state')
      .send({
        state: 'resolved',
        disposition: 'pass',
        resolution: { note: 'looks good' },
      });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('resolved');
    expect(res.body.disposition).toBe('pass');
    expect(res.body.resolution).toEqual({ note: 'looks good' });
  });

  it('transitioning into staged-proposal also stages a journal.setState staged_intent, so the decision renders on the decision surface', async () => {
    seedEntry('task-1', 'M12', { state: 'pending' });
    await request(makeApp())
      .post('/api/ops-journal/task-1/state')
      .send({
        state: 'candidate',
        findingOrProposal: { summary: 'Stand up off-box backups' },
      });

    // No decision surfaced yet — investigation bookkeeping only.
    expect(listStagedIntentsBySession('n/a')).toEqual([]);

    const res = await request(makeApp())
      .post('/api/ops-journal/task-1/state')
      .send({ state: 'staged-proposal' });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('staged-proposal');

    const staged = listStagedIntentsByProject('polimarket-analyser');
    expect(staged).toHaveLength(1);
    expect(staged[0].kind).toBe('journal.setState');
    expect(staged[0].task_id).toBe('task-1');
    expect(staged[0].state).toBe('staged');
    expect(staged[0].decision_proposal).toBe('Stand up off-box backups');
    const payload = JSON.parse(staged[0].payload);
    expect(payload.fields.findingOrProposal).toEqual({
      summary: 'Stand up off-box backups',
    });
  });

  describe('deferred ops-task close on applied-pending-confirm -> resolved', () => {
    it('closes the task when the owning session already went terminal with a completing reason', async () => {
      seedEntry('task-1', 'M12', { state: 'applied-pending-confirm' });
      seedOpsSession('session-1', 'task-1', 'planning_no_pending_dispositions');

      const res = await request(makeApp())
        .post('/api/ops-journal/task-1/state')
        .send({ state: 'resolved', disposition: 'pass' });

      expect(res.status).toBe(200);
      expect(res.body.state).toBe('resolved');
      expect(mockUpdateStatus).toHaveBeenCalledTimes(1);
      expect(mockUpdateStatus).toHaveBeenCalledWith(
        'task-1',
        DESIGN_DONE_STATUS,
        expect.objectContaining({ sessionId: 'session-1' }),
      );
    });

    it('does not close the task when no ops session exists for the task', async () => {
      seedEntry('task-1', 'M12', { state: 'applied-pending-confirm' });

      const res = await request(makeApp())
        .post('/api/ops-journal/task-1/state')
        .send({ state: 'resolved' });

      expect(res.status).toBe(200);
      expect(mockUpdateStatus).not.toHaveBeenCalled();
    });

    it('does not close the task when the session terminal reason is not a completing reason (e.g. operator-ended)', async () => {
      seedEntry('task-1', 'M12', { state: 'applied-pending-confirm' });
      seedOpsSession('session-1', 'task-1', 'planning_operator_end');

      const res = await request(makeApp())
        .post('/api/ops-journal/task-1/state')
        .send({ state: 'resolved' });

      expect(res.status).toBe(200);
      expect(mockUpdateStatus).not.toHaveBeenCalled();
    });

    it('does not double-close a task the synchronous path already closed', async () => {
      seedEntry('task-1', 'M12', { state: 'applied-pending-confirm' });
      seedOpsSession('session-1', 'task-1', 'planning_no_pending_dispositions');
      mockFetchTaskSummary.mockResolvedValue({ status: DESIGN_DONE_STATUS });

      const res = await request(makeApp())
        .post('/api/ops-journal/task-1/state')
        .send({ state: 'resolved' });

      expect(res.status).toBe(200);
      expect(mockUpdateStatus).not.toHaveBeenCalled();
    });

    it('does not close the task when a staged intent for the session was rejected', async () => {
      seedEntry('task-1', 'M12', { state: 'applied-pending-confirm' });
      seedOpsSession('session-1', 'task-1', 'planning_no_pending_dispositions');
      insertStagedIntent({
        id: 'intent-1',
        kind: 'journal.setState',
        payload: '{}',
        payload_hash: 'hash-1',
        task_id: 'task-1',
        project_id: 'polimarket-analyser',
        session_id: 'session-1',
        group_id: null,
        milestone: 'M12',
        state: 'rejected',
        supersedes: null,
        annotation: null,
        decision_proposal: null,
        investigation: null,
        groom_proposal: null,
        advisory: null,
        disposition_reason: null,
        answer: null,
        created_at: 0,
        updated_at: 0,
      } as any);

      const res = await request(makeApp())
        .post('/api/ops-journal/task-1/state')
        .send({ state: 'resolved' });

      expect(res.status).toBe(200);
      expect(mockUpdateStatus).not.toHaveBeenCalled();
    });
  });
});
