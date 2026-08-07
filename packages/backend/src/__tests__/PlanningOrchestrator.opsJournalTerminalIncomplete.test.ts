/**
 * Coverage for the ops-journal terminal backstop: a dispatched ops
 * (Operational/Investigation) session that stages an ops_journal
 * transition (which already counts as "a staged decision" — see
 * hasStagedDecision) reaches terminal via checkTerminal's normal path even
 * when the journal is left mid-flight at an intermediate waypoint
 * (pending/candidate/staged-proposal/applied-pending-confirm). Nothing
 * previously required the journal to actually reach a terminal state
 * (resolved) or an explicit blocked before the session concluded — see the
 * task write-up's worked instance (3b022f91-52f3-8121). checkTerminal now
 * nudges such a session to continue, once, before letting it settle.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';
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
  upsertTaskCache,
} from '../db/queries';
import { upsertOpsJournalEntry } from '../db/queries';
import type { StagedIntentRow, OpsJournalRow, OpsJournalState } from '../db/types';
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
const TASK_ID = 'task-1';

function seedSession(
  sessionId = SESSION_ID,
  sessionType = 'ops',
  taskId = TASK_ID,
): void {
  insertSession({
    session_id: sessionId,
    task_id: taskId,
    task_url: `https://notion.so/${taskId}`,
    project_context_url: 'https://notion.so/ctx',
    status: 'running',
    started_at: Date.now(),
    session_type: sessionType,
  });
}

function seedJournal(state: OpsJournalState, taskId = TASK_ID): void {
  const row: OpsJournalRow = {
    task_id: taskId,
    project: 'proj-1',
    milestone: 'M1',
    state,
    disposition: null,
    worked_in: null,
    evidence: null,
    finding_or_proposal: null,
    falsification: null,
    filed_followons: null,
    needs_from_operator: null,
    resolution: null,
    updated_at: new Date().toISOString(),
  };
  upsertOpsJournalEntry(row);
}

function seedTaskType(type: string, taskId = TASK_ID): void {
  upsertTaskCache(taskId, JSON.stringify({ type }));
}

let counter = 0;
function stageJournalSetStateIntent(
  taskId = TASK_ID,
  sessionId = SESSION_ID,
  overrides: Partial<StagedIntentRow> = {},
): StagedIntentRow {
  counter += 1;
  const now = Date.now();
  const row: StagedIntentRow = {
    id: `intent-${counter}`,
    kind: 'journal.setState',
    payload: JSON.stringify({ taskId, state: 'candidate' }),
    payload_hash: `hash-${counter}`,
    task_id: taskId,
    project_id: 'proj-1',
    session_id: sessionId,
    group_id: null,
    milestone: null,
    state: 'committed',
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
  db.prepare('DELETE FROM ops_journal').run();
  db.prepare('DELETE FROM task_cache').run();
  db.prepare('DELETE FROM task_pause_reasons').run();
  counter = 0;
});

describe('PlanningOrchestrator.checkTerminal — ops-journal-incomplete backstop', () => {
  it.each(['candidate', 'staged-proposal'] as const)(
    'nudges instead of settling when the journal is at %s (Investigation)',
    (state) => {
      seedSession();
      seedTaskType('🔎 Investigation');
      seedJournal(state);
      const sessionManager = makeSessionManager();
      const orchestrator = new PlanningOrchestrator(sessionManager);

      stageJournalSetStateIntent();
      orchestrator.checkTerminal(SESSION_ID); // primes the staged-count snapshot
      const terminal = orchestrator.checkTerminal(SESSION_ID);

      expect(terminal).toBe(false);
      expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(1);
      expect(sessionManager.enqueueFeedback).toHaveBeenCalledWith(
        SESSION_ID,
        expect.any(String),
        expect.stringContaining(state),
      );
      expect(sessionManager.endSession).not.toHaveBeenCalled();
      expect(getTaskPauseReason(TASK_ID)).toBeNull();
    },
  );

  it('the nudge is bounded — sent at most once per session', () => {
    seedSession();
    seedTaskType('🔎 Investigation');
    seedJournal('candidate');
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    stageJournalSetStateIntent();
    orchestrator.checkTerminal(SESSION_ID); // primes the staged-count snapshot
    // Turn 1: nudged.
    expect(orchestrator.checkTerminal(SESSION_ID)).toBe(false);
    expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(1);

    // Turn 2 (the nudge's re-turn): journal still incomplete — settles
    // rather than nudging again, and surfaces a needs-attention pause.
    expect(orchestrator.checkTerminal(SESSION_ID)).toBe(true);
    expect(sessionManager.endSession).toHaveBeenCalledWith(SESSION_ID);
    expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(1);

    const paused = getTaskPauseReason(TASK_ID);
    expect(paused?.reason).toBe('ops_journal_terminal_incomplete');
    expect(paused?.severity).toBe('needs_attention');
  });

  it('concludes cleanly with no nudge when the journal reached blocked', () => {
    seedSession();
    seedTaskType('🔎 Investigation');
    seedJournal('blocked');
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    stageJournalSetStateIntent(TASK_ID, SESSION_ID, {
      payload: JSON.stringify({ taskId: TASK_ID, state: 'blocked' }),
    });

    orchestrator.checkTerminal(SESSION_ID); // primes the staged-count snapshot
    expect(orchestrator.checkTerminal(SESSION_ID)).toBe(true);
    expect(sessionManager.endSession).toHaveBeenCalledWith(SESSION_ID);
    expect(sessionManager.enqueueFeedback).not.toHaveBeenCalled();
    expect(getTaskPauseReason(TASK_ID)).toBeNull();
  });

  it('concludes cleanly for an Investigation whose journal reached resolved', () => {
    seedSession();
    seedTaskType('🔎 Investigation');
    seedJournal('resolved');
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    stageJournalSetStateIntent(TASK_ID, SESSION_ID, {
      payload: JSON.stringify({ taskId: TASK_ID, state: 'resolved' }),
    });

    orchestrator.checkTerminal(SESSION_ID); // primes the staged-count snapshot
    expect(orchestrator.checkTerminal(SESSION_ID)).toBe(true);
    expect(sessionManager.endSession).toHaveBeenCalledWith(SESSION_ID);
    expect(sessionManager.enqueueFeedback).not.toHaveBeenCalled();
    expect(getTaskPauseReason(TASK_ID)).toBeNull();
  });

  it('concludes cleanly for an Operational run whose journal reached applied-pending-confirm', () => {
    seedSession();
    seedTaskType('🔧 Operational');
    seedJournal('applied-pending-confirm');
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    stageJournalSetStateIntent(TASK_ID, SESSION_ID, {
      payload: JSON.stringify({
        taskId: TASK_ID,
        state: 'applied-pending-confirm',
      }),
    });

    orchestrator.checkTerminal(SESSION_ID); // primes the staged-count snapshot
    expect(orchestrator.checkTerminal(SESSION_ID)).toBe(true);
    expect(sessionManager.endSession).toHaveBeenCalledWith(SESSION_ID);
    expect(sessionManager.enqueueFeedback).not.toHaveBeenCalled();
    expect(getTaskPauseReason(TASK_ID)).toBeNull();
  });

  it('nudges an Operational run still at staged-proposal — not yet its own type-appropriate terminal', () => {
    seedSession();
    seedTaskType('🔧 Operational');
    seedJournal('staged-proposal');
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    stageJournalSetStateIntent();

    orchestrator.checkTerminal(SESSION_ID); // primes the staged-count snapshot
    expect(orchestrator.checkTerminal(SESSION_ID)).toBe(false);
    expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(1);
    expect(sessionManager.endSession).not.toHaveBeenCalled();
  });

  it('regression: a session on a task with no ops_journal entry is unaffected', () => {
    seedSession();
    seedTaskType('🔎 Investigation');
    // No seedJournal() call — no ops_journal row exists for this task.
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    stageJournalSetStateIntent();

    orchestrator.checkTerminal(SESSION_ID); // primes the staged-count snapshot
    expect(orchestrator.checkTerminal(SESSION_ID)).toBe(true);
    expect(sessionManager.endSession).toHaveBeenCalledWith(SESSION_ID);
    expect(sessionManager.enqueueFeedback).not.toHaveBeenCalled();
    expect(getTaskPauseReason(TASK_ID)).toBeNull();
  });

  it('regression: a groom session (non-ops) with an intermediate journal entry is unaffected', () => {
    seedSession(SESSION_ID, 'groom');
    seedTaskType('🔎 Investigation');
    seedJournal('candidate');
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    counter += 1;
    insertStagedIntent({
      id: `intent-${counter}`,
      kind: 'task.setStatus',
      payload: JSON.stringify({ taskId: TASK_ID, status: 'Ready' }),
      payload_hash: `hash-${counter}`,
      task_id: TASK_ID,
      project_id: 'proj-1',
      session_id: SESSION_ID,
      group_id: null,
      milestone: null,
      state: 'committed',
      supersedes: null,
      annotation: null,
      decision_proposal: null,
      groom_proposal: null,
      advisory: null,
      disposition_reason: null,
      answer: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    });

    orchestrator.checkTerminal(SESSION_ID); // primes the staged-count snapshot
    expect(orchestrator.checkTerminal(SESSION_ID)).toBe(true);
    expect(sessionManager.endSession).toHaveBeenCalledWith(SESSION_ID);
    expect(sessionManager.enqueueFeedback).not.toHaveBeenCalled();
    expect(getTaskPauseReason(TASK_ID)).toBeNull();
  });
});
