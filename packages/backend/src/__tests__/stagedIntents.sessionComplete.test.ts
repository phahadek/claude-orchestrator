/**
 * The unresolved-session fallback for the milestone decision inbox's
 * `sessionComplete` field: a session whose turn is genuinely in flight must
 * never read as complete, and a session that cannot be resolved in the live
 * map (SessionManager.getLiveSession returns undefined) must fail toward
 * "incomplete" rather than "complete" — see resolveTurnInFlight in
 * routes/stagedIntents.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

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
import { insertStagedIntent } from '../db/queries';
import type { StagedIntentRow } from '../db/types';
import { createStagedIntentsRouter } from '../routes/stagedIntents';
import type { SessionManager } from '../session/SessionManager';

const PROJECT_ID = 'proj-1';
const SESSION_ID = 'session-1';

function makeSessionManager(
  liveSession: { hasActiveTurn: () => boolean } | undefined,
) {
  return {
    getLiveSession: vi.fn().mockReturnValue(liveSession),
  } as unknown as SessionManager;
}

function makeApp(sessionManager?: SessionManager) {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter(undefined, sessionManager));
  return app;
}

let counter = 0;
function stageIntent(
  overrides: Partial<StagedIntentRow> = {},
): StagedIntentRow {
  counter += 1;
  const now = Date.now();
  const row: StagedIntentRow = {
    id: `intent-${counter}`,
    kind: 'task.updateBody',
    payload: JSON.stringify({ taskId: 'task-1' }),
    payload_hash: `hash-${counter}`,
    task_id: 'task-1',
    project_id: PROJECT_ID,
    session_id: SESSION_ID,
    group_id: null,
    milestone: null,
    state: 'staged',
    supersedes: null,
    annotation: null,
    decision_proposal: null,
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

beforeEach(() => {
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  counter = 0;
});

async function fetchUnattributed(app: express.Express) {
  const res = await supertest(app)
    .get('/api/staged-intents')
    .query({ projectId: PROJECT_ID, milestone: 'unattributed' });
  return res.body.intents as Array<{ id: string; sessionComplete: unknown }>;
}

describe('milestone-lens sessionComplete', () => {
  it('reads false while the owning session has an active turn', async () => {
    stageIntent();
    const app = makeApp(makeSessionManager({ hasActiveTurn: () => true }));
    const intents = await fetchUnattributed(app);
    expect(intents).toHaveLength(1);
    expect(intents[0].sessionComplete).toBe(false);
  });

  it('reads true once the turn has ended and the session has an active staged intent', async () => {
    stageIntent();
    const app = makeApp(makeSessionManager({ hasActiveTurn: () => false }));
    const intents = await fetchUnattributed(app);
    expect(intents[0].sessionComplete).toBe(true);
  });

  it('fails toward incomplete — false, not true — when the owning session cannot be resolved in the live map', async () => {
    stageIntent();
    const app = makeApp(makeSessionManager(undefined));
    const intents = await fetchUnattributed(app);
    expect(intents[0].sessionComplete).toBe(false);
  });

  it('fails toward incomplete when no sessionManager was wired in at all', async () => {
    stageIntent();
    const app = makeApp(undefined);
    const intents = await fetchUnattributed(app);
    expect(intents[0].sessionComplete).toBe(false);
  });
});
