/**
 * The decision.pickOne question-intent kind: a multi-option question the
 * dispatched session poses to the operator (modeled on Claude's
 * AskUserQuestion shape). Staging writes no task store — validation rejects
 * a group_id (it's a question, not a structural-change unit) and requires a
 * substantive decisionProposal plus per-option descriptions. Answering
 * records the choice, resolves the intent, writes no task-store mutation,
 * and re-turns the originating session — never applies through
 * TaskWriteCommands.
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

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { createStagedIntentsRouter, stageIntent } from '../stagedIntents';
import { getStagedIntent } from '../../db/queries';
import type { PlanningOrchestrator } from '../../orchestration/PlanningOrchestrator';

function makePlanningOrchestrator() {
  return {
    handleDisposition: vi.fn().mockResolvedValue(undefined),
  } as unknown as PlanningOrchestrator & {
    handleDisposition: ReturnType<typeof vi.fn>;
  };
}

function makeApp(
  planningOrchestrator?: ReturnType<typeof makePlanningOrchestrator>,
) {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter(planningOrchestrator));
  return app;
}

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

beforeEach(() => {
  mockRecordEvent.mockReset();
  mockGetTaskBackend.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
});

describe('decision.pickOne staging validation', () => {
  it('rejects staging with a group_id', () => {
    expect(() =>
      stageIntent(
        'decision.pickOne',
        { prompt: 'Which approach?', options: OPTIONS, allowFreeForm: true },
        'proj-1',
        'group-1',
        'sess-1',
        'A genuine fork the session cannot resolve confidently.',
      ),
    ).toThrow(/cannot belong to a group/);
  });

  it('rejects staging without a substantive decisionProposal', () => {
    expect(() =>
      stageIntent(
        'decision.pickOne',
        { prompt: 'Which approach?', options: OPTIONS, allowFreeForm: true },
        'proj-1',
        null,
        'sess-1',
        '   ',
      ),
    ).toThrow(/decisionProposal/);
  });

  it('rejects staging when an option is missing a substantive description', () => {
    expect(() =>
      stageIntent(
        'decision.pickOne',
        {
          prompt: 'Which approach?',
          options: [
            { label: 'Option A', description: '' },
            { label: 'Option B', description: 'Cap it.' },
          ],
          allowFreeForm: true,
        },
        'proj-1',
        null,
        'sess-1',
        'A genuine fork the session cannot resolve confidently.',
      ),
    ).toThrow(/substantive description/);
  });

  it('rejects staging with zero options', () => {
    expect(() =>
      stageIntent(
        'decision.pickOne',
        {
          prompt: 'Which approach?',
          options: [],
          allowFreeForm: true,
        },
        'proj-1',
        null,
        'sess-1',
        'A genuine fork the session cannot resolve confidently.',
      ),
    ).toThrow(/at least one/);
  });

  it('accepts staging with a single option — a confident recommendation, not just a genuine fork', () => {
    const intent = stageIntent(
      'decision.pickOne',
      {
        prompt: 'Which approach?',
        options: [{ label: 'Option A', description: 'Batch it, streaming.' }],
        allowFreeForm: true,
      },
      'proj-1',
      null,
      'sess-1',
      'A confident recommendation the operator can accept or push back on.',
    );
    expect(getStagedIntent(intent.id)!.state).toBe('staged');
  });
});

describe('decision.pickOne dedup', () => {
  it('re-emitting an identical decision.pickOne from the same session dedups (no duplicate)', () => {
    const payload = {
      prompt: 'Which approach?',
      options: OPTIONS,
      allowFreeForm: true,
    };
    const first = stageIntent(
      'decision.pickOne',
      payload,
      'proj-1',
      null,
      'sess-1',
      'A genuine fork the session cannot resolve confidently.',
    );
    const second = stageIntent(
      'decision.pickOne',
      payload,
      'proj-1',
      null,
      'sess-1',
      'A genuine fork the session cannot resolve confidently.',
    );

    expect(second.id).toBe(first.id);
    expect(getStagedIntent(first.id)!.state).toBe('staged');
  });

  it('a changed payload supersedes the standing question', () => {
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
        prompt: 'Which approach, revised?',
        options: OPTIONS,
        allowFreeForm: true,
      },
      'proj-1',
      null,
      'sess-1',
      'A genuine fork the session cannot resolve confidently.',
    );

    expect(second.id).not.toBe(first.id);
    expect(getStagedIntent(first.id)!.state).toBe('superseded');
    expect(getStagedIntent(second.id)!.supersedes).toBe(first.id);
    expect(getStagedIntent(second.id)!.state).toBe('staged');
  });
});

describe('POST /api/staged-intents/:id/answer', () => {
  it('records { chosenLabel, freeForm }, resolves the intent, writes no task-store mutation, and re-turns the originating session', async () => {
    const planningOrchestrator = makePlanningOrchestrator();
    const app = makeApp(planningOrchestrator);
    const intent = stageIntent(
      'decision.pickOne',
      { prompt: 'Which approach?', options: OPTIONS, allowFreeForm: true },
      'proj-1',
      null,
      'planning-session-1',
      'A genuine fork the session cannot resolve confidently.',
    );

    const res = await supertest(app)
      .post(`/api/staged-intents/${intent.id}/answer`)
      .send({
        chosenLabel: 'Option A',
        freeForm: 'Batching keeps memory flat.',
      });

    expect(res.status).toBe(200);
    const row = getStagedIntent(intent.id)!;
    expect(row.state).toBe('committed');
    expect(JSON.parse(row.answer!)).toEqual({
      chosenLabel: 'Option A',
      freeForm: 'Batching keeps memory flat.',
    });

    // No task-store write path is ever touched.
    expect(mockGetTaskBackend).not.toHaveBeenCalled();

    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'staged_intent_disposition',
        payload: expect.objectContaining({
          intentId: intent.id,
          disposition: 'answer',
          chosenLabel: 'Option A',
          freeForm: 'Batching keeps memory flat.',
        }),
      }),
    );

    expect(planningOrchestrator.handleDisposition).toHaveBeenCalledWith(
      expect.objectContaining({
        disposition: 'answer',
        answer: {
          chosenLabel: 'Option A',
          freeForm: 'Batching keeps memory flat.',
        },
      }),
    );
  });

  it('rejects a chosenLabel that does not match a staged option', async () => {
    const app = makeApp();
    const intent = stageIntent(
      'decision.pickOne',
      { prompt: 'Which approach?', options: OPTIONS, allowFreeForm: true },
      'proj-1',
      null,
      'sess-1',
      'A genuine fork the session cannot resolve confidently.',
    );

    const res = await supertest(app)
      .post(`/api/staged-intents/${intent.id}/answer`)
      .send({ chosenLabel: 'Option Z' });

    expect(res.status).toBe(400);
    expect(getStagedIntent(intent.id)!.state).toBe('staged');
  });

  it('a second answer is rejected by the state machine', async () => {
    const app = makeApp(makePlanningOrchestrator());
    const intent = stageIntent(
      'decision.pickOne',
      { prompt: 'Which approach?', options: OPTIONS, allowFreeForm: true },
      'proj-1',
      null,
      'sess-1',
      'A genuine fork the session cannot resolve confidently.',
    );

    const first = await supertest(app)
      .post(`/api/staged-intents/${intent.id}/answer`)
      .send({ chosenLabel: 'Option A' });
    expect(first.status).toBe(200);

    const second = await supertest(app)
      .post(`/api/staged-intents/${intent.id}/answer`)
      .send({ chosenLabel: 'Option B' });
    expect(second.status).toBe(404);

    // The first answer is untouched.
    expect(JSON.parse(getStagedIntent(intent.id)!.answer!).chosenLabel).toBe(
      'Option A',
    );
  });

  it('a single-option pickOne: picking the one option (accept) resolves it', async () => {
    const planningOrchestrator = makePlanningOrchestrator();
    const app = makeApp(planningOrchestrator);
    const intent = stageIntent(
      'decision.pickOne',
      {
        prompt: 'Which approach?',
        options: [{ label: 'Option A', description: 'Batch it, streaming.' }],
        allowFreeForm: true,
      },
      'proj-1',
      null,
      'sess-1',
      'A confident recommendation the operator can accept or push back on.',
    );

    const res = await supertest(app)
      .post(`/api/staged-intents/${intent.id}/answer`)
      .send({ chosenLabel: 'Option A' });

    expect(res.status).toBe(200);
    const row = getStagedIntent(intent.id)!;
    expect(row.state).toBe('committed');
    expect(JSON.parse(row.answer!).chosenLabel).toBe('Option A');
  });

  it('a single-option pickOne: reject/pushback works via the generic reject route', async () => {
    const app = makeApp();
    const intent = stageIntent(
      'decision.pickOne',
      {
        prompt: 'Which approach?',
        options: [{ label: 'Option A', description: 'Batch it, streaming.' }],
        allowFreeForm: true,
      },
      'proj-1',
      null,
      'sess-1',
      'A confident recommendation the operator can accept or push back on.',
    );

    const res = await supertest(app)
      .post(`/api/staged-intents/${intent.id}/reject`)
      .send({ outcome: 'decline', reason: 'Use polling instead.' });

    expect(res.status).toBe(200);
    expect(getStagedIntent(intent.id)!.state).toBe('rejected');
  });

  it('cannot be applied or approved through the generic apply/approve routes', async () => {
    const app = makeApp();
    const intent = stageIntent(
      'decision.pickOne',
      { prompt: 'Which approach?', options: OPTIONS, allowFreeForm: true },
      'proj-1',
      null,
      'sess-1',
      'A genuine fork the session cannot resolve confidently.',
    );

    const applyRes = await supertest(app).post(
      `/api/staged-intents/${intent.id}/apply`,
    );
    expect(applyRes.status).toBe(409);

    const approveRes = await supertest(app).post(
      `/api/staged-intents/${intent.id}/approve`,
    );
    expect(approveRes.status).toBe(409);

    expect(getStagedIntent(intent.id)!.state).toBe('staged');
  });
});
