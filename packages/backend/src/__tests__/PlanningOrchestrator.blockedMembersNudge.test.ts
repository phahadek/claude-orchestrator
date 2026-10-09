/**
 * Coverage for the resumable-blocked-members nudge: a planning session that
 * ends its turn while a live, resumable process still exists and its own
 * staged intents sit at needs_revision/pending_verification is re-engaged
 * with a bounded nudge naming those intent ids, instead of being left idle
 * forever (the gap surfaceBlockedMembersPauseReason cannot see, since it
 * only fires once the session is terminal or has no live process — see
 * PlanningOrchestrator.blockedMembersEscalation.test.ts for that leg).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../db/db', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db/db';
import {
  insertSession,
  insertStagedIntent,
  getSession,
  getTaskPauseReason,
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

const SESSION_ID = 'session-blocked-nudge-1';
const TASK_ID = 'task-blocked-nudge-1';

function seedSession(sessionId = SESSION_ID, sessionType = 'groom'): void {
  insertSession({
    session_id: sessionId,
    task_id: TASK_ID,
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
    payload: JSON.stringify({ taskId: TASK_ID, sections: {} }),
    payload_hash: `hash-${counter}`,
    task_id: TASK_ID,
    project_id: 'proj-1',
    session_id: SESSION_ID,
    group_id: 'g-blocked',
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
  db.prepare('DELETE FROM task_crash_counts').run();
  db.prepare('DELETE FROM task_pause_reasons').run();
  counter = 0;
});

describe('PlanningOrchestrator.checkTerminal — resumable blocked-members nudge', () => {
  it('re-engages a session ending its turn with a needs_revision intent, naming the blocked id', () => {
    seedSession();
    const intent = stageIntent({ state: 'needs_revision' });
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    expect(orchestrator.checkTerminal(SESSION_ID)).toBe(false);
    expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(1);
    expect(sessionManager.enqueueFeedback).toHaveBeenCalledWith(
      SESSION_ID,
      expect.any(String),
      expect.stringContaining(intent.id),
    );
    expect(sessionManager.endSession).not.toHaveBeenCalled();
    expect(getSession(SESSION_ID)?.status).toBe('running');
    expect(getTaskPauseReason(TASK_ID)).toBeNull();
  });

  it('the nudge names both supersede and withdraw-group-then-noOp', () => {
    seedSession();
    stageIntent({ state: 'needs_revision' });
    const sessionManager = makeSessionManager();
    new PlanningOrchestrator(sessionManager).checkTerminal(SESSION_ID);
    const message = sessionManager.enqueueFeedback.mock.calls[0][2] as string;
    expect(message).toContain('supersede');
    expect(message).toContain('withdraw the whole group');
    expect(message).toContain('planning.noOp');
  });

  it('sends no blocked-members nudge once every blocked member is withdrawn', () => {
    seedSession();
    const a = stageIntent({ state: 'withdrawn' });
    const b = stageIntent({ state: 'withdrawn' });
    const sessionManager = makeSessionManager();
    new PlanningOrchestrator(sessionManager).checkTerminal(SESSION_ID);
    for (const call of sessionManager.enqueueFeedback.mock.calls) {
      expect(call[2]).not.toContain(a.id);
      expect(call[2]).not.toContain(b.id);
      expect(call[2]).not.toContain('needs_revision/pending_verification');
    }
  });

  it('re-engages a session ending its turn with a pending_verification intent, naming the blocked id', () => {
    seedSession();
    const intent = stageIntent({ state: 'pending_verification' });
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    expect(orchestrator.checkTerminal(SESSION_ID)).toBe(false);
    expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(1);
    expect(sessionManager.enqueueFeedback).toHaveBeenCalledWith(
      SESSION_ID,
      expect.any(String),
      expect.stringContaining(intent.id),
    );
    expect(getTaskPauseReason(TASK_ID)).toBeNull();
  });

  it('is bounded — the same blocked-intent set is not nudged twice', () => {
    seedSession();
    stageIntent({ state: 'needs_revision' });
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    // Turn 1: nudged. Turn 2 (the nudge's own re-turn, same unresolved
    // set): budget exhausted, escalates to terminal instead of nudging
    // again — this is the same session, called only while it is still
    // resumable (production never calls checkTerminal again once terminal).
    orchestrator.checkTerminal(SESSION_ID);
    orchestrator.checkTerminal(SESSION_ID);

    expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(1);
  });

  it('once the nudge budget is exhausted, surfaces planning_terminal_blocked_members as it does today', () => {
    seedSession(SESSION_ID, 'design');
    stageIntent({ state: 'needs_revision' });
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    // Turn 1: nudged, stays parked (not terminal).
    expect(orchestrator.checkTerminal(SESSION_ID)).toBe(false);
    expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(1);
    expect(getTaskPauseReason(TASK_ID)).toBeNull();

    // Turn 2 (the nudge's own re-turn): same blocked set, still unresolved —
    // budget exhausted, so the pause is surfaced but the session stays
    // non-terminal so the operator can still push back.
    expect(orchestrator.checkTerminal(SESSION_ID)).toBe(false);
    expect(sessionManager.endSession).not.toHaveBeenCalled();
    expect(getSession(SESSION_ID)?.status).toBe('running');
    // Still bounded: no second nudge.
    expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(1);

    const paused = getTaskPauseReason(TASK_ID);
    expect(paused?.reason).toBe('planning_terminal_blocked_members');
    expect(paused?.severity).toBe('needs_attention');
  });

  it('regression: a session ending a turn with no blocked intents is not nudged', () => {
    seedSession();
    const intent = stageIntent({ state: 'staged' });
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    orchestrator.checkTerminal(SESSION_ID); // prime the staged-count snapshot
    db.prepare(`UPDATE staged_intent SET state = 'committed' WHERE id = ?`).run(
      intent.id,
    );

    expect(orchestrator.checkTerminal(SESSION_ID)).toBe(true);
    expect(sessionManager.enqueueFeedback).not.toHaveBeenCalled();
    expect(sessionManager.endSession).toHaveBeenCalledWith(SESSION_ID);
    expect(getTaskPauseReason(TASK_ID)).toBeNull();
  });
});
