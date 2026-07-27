/**
 * Tests for the reasoning-correction supersede path of stageIntent
 * (routes/stagedIntents.ts): a re-emission whose payload hash matches a
 * standing intent is normally a no-op, but an explicit `explicitSupersedes`
 * pointer must be honoured before that equality check so a session can
 * correct its groomProposal/decisionProposal without changing the payload.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import { stageIntent } from '../stagedIntents.js';
import { getStagedIntent } from '../../db/queries.js';

beforeEach(() => {
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
});

const GROOM_A = {
  achieves: 'Achieves A',
  openQuestions: 'None',
  automatedTests: 'tests A',
  manualVerification: 'manual A',
  operationalSeed: 'seed A',
};

const GROOM_B = {
  achieves: 'Achieves A',
  openQuestions: 'Actually there is an open question about X',
  automatedTests: 'tests A',
  manualVerification: 'manual A',
  operationalSeed: 'seed A',
};

describe('stageIntent — reasoning-only correction via explicit supersede', () => {
  it('a same-payload re-stage with a changed groomProposal and explicit supersedes lands the new reasoning', () => {
    const first = stageIntent(
      'task.setStatus',
      { taskId: 't-1', status: 'Ready' },
      'proj-1',
      'group-1',
      'session-1',
      null,
      GROOM_A,
    );
    expect(first.groomProposal).toEqual(GROOM_A);

    const second = stageIntent(
      'task.setStatus',
      { taskId: 't-1', status: 'Ready' },
      'proj-1',
      'group-1',
      'session-1',
      null,
      GROOM_B,
      first.id,
    );

    expect(second.id).not.toBe(first.id);
    expect(second.supersedes).toBe(first.id);
    expect(getStagedIntent(first.id)!.state).toBe('superseded');

    const persisted = getStagedIntent(second.id)!;
    expect(persisted.groom_proposal).toBeTruthy();
    expect(JSON.parse(persisted.groom_proposal!)).toEqual(GROOM_B);
  });

  it('a same-payload re-stage with a changed decisionProposal and explicit supersedes lands the new reasoning', () => {
    const first = stageIntent(
      'task.setStatus',
      { taskId: 't-2', status: 'Ready' },
      'proj-1',
      'group-1',
      'session-1',
      'Original reasoning',
    );
    expect(first.decisionProposal).toBe('Original reasoning');

    const second = stageIntent(
      'task.setStatus',
      { taskId: 't-2', status: 'Ready' },
      'proj-1',
      'group-1',
      'session-1',
      'Corrected reasoning',
      null,
      first.id,
    );

    expect(second.id).not.toBe(first.id);
    expect(second.supersedes).toBe(first.id);
    expect(getStagedIntent(first.id)!.state).toBe('superseded');

    const persisted = getStagedIntent(second.id)!;
    expect(persisted.decision_proposal).toBe('Corrected reasoning');
  });

  it('an identical payload and identical reasoning re-stage without an explicit pointer is still a no-op', () => {
    const first = stageIntent(
      'task.setStatus',
      { taskId: 't-3', status: 'Ready' },
      'proj-1',
      'group-1',
      'session-1',
      null,
      GROOM_A,
    );

    const second = stageIntent(
      'task.setStatus',
      { taskId: 't-3', status: 'Ready' },
      'proj-1',
      'group-1',
      'session-1',
      null,
      GROOM_A,
    );

    expect(second.id).toBe(first.id);
    expect(second.supersedes).toBeNull();
    expect(getStagedIntent(first.id)!.state).not.toBe('superseded');
  });

  it('a differing-payload re-stage without an explicit pointer still supersedes via ordinary task-id lookup', () => {
    const first = stageIntent(
      'task.setStatus',
      { taskId: 't-4', status: 'Ready' },
      'proj-1',
      'group-1',
      'session-1',
      null,
      GROOM_A,
    );

    const second = stageIntent(
      'task.setStatus',
      { taskId: 't-4', status: 'Backlog' },
      'proj-1',
      'group-1',
      'session-1',
      null,
      GROOM_B,
    );

    expect(second.id).not.toBe(first.id);
    expect(second.supersedes).toBe(first.id);
    expect(getStagedIntent(first.id)!.state).toBe('superseded');
  });
});
