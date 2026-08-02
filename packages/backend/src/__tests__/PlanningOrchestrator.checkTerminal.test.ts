/**
 * Coverage for the terminal-detection gap: checkTerminal previously compared
 * the live staged-intent count against a snapshot taken only at disposition
 * time, so a session whose final act was a resumed turn that staged nothing
 * new (rather than an operator apply) could strand in 'idle' forever — see
 * the Deferred-vs-Ready asymmetry in the task write-up. checkTerminal now
 * self-refreshes its snapshot on every non-terminal call (i.e. every park),
 * making terminality independent of which path triggered the resume.
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
  applyPendingDone,
} from '../db/queries';
import type { StagedIntentRow } from '../db/types';
import { PlanningOrchestrator } from '../orchestration/PlanningOrchestrator';
import type { SessionManager } from '../session/SessionManager';

function makeSessionManager() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    enqueueFeedback: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn(),
    getLiveSession: vi.fn().mockReturnValue(undefined),
  }) as unknown as SessionManager & {
    enqueueFeedback: ReturnType<typeof vi.fn>;
    endSession: ReturnType<typeof vi.fn>;
    getLiveSession: ReturnType<typeof vi.fn>;
  };
}

const SESSION_ID = 'session-1';

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
    kind: 'task.setStatus',
    payload: JSON.stringify({ taskId: 'task-1', status: 'Ready' }),
    payload_hash: `hash-${counter}`,
    task_id: 'task-1',
    project_id: 'proj-1',
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
  db.prepare('DELETE FROM sessions').run();
  counter = 0;
});

describe('PlanningOrchestrator.checkTerminal', () => {
  it('reaches terminal once a session’s only intent is a committed Deferred task.setStatus with nothing staged', () => {
    seedSession();
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    const intent = stageIntent({
      payload: JSON.stringify({ taskId: 'task-1', status: 'Deferred' }),
    });
    // First park: the intent is still awaiting disposition.
    expect(orchestrator.checkTerminal(SESSION_ID)).toBe(false);

    transitionStagedIntent(intent.id, 'committed');
    expect(orchestrator.checkTerminal(SESSION_ID)).toBe(true);
    // The session's DB status is still 'running' at this point — markTerminal
    // defers the running→done write (markSessionDone's in-flight guard)
    // since it can't tell this call apart from a turn genuinely still in
    // flight. The done-transition is only actually applied once the turn
    // settles (applyPendingDone), which the caller does after the subprocess
    // exits.
    expect(getSession(SESSION_ID)?.status).toBe('running');
    expect(applyPendingDone(SESSION_ID)).toBe(true);
    expect(getSession(SESSION_ID)?.status).toBe('done');
  });

  it('reaches terminal directly on the approval that completes the mandate — no resume', async () => {
    seedSession();
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    // Turn 1: session stages one intent.
    const intent1 = stageIntent();
    expect(orchestrator.checkTerminal(SESSION_ID)).toBe(false);

    // Operator pushback resumes the session.
    const rejected1 = transitionStagedIntent(intent1.id, 'rejected', {
      dispositionReason: 'needs work',
    });
    await orchestrator.handleDisposition({
      intent: rejected1,
      disposition: 'pushback',
      reason: 'needs work',
    });

    // Turn 2: session re-stages a single corrected intent.
    const intent2 = stageIntent();
    expect(orchestrator.checkTerminal(SESSION_ID)).toBe(false);

    // Operator approves the corrected intent — this is the group/single apply
    // route's job in production (transition then handleDisposition). Since
    // nothing else is staged for the session, the approval itself drives the
    // session terminal directly — no further resume, no separate park needed.
    const committed2 = transitionStagedIntent(intent2.id, 'committed');
    await orchestrator.handleDisposition({
      intent: committed2,
      disposition: 'approve',
    });

    expect(getSession(SESSION_ID)?.status).toBe('done');
    // Only the earlier pushback resumed the session — the completing
    // approval did not.
    expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(1);
  });

  it('the Ready path still reaches terminal (unregressed)', () => {
    seedSession();
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    const intents = [stageIntent(), stageIntent(), stageIntent()];
    expect(orchestrator.checkTerminal(SESSION_ID)).toBe(false);

    for (const intent of intents) {
      transitionStagedIntent(intent.id, 'committed');
    }
    expect(orchestrator.checkTerminal(SESSION_ID)).toBe(true);
    // Deferred, same as the Deferred-path case above — status flips to
    // 'done' only once the turn settles.
    expect(getSession(SESSION_ID)?.status).toBe('running');
    expect(applyPendingDone(SESSION_ID)).toBe(true);
    expect(getSession(SESSION_ID)?.status).toBe('done');
  });

  it('does not terminate a session with a staged intent still awaiting disposition', () => {
    seedSession();
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    stageIntent();
    expect(orchestrator.checkTerminal(SESSION_ID)).toBe(false);
    expect(getSession(SESSION_ID)?.status).toBe('running');
    // A session parked idle awaiting an operator disposition is genuinely
    // resumable by design — it must not be ended just because it's idle.
    expect(sessionManager.endSession).not.toHaveBeenCalled();
  });

  it('does not terminate a session awaiting a capability grant', () => {
    seedSession();
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    stageIntent({
      kind: 'session.requestCapability',
      payload: JSON.stringify({ capability: 'Bash(npm run *)' }),
    });
    expect(orchestrator.checkTerminal(SESSION_ID)).toBe(false);
    expect(getSession(SESSION_ID)?.status).toBe('running');
  });

  it('releases the planning-concurrency slot when a session is driven to terminal', () => {
    seedSession();
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    const intent = stageIntent({
      payload: JSON.stringify({ taskId: 'task-1', status: 'Deferred' }),
    });
    orchestrator.checkTerminal(SESSION_ID); // prime the snapshot at first park
    transitionStagedIntent(intent.id, 'committed');

    expect(orchestrator.checkTerminal(SESSION_ID)).toBe(true);
    expect(sessionManager.endSession).toHaveBeenCalledWith(SESSION_ID);
  });
});
