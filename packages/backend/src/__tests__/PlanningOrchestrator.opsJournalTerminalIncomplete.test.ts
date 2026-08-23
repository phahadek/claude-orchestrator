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
import type {
  StagedIntentRow,
  OpsJournalRow,
  OpsJournalState,
} from '../db/types';
import { PlanningOrchestrator } from '../orchestration/PlanningOrchestrator';
import type { SessionManager } from '../session/SessionManager';
import { normalizeTaskId } from '../tasks/taskId';

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
  // getCachedType normalizes its lookup key (see tasks/taskId.ts) — seed
  // under the same normalized key so the lookup actually hits.
  upsertTaskCache(normalizeTaskId(taskId), JSON.stringify({ type }));
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

/**
 * Coverage for handleApproveDisposition (invoked via handleDisposition with
 * disposition: 'approve') consulting the same incompleteOpsJournalStateFor
 * predicate rather than terminating an ops session by default the moment its
 * group settles. This is the fix for the observed instance in the task
 * write-up: approving a candidate journal.setState terminated the session
 * before it could file its follow-ons and closing intent.
 */
describe('PlanningOrchestrator.handleDisposition — approve consults incompleteOpsJournalStateFor', () => {
  it("approving an Investigation session's journal.setState to candidate resumes the session and does not mark it terminal", async () => {
    seedSession();
    seedTaskType('🔎 Investigation');
    seedJournal('candidate');
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    const intent = stageJournalSetStateIntent(TASK_ID, SESSION_ID, {
      payload: JSON.stringify({ taskId: TASK_ID, state: 'candidate' }),
    });

    await orchestrator.handleDisposition({ intent, disposition: 'approve' });

    expect(sessionManager.endSession).not.toHaveBeenCalled();
    expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(1);
    const [sessionId, , message] = sessionManager.enqueueFeedback.mock
      .calls[0] as [string, string, string];
    expect(sessionId).toBe(SESSION_ID);
    // Names the task Type's own remaining terminal target(s), not a fixed
    // string — an Investigation's set is resolved/blocked, never
    // applied-pending-confirm.
    expect(message).toContain('resolved');
    expect(message).toContain('blocked');
    expect(message).not.toContain('applied-pending-confirm');
  });

  it("approving an Investigation session's journal.setState to resolved does mark it terminal", async () => {
    seedSession();
    seedTaskType('🔎 Investigation');
    seedJournal('resolved');
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    const intent = stageJournalSetStateIntent(TASK_ID, SESSION_ID, {
      payload: JSON.stringify({ taskId: TASK_ID, state: 'resolved' }),
    });

    await orchestrator.handleDisposition({ intent, disposition: 'approve' });

    expect(sessionManager.enqueueFeedback).not.toHaveBeenCalled();
    expect(sessionManager.endSession).toHaveBeenCalledWith(SESSION_ID);
  });

  it("approving an Operational session's journal.setState to applied-pending-confirm marks it terminal, while candidate does not — per-Type terminal sets are respected", async () => {
    // applied-pending-confirm: terminal for Operational.
    seedSession('session-op-1', 'ops', 'task-op-1');
    seedTaskType('🔧 Operational', 'task-op-1');
    seedJournal('applied-pending-confirm', 'task-op-1');
    const smTerminal = makeSessionManager();
    const orchTerminal = new PlanningOrchestrator(smTerminal);
    const terminalIntent = stageJournalSetStateIntent(
      'task-op-1',
      'session-op-1',
      {
        payload: JSON.stringify({
          taskId: 'task-op-1',
          state: 'applied-pending-confirm',
        }),
      },
    );

    await orchTerminal.handleDisposition({
      intent: terminalIntent,
      disposition: 'approve',
    });

    expect(smTerminal.enqueueFeedback).not.toHaveBeenCalled();
    expect(smTerminal.endSession).toHaveBeenCalledWith('session-op-1');

    // candidate: not terminal for Operational — same predicate, different
    // task Type, different outcome.
    seedSession('session-op-2', 'ops', 'task-op-2');
    seedTaskType('🔧 Operational', 'task-op-2');
    seedJournal('candidate', 'task-op-2');
    const smResume = makeSessionManager();
    const orchResume = new PlanningOrchestrator(smResume);
    const resumeIntent = stageJournalSetStateIntent(
      'task-op-2',
      'session-op-2',
      {
        payload: JSON.stringify({ taskId: 'task-op-2', state: 'candidate' }),
      },
    );

    await orchResume.handleDisposition({
      intent: resumeIntent,
      disposition: 'approve',
    });

    expect(smResume.endSession).not.toHaveBeenCalled();
    expect(smResume.enqueueFeedback).toHaveBeenCalledTimes(1);
    const [, , message] = smResume.enqueueFeedback.mock.calls[0] as [
      string,
      string,
      string,
    ];
    // An Operational run's own remaining set includes applied-pending-confirm.
    expect(message).toContain('applied-pending-confirm');
  });

  it('a gate-verify session is unaffected by the ops-journal-incomplete condition', async () => {
    seedSession(SESSION_ID, 'ops', 'gate-item:123');
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    counter += 1;
    const intent = {
      id: `intent-${counter}`,
      kind: 'task.setStatus',
      payload: JSON.stringify({ taskId: 'gate-item:123', status: 'Ready' }),
      payload_hash: `hash-${counter}`,
      task_id: 'gate-item:123',
      project_id: 'proj-1',
      session_id: SESSION_ID,
      group_id: null,
      milestone: null,
      state: 'committed' as const,
      supersedes: null,
      annotation: null,
      decision_proposal: null,
      groom_proposal: null,
      advisory: null,
      disposition_reason: null,
      answer: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    insertStagedIntent(intent);

    await orchestrator.handleDisposition({ intent, disposition: 'approve' });

    expect(sessionManager.enqueueFeedback).not.toHaveBeenCalled();
    expect(sessionManager.endSession).toHaveBeenCalledWith(SESSION_ID);
  });
});
