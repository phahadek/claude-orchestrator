/**
 * Operator-authorized supersession of an already-committed decision.pickOne:
 * POST /staged-intents/decision-supersede (device-authed direct write) and the
 * GET /staged-intents kind/state read filter.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const { mockRecordEvent, mockGetTaskBackend } = vi.hoisted(() => ({
  mockRecordEvent: vi.fn(),
  mockGetTaskBackend: vi.fn(),
}));

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: mockRecordEvent,
}));

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: mockGetTaskBackend,
}));

vi.mock('../../auth/DeviceAuth', () => ({
  requireDeviceAuth: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    (req as express.Request & { device: { id: string } }).device = {
      id: 'device-op-1',
    };
    next();
  },
}));

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { createStagedIntentsRouter, stageIntent } from '../stagedIntents';
import { getStagedIntent, insertStagedIntent } from '../../db/queries';
import type { StagedIntentRow } from '../../db/types';

const OPTIONS = [
  {
    label: 'Option A',
    description: 'Rewrite the reader to stream in batches.',
  },
  {
    label: 'Option B',
    description: 'Cap the reader at 10MB and error above that.',
  },
];

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter());
  return app;
}

function seedRow(over: Partial<StagedIntentRow>): StagedIntentRow {
  const row: StagedIntentRow = {
    id: 'dec-old',
    kind: 'decision.pickOne',
    payload: JSON.stringify({
      prompt: 'Which approach?',
      options: OPTIONS,
      allowFreeForm: false,
    }),
    payload_hash: 'h',
    task_id: null,
    project_id: 'proj-1',
    session_id: 'sess-old',
    group_id: null,
    milestone: null,
    state: 'committed',
    supersedes: null,
    annotation: null,
    decision_proposal: 'Pick one.',
    investigation: null,
    groom_proposal: null,
    advisory: null,
    disposition_reason: null,
    answer: JSON.stringify({ chosenLabel: 'Option A', freeForm: null }),
    applied_task_id: null,
    created_at: 1,
    updated_at: 1,
    ...over,
  };
  insertStagedIntent(row);
  return row;
}

beforeEach(() => {
  mockRecordEvent.mockReset();
  mockGetTaskBackend.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
});

describe('POST /staged-intents/decision-supersede', () => {
  it('supersedes a committed decision from another session, links an existing successor, and audits once', async () => {
    seedRow({ id: 'dec-old' });
    seedRow({ id: 'dec-new', session_id: 'sess-new' });

    const res = await supertest(makeApp())
      .post('/api/staged-intents/decision-supersede')
      .send({
        projectId: 'proj-1',
        targetId: 'dec-old',
        successorId: 'dec-new',
        decidingTaskId: 'task-design',
      });

    expect(res.status).toBe(200);
    expect(getStagedIntent('dec-old')?.state).toBe('superseded');
    expect(getStagedIntent('dec-new')?.supersedes).toBe('dec-old');
    expect(getStagedIntent('dec-new')?.state).toBe('committed');
    expect(mockRecordEvent).toHaveBeenCalledTimes(1);
    expect(mockRecordEvent.mock.calls[0][0]).toMatchObject({
      event_type: 'decision_superseded',
      actor_id: 'device-op-1',
      task_id: 'task-design',
      payload: {
        supersededDecisionId: 'dec-old',
        successorDecisionId: 'dec-new',
        decidingTaskId: 'task-design',
      },
    });
  });

  it('creates and links a restaged narrowed successor in the same operation', async () => {
    seedRow({ id: 'dec-old' });

    const res = await supertest(makeApp())
      .post('/api/staged-intents/decision-supersede')
      .send({
        projectId: 'proj-1',
        targetId: 'dec-old',
        decidingTaskId: 'task-design',
        successor: {
          payload: {
            prompt: 'Which approach (narrowed)?',
            options: OPTIONS,
            allowFreeForm: false,
          },
          decisionProposal: 'Narrowed: keeps only the streaming clause.',
          answer: { chosenLabel: 'Option A' },
        },
      });

    expect(res.status).toBe(200);
    const successorId = res.body.successor.id as string;
    const successor = getStagedIntent(successorId);
    expect(successor?.state).toBe('committed');
    expect(successor?.supersedes).toBe('dec-old');
    expect(getStagedIntent('dec-old')?.state).toBe('superseded');
    expect(mockRecordEvent).toHaveBeenCalledTimes(1);
  });

  it('refuses an already-superseded target', async () => {
    seedRow({ id: 'dec-old', state: 'superseded' });
    seedRow({ id: 'dec-new' });

    const res = await supertest(makeApp())
      .post('/api/staged-intents/decision-supersede')
      .send({
        projectId: 'proj-1',
        targetId: 'dec-old',
        successorId: 'dec-new',
        decidingTaskId: 'task-design',
      });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('target_not_committed');
    expect(getStagedIntent('dec-new')?.supersedes).toBeNull();
    expect(mockRecordEvent).not.toHaveBeenCalled();
  });

  it('refuses a different-project target', async () => {
    seedRow({ id: 'dec-old', project_id: 'proj-2' });
    seedRow({ id: 'dec-new' });

    const res = await supertest(makeApp())
      .post('/api/staged-intents/decision-supersede')
      .send({
        projectId: 'proj-1',
        targetId: 'dec-old',
        successorId: 'dec-new',
        decidingTaskId: 'task-design',
      });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('target_wrong_project');
    expect(getStagedIntent('dec-old')?.state).toBe('committed');
  });

  it('refuses a non-decision kind', async () => {
    seedRow({ id: 'task-intent', kind: 'task.setStatus' });
    seedRow({ id: 'dec-new' });

    const res = await supertest(makeApp())
      .post('/api/staged-intents/decision-supersede')
      .send({
        projectId: 'proj-1',
        targetId: 'task-intent',
        successorId: 'dec-new',
        decidingTaskId: 'task-design',
      });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('target_not_decision');
    expect(getStagedIntent('task-intent')?.state).toBe('committed');
  });
});

describe('GET /staged-intents with kind/state filters', () => {
  it('returns committed and superseded decision rows with supersedes for a project', async () => {
    seedRow({ id: 'dec-old', state: 'superseded' });
    seedRow({ id: 'dec-new', supersedes: 'dec-old' });
    seedRow({ id: 'dec-staged', state: 'staged' });
    seedRow({ id: 'other-project', project_id: 'proj-2' });
    seedRow({ id: 'other-kind', kind: 'task.setStatus' });

    const res = await supertest(makeApp()).get(
      '/api/staged-intents?projectId=proj-1&kind=decision.pickOne&state=committed,superseded',
    );

    expect(res.status).toBe(200);
    const byId = Object.fromEntries(
      (
        res.body.intents as Array<{ id: string; supersedes: string | null }>
      ).map((i) => [i.id, i.supersedes]),
    );
    expect(Object.keys(byId).sort()).toEqual(['dec-new', 'dec-old']);
    expect(byId['dec-new']).toBe('dec-old');
  });
});

describe('same-session re-pick supersession', () => {
  it('is unchanged: a re-staged decision supersedes the active one', () => {
    const first = stageIntent(
      'decision.pickOne',
      { prompt: 'Which approach?', options: OPTIONS, allowFreeForm: true },
      'proj-1',
      null,
      'sess-1',
      'A genuine fork the session cannot resolve confidently.',
    );
    const second = stageIntent(
      'decision.pickOne',
      {
        prompt: 'Which approach?',
        options: [...OPTIONS].reverse(),
        allowFreeForm: true,
      },
      'proj-1',
      null,
      'sess-1',
      'A genuine fork the session cannot resolve confidently.',
    );
    expect(second.supersedes).toBe(first.id);
    expect(getStagedIntent(first.id)?.state).toBe('superseded');
  });
});
