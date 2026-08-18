import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const { mockRecordEvent, mockGetTaskBackend } = vi.hoisted(() => ({
  mockRecordEvent: vi.fn(),
  mockGetTaskBackend: vi.fn(),
}));

vi.mock('../audit/AuditLog', () => ({
  recordEvent: mockRecordEvent,
  getCapabilityDispositionEvents: () => [],
}));

vi.mock('../tasks/TaskBackend', () => ({
  getTaskBackend: mockGetTaskBackend,
}));

vi.mock('../db/db', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

// Uses the real config.ts singleton (not mocked) so that PATCHing the
// setting through the route and staging a decision.pickOne through
// stagedIntents.ts observe the same runtimeSettings instance.
import { runtimeSettings } from '../config';
import settingsRouter from '../routes/settings';
import { stageIntent } from '../routes/stagedIntents';
import { db } from '../db/db';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/', settingsRouter);
  return app;
}

const OPTIONS = [
  { label: 'Option A', description: 'Rewrite the reader to stream in batches.' },
];

const LONG_NO_BREAKS = 'x'.repeat(600);

beforeEach(() => {
  mockRecordEvent.mockReset();
  mockGetTaskBackend.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM settings').run();
  runtimeSettings.decision_pick_one_paragraph_threshold = 560;
});

describe('decision_pick_one_paragraph_threshold setting', () => {
  it('GET reflects the default of 560', async () => {
    const res = await supertest(buildApp()).get('/');
    expect(res.status).toBe(200);
    expect(res.body.decision_pick_one_paragraph_threshold).toBe('560');
  });

  it('PATCH persists a new value', async () => {
    const res = await supertest(buildApp())
      .patch('/')
      .send({ decision_pick_one_paragraph_threshold: 1000 });

    expect(res.status).toBe(200);
    expect(res.body.current.decision_pick_one_paragraph_threshold).toBe(
      '1000',
    );
    expect(runtimeSettings.decision_pick_one_paragraph_threshold).toBe(1000);
  });

  it('PATCH with a value below 100 returns 400 and does not persist', async () => {
    const res = await supertest(buildApp())
      .patch('/')
      .send({ decision_pick_one_paragraph_threshold: 50 });

    expect(res.status).toBe(400);
    expect(runtimeSettings.decision_pick_one_paragraph_threshold).toBe(560);
  });

  it('PATCHing the threshold changes enforcement in validateDecisionPickOnePayload', async () => {
    // At the default 560, a 600-char unbroken decisionProposal is rejected.
    expect(() =>
      stageIntent(
        'decision.pickOne',
        { prompt: 'Which approach?', options: OPTIONS, allowFreeForm: true },
        'proj-1',
        null,
        'sess-1',
        LONG_NO_BREAKS,
      ),
    ).toThrow(/paragraph breaks/);

    // Raise the threshold above the text length via PATCH — now it's accepted.
    const res = await supertest(buildApp())
      .patch('/')
      .send({ decision_pick_one_paragraph_threshold: 2000 });
    expect(res.status).toBe(200);

    const intent = stageIntent(
      'decision.pickOne',
      { prompt: 'Which approach, v2?', options: OPTIONS, allowFreeForm: true },
      'proj-1',
      null,
      'sess-1',
      LONG_NO_BREAKS,
    );
    expect(intent.decisionProposal).toBe(LONG_NO_BREAKS);
  });
});
