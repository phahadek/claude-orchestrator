/**
 * Answer-contract coverage for POST /api/staged-intents/:id/answer: a
 * decision.pickOne answer must carry at least one of chosenLabel or
 * freeForm, chosenLabel must match a staged option when present, and
 * allowFreeForm: false still requires chosenLabel. Also covers that a
 * free-form-only answer reaches the originating session as the answer
 * itself, not an empty quoted label.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const { mockGetTaskBackend, mockRecordEvent } = vi.hoisted(() => ({
  mockGetTaskBackend: vi.fn(),
  mockRecordEvent: vi.fn(),
}));

vi.mock('../tasks/TaskBackend', () => ({
  getTaskBackend: mockGetTaskBackend,
}));

vi.mock('../audit/AuditLog', () => ({
  recordEvent: mockRecordEvent,
}));

vi.mock('../db/db', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../db/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/queries')>();
  return {
    ...actual,
    getTaskCache: vi.fn().mockReturnValue(null),
  };
});

import { db } from '../db/db';
import { createStagedIntentsRouter } from '../routes/stagedIntents';
import type { PlanningOrchestrator } from '../orchestration/PlanningOrchestrator';

function makeApp(planningOrchestrator?: PlanningOrchestrator) {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter(planningOrchestrator));
  return app;
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  mockRecordEvent.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
});

async function stageDecision(
  agent: ReturnType<typeof supertest>,
  overrides: { allowFreeForm?: boolean } = {},
) {
  const res = await agent.post('/api/staged-intents').send({
    kind: 'decision.pickOne',
    projectId: 'proj-1',
    decisionProposal: 'A confident recommendation.',
    payload: {
      prompt: 'Should we cap the reader at 10MB?',
      options: [
        { label: 'Cap at 10MB', description: 'Error above the cap.' },
      ],
      allowFreeForm: overrides.allowFreeForm ?? true,
    },
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

describe('POST /api/staged-intents/:id/answer — contract', () => {
  it('accepts a free-form-only answer and stores it', async () => {
    const app = makeApp();
    const agent = supertest(app);
    const id = await stageDecision(agent);

    const res = await agent.post(`/api/staged-intents/${id}/answer`).send({
      freeForm: 'None of these — do something else instead.',
    });

    expect(res.status).toBe(200);
    expect(res.body.intent.answer).toEqual({
      chosenLabel: null,
      freeForm: 'None of these — do something else instead.',
    });
    expect(res.body.intent.state).toBe('committed');
  });

  it('rejects a free-form-only answer when allowFreeForm is false', async () => {
    const app = makeApp();
    const agent = supertest(app);
    const id = await stageDecision(agent, { allowFreeForm: false });

    const res = await agent.post(`/api/staged-intents/${id}/answer`).send({
      freeForm: 'None of these — do something else instead.',
    });

    expect(res.status).toBe(400);
  });

  it('rejects a request with neither chosenLabel nor non-empty freeForm', async () => {
    const app = makeApp();
    const agent = supertest(app);
    const id = await stageDecision(agent);

    const res = await agent.post(`/api/staged-intents/${id}/answer`).send({
      freeForm: '   ',
    });

    expect(res.status).toBe(400);
  });

  it('still rejects a chosenLabel matching no staged option', async () => {
    const app = makeApp();
    const agent = supertest(app);
    const id = await stageDecision(agent);

    const res = await agent.post(`/api/staged-intents/${id}/answer`).send({
      chosenLabel: 'Not a real option',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/chosenLabel must match/);
  });

  it('produces a session-facing message carrying the operator text, with no empty quoted label', async () => {
    const handleDisposition = vi.fn().mockResolvedValue(undefined);
    const planningOrchestrator = {
      handleDisposition,
    } as unknown as PlanningOrchestrator;
    const app = makeApp(planningOrchestrator);
    const agent = supertest(app);
    const id = await stageDecision(agent);

    const res = await agent.post(`/api/staged-intents/${id}/answer`).send({
      freeForm: 'None of these — do something else instead.',
    });

    expect(res.status).toBe(200);
    expect(handleDisposition).toHaveBeenCalledWith(
      expect.objectContaining({
        disposition: 'answer',
        answer: {
          chosenLabel: null,
          freeForm: 'None of these — do something else instead.',
        },
      }),
    );
  });

  it('404s on a second answer to an already-answered intent', async () => {
    const app = makeApp();
    const agent = supertest(app);
    const id = await stageDecision(agent);

    const first = await agent
      .post(`/api/staged-intents/${id}/answer`)
      .send({ chosenLabel: 'Cap at 10MB' });
    expect(first.status).toBe(200);

    const second = await agent
      .post(`/api/staged-intents/${id}/answer`)
      .send({ freeForm: 'Actually, no.' });
    expect(second.status).toBe(404);
  });
});
