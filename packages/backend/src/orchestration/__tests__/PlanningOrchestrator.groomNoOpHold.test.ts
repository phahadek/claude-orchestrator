import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn(),
}));

import { db } from '../../db/db';
import {
  insertSession,
  insertStagedIntent,
  getSession,
} from '../../db/queries';
import type { StagedIntentRow } from '../../db/types';
import { PlanningOrchestrator } from '../PlanningOrchestrator';
import {
  isGroomNoOpAwaitingOperator,
  groomSessionConcludedWithDecision,
} from '../planningDecisionKinds';
import type { SessionManager } from '../../session/SessionManager';

function makeSessionManager() {
  return Object.assign(new EventEmitter(), {
    enqueueFeedback: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn(),
    getLiveSession: vi.fn().mockReturnValue(undefined),
  }) as unknown as SessionManager;
}

const SESSION_ID = 'groom-session-1';
const TASK_ID = 'task-1';

function seedSession(sessionType = 'groom'): void {
  insertSession({
    session_id: SESSION_ID,
    task_id: TASK_ID,
    task_url: 'https://notion.so/task-1',
    project_context_url: 'https://notion.so/ctx',
    status: 'running',
    started_at: Date.now(),
    session_type: sessionType,
    project_id: null,
  });
}

function stageNoOp(overrides: Partial<StagedIntentRow> = {}): StagedIntentRow {
  const now = Date.now();
  const row: StagedIntentRow = {
    id: 'noop-1',
    kind: 'planning.noOp',
    payload: JSON.stringify({ taskId: TASK_ID, reason: 'nothing to do' }),
    payload_hash: 'hash-noop',
    task_id: TASK_ID,
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
  db.prepare('DELETE FROM task_pause_reasons').run();
});

describe('isGroomNoOpAwaitingOperator', () => {
  const base = { kind: 'planning.noOp', group_id: null, state: 'staged' };
  it('is true only for a standalone staged noOp from a groom session', () => {
    expect(isGroomNoOpAwaitingOperator(base as never, 'groom')).toBe(true);
    expect(isGroomNoOpAwaitingOperator(base as never, 'design')).toBe(false);
    expect(
      isGroomNoOpAwaitingOperator({ ...base, group_id: 'g' } as never, 'groom'),
    ).toBe(false);
    expect(
      isGroomNoOpAwaitingOperator({ ...base, state: 'committed' } as never, 'groom'),
    ).toBe(false);
    expect(
      isGroomNoOpAwaitingOperator({ ...base, kind: 'task.create' } as never, 'groom'),
    ).toBe(false);
  });
});

describe('groom session holds open on a staged standalone noOp', () => {
  it('checkTerminal returns false and the session is not marked done', () => {
    seedSession();
    stageNoOp();
    const orchestrator = new PlanningOrchestrator(makeSessionManager());
    expect(orchestrator.checkTerminal(SESSION_ID)).toBe(false);
    expect(getSession(SESSION_ID)?.status).not.toBe('done');
  });

  it('markTerminal refuses for any reason except planning_operator_end', () => {
    seedSession();
    stageNoOp();
    const orchestrator = new PlanningOrchestrator(makeSessionManager());
    const markTerminal = (
      orchestrator as unknown as {
        markTerminal: (id: string, reason: string) => boolean;
      }
    ).markTerminal.bind(orchestrator);
    expect(markTerminal(SESSION_ID, 'planning_no_pending_dispositions')).toBe(
      false,
    );
    expect(markTerminal(SESSION_ID, 'planning_approved')).toBe(false);
    expect(getSession(SESSION_ID)?.status).not.toBe('done');
  });

  it('isSessionCompleteForIdleSweep reports not_ready', () => {
    seedSession();
    stageNoOp();
    const orchestrator = new PlanningOrchestrator(makeSessionManager());
    const verdict = (
      orchestrator as unknown as {
        isSessionCompleteForIdleSweep: (id: string) => unknown;
      }
    ).isSessionCompleteForIdleSweep(SESSION_ID);
    expect(verdict).toBe('not_ready');
  });

  it('the clean-exit fast path does not conclude the session', () => {
    seedSession();
    stageNoOp();
    expect(groomSessionConcludedWithDecision(SESSION_ID)).toBe(false);
  });

  it('after acknowledge (committed) the recheck terminalizes the session', () => {
    seedSession();
    stageNoOp();
    const orchestrator = new PlanningOrchestrator(makeSessionManager());
    db.prepare(`UPDATE staged_intent SET state = 'committed'`).run();
    expect(orchestrator.recheckTerminalAfterNoOpAcknowledge(SESSION_ID)).toBe(
      true,
    );
    const row = db
      .prepare(
        'SELECT terminal_completion_reason FROM sessions WHERE session_id = ?',
      )
      .get(SESSION_ID) as { terminal_completion_reason: string | null };
    expect(row.terminal_completion_reason).toBe(
      'planning_no_pending_dispositions',
    );
  });

  it('a design session standalone noOp still terminalizes on staging', () => {
    seedSession('design');
    stageNoOp();
    const orchestrator = new PlanningOrchestrator(makeSessionManager());
    expect(orchestrator.checkTerminal(SESSION_ID)).toBe(true);
  });
});
