/**
 * An ops-terminal closing group (journal.setState -> "resolved" +
 * task-body write / follow-on task.create) can legitimately be committed
 * across more than one apply, and a session can reach terminal before ever
 * staging the rest of it — group-commit's own precheck
 * (checkOpsTerminalGroupCompleteness in stagedIntents.ts) only catches the
 * case where the missing member is staged together with a live one. This is
 * the session-terminal backstop: markTerminal (the shared terminal hook for
 * every PlanningOrchestrator-driven exit) must raise a needs-attention pause
 * reason against the target task when an ops session goes terminal with an
 * ops-terminal group that never got its resolved transition — the worked
 * instance this guards against left an Investigation's journal stuck at
 * `candidate` forever with the task parked at In Progress.
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
  upsertOpsJournalEntry,
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

const SESSION_ID = 'session-ops-incomplete-1';
const TASK_ID = 'notion:task-ops-incomplete-1';

function seedSession(
  sessionId = SESSION_ID,
  taskId = TASK_ID,
  sessionType = 'ops',
): void {
  insertSession({
    session_id: sessionId,
    task_id: taskId,
    task_url: 'https://notion.so/task-1',
    project_context_url: 'https://notion.so/ctx',
    status: 'running',
    started_at: Date.now(),
    session_type: sessionType,
  });
}

function seedJournal(taskId: string, state: string): void {
  upsertOpsJournalEntry({
    task_id: taskId,
    project: 'proj-1',
    milestone: 'M1',
    state: state as any,
    disposition: null,
    worked_in: null,
    evidence: null,
    finding_or_proposal: null,
    falsification: null,
    filed_followons: null,
    needs_from_operator: null,
    resolution: null,
    updated_at: new Date().toISOString(),
  });
}

let counter = 0;
function stageRow(overrides: Partial<StagedIntentRow> = {}): StagedIntentRow {
  counter += 1;
  const now = Date.now();
  const row: StagedIntentRow = {
    id: `intent-ops-${counter}`,
    kind: 'task.create',
    payload: JSON.stringify({ title: 'Follow-on', body: 'x' }),
    payload_hash: `hash-${counter}`,
    task_id: null,
    project_id: 'proj-1',
    session_id: SESSION_ID,
    group_id: 'g-ops-close',
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
  db.prepare('DELETE FROM task_pause_reasons').run();
  counter = 0;
});

describe('PlanningOrchestrator — surface an ops session going terminal with an incomplete closing group', () => {
  it('raises ops_terminal_group_incomplete naming the group when the session ends with only a follow-on task.create committed — the worked-instance bug', () => {
    seedSession();
    seedJournal(TASK_ID, 'candidate');
    stageRow({
      kind: 'task.create',
      group_id: 'g-ops-close',
      state: 'committed',
    });
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    orchestrator.endSession(SESSION_ID);

    const paused = getTaskPauseReason(TASK_ID);
    expect(paused?.reason).toBe('ops_terminal_group_incomplete');
    expect(paused?.severity).toBe('needs_attention');
    expect(paused?.detail).toContain('g-ops-close');
  });

  it('does not raise a pause reason when the group also carries the journal.setState -> resolved member', () => {
    seedSession();
    seedJournal(TASK_ID, 'resolved');
    stageRow({
      kind: 'task.create',
      group_id: 'g-ops-close',
      state: 'committed',
    });
    stageRow({
      kind: 'journal.setState',
      payload: JSON.stringify({ taskId: TASK_ID, state: 'resolved' }),
      group_id: 'g-ops-close',
      state: 'committed',
      task_id: TASK_ID,
    });
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    orchestrator.endSession(SESSION_ID);

    expect(getTaskPauseReason(TASK_ID)).toBeNull();
  });

  it('does not raise a pause reason for a non-ops session (e.g. groom) with the same incomplete group shape', () => {
    seedSession(SESSION_ID, TASK_ID, 'groom');
    stageRow({
      kind: 'task.create',
      group_id: 'g-ops-close',
      state: 'committed',
    });
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    orchestrator.endSession(SESSION_ID);

    expect(getTaskPauseReason(TASK_ID)).toBeNull();
  });

  it('does not raise a pause reason for a gate-verify ops session (no Notion task to close)', () => {
    seedSession(SESSION_ID, 'gate-item:abc123', 'ops');
    stageRow({
      kind: 'task.create',
      group_id: 'g-ops-close',
      state: 'committed',
    });
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    expect(() => orchestrator.endSession(SESSION_ID)).not.toThrow();
    expect(getTaskPauseReason('gate-item:abc123')).toBeNull();
  });

  it('does not raise a pause reason for an ops session with no groups at all', () => {
    seedSession();
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    orchestrator.endSession(SESSION_ID);

    expect(getTaskPauseReason(TASK_ID)).toBeNull();
  });
});
