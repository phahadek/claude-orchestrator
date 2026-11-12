import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const { mockRecordEvent, getPrefix } = vi.hoisted(() => ({
  mockRecordEvent: vi.fn(),
  getPrefix: vi.fn(),
}));

vi.mock('../../audit/AuditLog', () => ({ recordEvent: mockRecordEvent }));

vi.mock('../../session/orchestrator-config', async () => {
  const actual = await vi.importActual<
    typeof import('../../session/orchestrator-config')
  >('../../session/orchestrator-config');
  return { ...actual, getReadonlyQueryPrefix: getPrefix };
});

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { createStagedIntentsRouter, stageIntent } from '../stagedIntents';
import { rejectStageGuard, StageGuardRejectionError } from '../stageGuard';
import { getStagedIntent } from '../../db/queries';

const OPTIONS = [
  { label: 'Option A', description: 'Rewrite the reader to stream.' },
  { label: 'Option B', description: 'Cap the reader at 10MB.' },
];

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter(undefined));
  return app;
}

function stageQuestion() {
  return stageIntent(
    'decision.pickOne',
    { prompt: 'Which approach?', options: OPTIONS, allowFreeForm: true },
    'proj-1',
    null,
    'planning-session-1',
    'A genuine fork the session cannot resolve confidently.',
  );
}

beforeEach(() => {
  mockRecordEvent.mockReset();
  getPrefix.mockReset();
  getPrefix.mockReturnValue(null);
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
});

describe('measurement-handoff guard', () => {
  const handoff = [
    {
      label: 'Operator measures X',
      description: 'The operator runs the count and reports back.',
    },
    { label: 'Option B', description: 'Cap the reader at 10MB.' },
  ];
  const stage = (payload: Record<string, unknown>) =>
    stageIntent(
      'decision.pickOne',
      { prompt: 'Which?', options: handoff, allowFreeForm: true, ...payload },
      'proj-1',
      null,
      'planning-session-1',
      'A genuine fork.',
    );

  it('stages unchanged when the project declares no readonly_query', () => {
    getPrefix.mockReturnValue(null);
    expect(stage({}).kind).toBe('decision.pickOne');
  });

  it('rejects with an audit event when readonly_query is declared', () => {
    getPrefix.mockReturnValue('python3 scripts/ro.py');
    expect(() => stage({})).toThrow(StageGuardRejectionError);
    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'stage_guard_rejected',
        payload: expect.objectContaining({ guardId: 'measurement-handoff' }),
      }),
    );
  });

  it('rejects an implementer-investigates option', () => {
    getPrefix.mockReturnValue('python3 scripts/ro.py');
    expect(() =>
      stageIntent(
        'decision.pickOne',
        {
          prompt: 'Which?',
          options: [
            {
              label: 'Defer',
              description: 'The implementer investigates Y first.',
            },
          ],
          allowFreeForm: true,
        },
        'proj-1',
        null,
        'planning-session-1',
        'A genuine fork.',
      ),
    ).toThrow(StageGuardRejectionError);
  });

  it('accepts with a failedRead citation', () => {
    getPrefix.mockReturnValue('python3 scripts/ro.py');
    expect(stage({ failedRead: { error: 'permission denied' } }).kind).toBe(
      'decision.pickOne',
    );
  });
});

describe('rejectStageGuard', () => {
  it('throws naming the guard and evidence and records exactly one audit event', () => {
    let caught: unknown;
    try {
      rejectStageGuard({
        guardId: 'dependency',
        evidence: 'cite the dependency task id',
        sessionId: 'sess-1',
        taskId: 'task-1',
        intentKind: 'decision.pickOne',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StageGuardRejectionError);
    const msg = (caught as Error).message;
    expect(msg).toContain('dependency');
    expect(msg).toContain('cite the dependency task id');
    expect(mockRecordEvent).toHaveBeenCalledTimes(1);
    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'stage_guard_rejected',
        payload: expect.objectContaining({
          guardId: 'dependency',
          sessionId: 'sess-1',
          taskId: 'task-1',
          intentKind: 'decision.pickOne',
        }),
      }),
    );
  });

  it('never persists a staged_intent row', () => {
    expect(() =>
      rejectStageGuard({
        guardId: 'noop-blocker',
        evidence: 'cite the commit',
        sessionId: 's',
        taskId: null,
        intentKind: 'decision.pickOne',
      }),
    ).toThrow(StageGuardRejectionError);
    const count = db
      .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM staged_intent')
      .get()!.n;
    expect(count).toBe(0);
  });
});

describe('answer avoidableClass', () => {
  it('persists a known class on the answer', async () => {
    const intent = stageQuestion();
    const res = await supertest(makeApp())
      .post(`/api/staged-intents/${intent.id}/answer`)
      .send({ chosenLabel: 'Option A', avoidableClass: 'state-claim' });
    expect(res.status).toBe(200);
    expect(JSON.parse(getStagedIntent(intent.id)!.answer!)).toEqual({
      chosenLabel: 'Option A',
      freeForm: null,
      avoidableClass: 'state-claim',
    });
  });

  it('rejects an unknown class', async () => {
    const intent = stageQuestion();
    const res = await supertest(makeApp())
      .post(`/api/staged-intents/${intent.id}/answer`)
      .send({ chosenLabel: 'Option A', avoidableClass: 'bogus' });
    expect(res.status).toBe(400);
    expect(getStagedIntent(intent.id)!.state).toBe('staged');
  });

  it('behaves as before without avoidableClass', async () => {
    const intent = stageQuestion();
    const res = await supertest(makeApp())
      .post(`/api/staged-intents/${intent.id}/answer`)
      .send({ chosenLabel: 'Option B' });
    expect(res.status).toBe(200);
    expect(JSON.parse(getStagedIntent(intent.id)!.answer!)).toEqual({
      chosenLabel: 'Option B',
      freeForm: null,
    });
  });
});
