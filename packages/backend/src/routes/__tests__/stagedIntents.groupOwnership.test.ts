/**
 * A staged-intent groupId belongs to the first session that staged into it,
 * in every state — a finished group's name is never free for another session.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { stageIntent } from '../stagedIntents';
import { transitionStagedIntent } from '../../db/queries';

let taskCounter = 0;

function stage(
  groupId: string | undefined,
  sessionId: string | null,
  explicitSupersedes?: string | null,
) {
  taskCounter += 1;
  return stageIntent(
    'task.setDependsOn',
    { taskId: `own-task-${taskCounter}`, dependsOn: [] },
    'proj-1',
    groupId,
    sessionId,
    null,
    null,
    explicitSupersedes ?? null,
  );
}

beforeEach(() => {
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
});

describe('group ownership across every state', () => {
  it('rejects another session staging into a group whose members are all committed', () => {
    const a = stage('g-committed', 'sess-A');
    transitionStagedIntent(a.id, 'approved');
    transitionStagedIntent(a.id, 'committed');
    expect(() => stage('g-committed', 'sess-B')).toThrow(
      /GroupOwnedByAnotherSessionError|belongs to session "sess-A"/,
    );
  });

  it('rejects another session for rejected, superseded, and withdrawn members', () => {
    const rej = stage('g-rejected', 'sess-A');
    transitionStagedIntent(rej.id, 'rejected');
    expect(() => stage('g-rejected', 'sess-B')).toThrow(/sess-A/);

    const sup = stage('g-superseded', 'sess-A');
    transitionStagedIntent(sup.id, 'superseded');
    expect(() => stage('g-superseded', 'sess-B')).toThrow(/sess-A/);

    const wd = stage('g-withdrawn', 'sess-A');
    transitionStagedIntent(wd.id, 'withdrawn');
    expect(() => stage('g-withdrawn', 'sess-B')).toThrow(/sess-A/);
  });

  it('accepts the owning session staging again once every member is terminal', () => {
    const a = stage('g-own', 'sess-A');
    transitionStagedIntent(a.id, 'rejected');
    expect(() => stage('g-own', 'sess-A')).not.toThrow();
  });

  it('still rejects another session while a live staged member exists', () => {
    stage('g-live', 'sess-A');
    expect(() => stage('g-live', 'sess-B')).toThrow(/sess-A/);
  });

  it('is not applied when no sessionId is supplied', () => {
    stage('g-nosession', 'sess-A');
    expect(() => stage('g-nosession', null)).not.toThrow();
  });

  it('skips the ownership check for a same-session explicitSupersedes', () => {
    const a = stage('g-sup', 'sess-A');
    expect(() => stage('g-sup', 'sess-A', a.id)).not.toThrow();
  });

  it('names the owner and tells the caller to choose a session-unique groupId', () => {
    stage('g-msg', 'sess-A');
    expect(() => stage('g-msg', 'sess-B')).toThrow(
      /sess-A[\s\S]*unique to your own session/,
    );
  });
});
