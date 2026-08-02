/**
 * needs_revision/pending_verification are meant to be resolved by the same
 * staging session (see stagedIntents.ts's group-commit guard). Once that
 * session goes terminal with blocked members still outstanding, they become
 * unreachable — no live session to supersede them, and both states are
 * excluded from the operator-facing decision surface. markTerminal (the
 * shared terminal hook for every PlanningOrchestrator-driven exit) must
 * raise a needs-attention pause reason against the target task in that case.
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

const SESSION_ID = 'session-blocked-1';
const TASK_ID = 'task-blocked-1';

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

describe('PlanningOrchestrator — escalate outstanding blocked members on session terminal', () => {
  it('raises planning_terminal_blocked_members naming the task when a needs_revision member is still outstanding', () => {
    seedSession();
    stageIntent({ state: 'needs_revision' });
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    orchestrator.endSession(SESSION_ID);

    const paused = getTaskPauseReason(TASK_ID);
    expect(paused?.reason).toBe('planning_terminal_blocked_members');
    expect(paused?.severity).toBe('needs_attention');
    expect(paused?.detail).toContain('intent-1');
  });

  it('raises the same escalation for a pending_verification member', () => {
    seedSession();
    stageIntent({ state: 'pending_verification' });
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    orchestrator.endSession(SESSION_ID);

    const paused = getTaskPauseReason(TASK_ID);
    expect(paused?.reason).toBe('planning_terminal_blocked_members');
  });

  it('does not raise a pause reason when the session has no blocked members', () => {
    seedSession();
    stageIntent({ state: 'committed' });
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    orchestrator.endSession(SESSION_ID);

    expect(getTaskPauseReason(TASK_ID)).toBeNull();
  });
});
