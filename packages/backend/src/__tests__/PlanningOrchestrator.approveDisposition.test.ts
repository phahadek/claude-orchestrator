/**
 * Grooming decision 2026-07-26: an approve disposition is acknowledgment,
 * not a decision the originating session needs to act on, so it must never
 * resume the session per intent. A group's approvals only matter to the
 * session once every intent in the group has settled — at that point the
 * session is either driven terminal directly (nothing left to do) or
 * resumed exactly once, coalesced, if other staged work remains. pushback,
 * decline, and answer are unchanged: those are decisions a session's next
 * turn is waiting on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../db/db', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db/db';
import {
  insertSession,
  insertStagedIntent,
  transitionStagedIntent,
  getSession,
} from '../db/queries';
import type { StagedIntentRow } from '../db/types';
import { PlanningOrchestrator } from '../orchestration/PlanningOrchestrator';
import type { SessionManager } from '../session/SessionManager';

function makeSessionManager() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    enqueueFeedback: vi.fn().mockResolvedValue(undefined),
    evictSession: vi.fn(),
  }) as unknown as SessionManager & {
    enqueueFeedback: ReturnType<typeof vi.fn>;
    evictSession: ReturnType<typeof vi.fn>;
  };
}

const SESSION_ID = 'session-approve-1';

function seedSession(sessionId = SESSION_ID, sessionType = 'groom'): void {
  insertSession({
    session_id: sessionId,
    task_id: 'task-1',
    task_url: 'https://notion.so/task-1',
    project_context_url: 'https://notion.so/ctx',
    status: 'running',
    started_at: Date.now(),
    session_type: sessionType,
  });
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
    project_id: 'proj-1',
    session_id: SESSION_ID,
    group_id: null,
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
  db.prepare('DELETE FROM sessions').run();
  counter = 0;
});

describe('PlanningOrchestrator approve disposition', () => {
  it('approving a single intent in a partially-disposed group enqueues no feedback and does not resume', async () => {
    seedSession();
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    const groupId = 'group-1';
    const intentA = stageIntent({ group_id: groupId });
    stageIntent({ group_id: groupId }); // sibling stays staged — group not fully disposed

    const committedA = transitionStagedIntent(intentA.id, 'committed');
    await orchestrator.handleDisposition({
      intent: committedA,
      disposition: 'approve',
    });

    expect(sessionManager.enqueueFeedback).not.toHaveBeenCalled();
    expect(sessionManager.evictSession).not.toHaveBeenCalled();
    expect(getSession(SESSION_ID)?.status).toBe('running');
  });

  it('approving the last intent of a group that completes the mandate drives the session terminal without resuming', async () => {
    seedSession();
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    const groupId = 'group-2';
    const intentA = stageIntent({ group_id: groupId });
    const intentB = stageIntent({ group_id: groupId });
    orchestrator.checkTerminal(SESSION_ID); // prime the snapshot at the session's last park

    const committedA = transitionStagedIntent(intentA.id, 'committed');
    await orchestrator.handleDisposition({
      intent: committedA,
      disposition: 'approve',
    });
    expect(sessionManager.enqueueFeedback).not.toHaveBeenCalled();
    expect(getSession(SESSION_ID)?.status).toBe('running');

    const committedB = transitionStagedIntent(intentB.id, 'committed');
    await orchestrator.handleDisposition({
      intent: committedB,
      disposition: 'approve',
    });

    expect(sessionManager.enqueueFeedback).not.toHaveBeenCalled();
    expect(sessionManager.evictSession).toHaveBeenCalledWith(SESSION_ID);
    expect(getSession(SESSION_ID)?.status).toBe('done');
  });

  it('approving the last intent of a group when other intents remain staged resumes the session exactly once', async () => {
    seedSession();
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    const groupId = 'group-3';
    const intentA = stageIntent({ group_id: groupId });
    const intentB = stageIntent({ group_id: groupId });
    stageIntent({ group_id: null }); // unrelated staged intent, still pending
    orchestrator.checkTerminal(SESSION_ID); // prime the snapshot at the session's last park

    const committedA = transitionStagedIntent(intentA.id, 'committed');
    await orchestrator.handleDisposition({
      intent: committedA,
      disposition: 'approve',
    });
    expect(sessionManager.enqueueFeedback).not.toHaveBeenCalled();

    const committedB = transitionStagedIntent(intentB.id, 'committed');
    await orchestrator.handleDisposition({
      intent: committedB,
      disposition: 'approve',
    });

    expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(1);
    expect(sessionManager.evictSession).not.toHaveBeenCalled();
    expect(getSession(SESSION_ID)?.status).toBe('running');
  });

  it('an approved standalone (ungrouped) intent is its own fully-disposed unit', async () => {
    seedSession();
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    stageIntent({ group_id: null }); // an unrelated pending intent remains
    const intent = stageIntent({ group_id: null });
    orchestrator.checkTerminal(SESSION_ID); // prime the snapshot at the session's last park
    const committed = transitionStagedIntent(intent.id, 'committed');

    await orchestrator.handleDisposition({
      intent: committed,
      disposition: 'approve',
    });

    expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(1);
    const [sessionId, source, message] =
      sessionManager.enqueueFeedback.mock.calls[0];
    expect(sessionId).toBe(SESSION_ID);
    expect(source).toBe('operator-disposition');
    expect(message).toContain('approved and applied');
  });

  it('a pushback still resumes the session with the outcome', async () => {
    seedSession();
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    const intent = stageIntent();
    const rejected = transitionStagedIntent(intent.id, 'rejected', {
      dispositionReason: 'needs work',
    });
    await orchestrator.handleDisposition({
      intent: rejected,
      disposition: 'pushback',
      reason: 'needs work',
    });

    expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(1);
    const [sessionId, source, message] =
      sessionManager.enqueueFeedback.mock.calls[0];
    expect(sessionId).toBe(SESSION_ID);
    expect(source).toBe('operator-disposition');
    expect(message).toMatch(/sent back for revision/i);
  });

  it('a decision.pickOne answer still resumes the session', async () => {
    seedSession();
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    const intent = stageIntent({
      kind: 'decision.pickOne',
      payload: JSON.stringify({
        question: 'Which approach?',
        options: [{ label: 'A', description: 'do A' }],
        allowFreeForm: false,
      }),
    });
    const answered = transitionStagedIntent(intent.id, 'committed', {
      answer: JSON.stringify({ chosenLabel: 'A', freeForm: null }),
    });

    await orchestrator.handleDisposition({
      intent: answered,
      disposition: 'answer',
      answer: { chosenLabel: 'A', freeForm: null },
    });

    expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(1);
    const [, , message] = sessionManager.enqueueFeedback.mock.calls[0];
    expect(message).toContain('"A"');
  });
});
