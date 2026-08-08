/**
 * A planning session's subprocess exits the instant it parks idle
 * (AgentSession.handleCleanExit) — every idle row already has ended_at set.
 * checkTerminal only re-runs off that same subprocess's own
 * session_ended/result message, so once it's exited it can never fire
 * checkTerminal again: a finished idle session sits holding a
 * countLivePlanningSessions() slot forever. sweepIdleTerminalSessions is the
 * periodic backstop that closes that gap by reusing checkTerminal's own
 * completeness predicate, cold.
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
  updateSessionStatus,
  getSession,
  getTaskPauseReason,
  countLivePlanningSessions,
  archiveConcludedSessionsOlderThan,
} from '../db/queries';
import type { StagedIntentRow } from '../db/types';
import { PlanningOrchestrator } from '../orchestration/PlanningOrchestrator';
import { runtimeSettings } from '../config';
import type { SessionManager } from '../session/SessionManager';

function makeSessionManager(aliveIds: Set<string> = new Set()) {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    enqueueFeedback: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn(),
    getLiveSession: vi.fn().mockReturnValue(undefined),
    isAlive: vi.fn((id: string) => aliveIds.has(id)),
    isProcessAlive: vi.fn((id: string) => aliveIds.has(id)),
  }) as unknown as SessionManager & {
    enqueueFeedback: ReturnType<typeof vi.fn>;
    endSession: ReturnType<typeof vi.fn>;
    getLiveSession: ReturnType<typeof vi.fn>;
    isAlive: ReturnType<typeof vi.fn>;
    isProcessAlive: ReturnType<typeof vi.fn>;
  };
}

const NOW = 10_000_000;
const AGE_FLOOR_MINUTES = 60;
const OLD_ENOUGH = NOW - (AGE_FLOOR_MINUTES + 10) * 60_000;
const TOO_RECENT = NOW - (AGE_FLOOR_MINUTES - 10) * 60_000;

function seedIdleSession(
  sessionId: string,
  opts: { sessionType?: string; taskId?: string; endedAt?: number } = {},
): void {
  const taskId = opts.taskId ?? `task-${sessionId}`;
  insertSession({
    session_id: sessionId,
    task_id: taskId,
    task_url: `https://notion.so/${taskId}`,
    project_context_url: 'https://notion.so/ctx',
    status: 'running',
    started_at: NOW - 500_000,
    session_type: opts.sessionType ?? 'groom',
  });
  updateSessionStatus(sessionId, 'idle', opts.endedAt ?? OLD_ENOUGH);
}

let counter = 0;
function stageIntent(
  sessionId: string,
  overrides: Partial<StagedIntentRow> = {},
): StagedIntentRow {
  counter += 1;
  const now = Date.now();
  const row: StagedIntentRow = {
    id: `intent-${counter}`,
    kind: 'task.setStatus',
    payload: JSON.stringify({ taskId: `task-${sessionId}`, status: 'Ready' }),
    payload_hash: `hash-${counter}`,
    task_id: `task-${sessionId}`,
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
  db.prepare('DELETE FROM task_pause_reasons').run();
  counter = 0;
  runtimeSettings.idle_planning_terminal_sweep_enabled = true;
  runtimeSettings.idle_planning_terminal_sweep_age_floor_minutes =
    AGE_FLOOR_MINUTES;
  runtimeSettings.idle_planning_terminal_sweep_interval_minutes = 30;
});

describe('PlanningOrchestrator.sweepIdleTerminalSessions', () => {
  it('terminalizes a finished idle session past the age floor and emits an audit event', () => {
    seedIdleSession('s-finished');
    stageIntent('s-finished');
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    const events = db
      .prepare(`SELECT COUNT(*) as c FROM audit_log WHERE event_type = ?`)
      .get('planning_sessions_idle_swept_terminal') as { c: number };
    expect(events.c).toBe(0);

    const processed = orchestrator.sweepIdleTerminalSessions(() => NOW);
    expect(processed).toBe(1);
    expect(getSession('s-finished')?.status).toBe('done');

    const after = db
      .prepare(`SELECT COUNT(*) as c FROM audit_log WHERE event_type = ?`)
      .get('planning_sessions_idle_swept_terminal') as { c: number };
    expect(after.c).toBe(1);
  });

  it('does not terminalize and instead sets the blocked-member pause reason for a needs_revision intent', () => {
    seedIdleSession('s-needs-revision');
    stageIntent('s-needs-revision', { state: 'needs_revision' });
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    const processed = orchestrator.sweepIdleTerminalSessions(() => NOW);
    expect(processed).toBe(0);
    expect(getSession('s-needs-revision')?.status).toBe('idle');

    const paused = getTaskPauseReason('task-s-needs-revision');
    expect(paused?.reason).toBe('planning_terminal_blocked_members');
  });

  it('does not terminalize and instead sets the blocked-member pause reason for a pending_verification intent', () => {
    seedIdleSession('s-pending-verification');
    stageIntent('s-pending-verification', { state: 'pending_verification' });
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    const processed = orchestrator.sweepIdleTerminalSessions(() => NOW);
    expect(processed).toBe(0);
    expect(getSession('s-pending-verification')?.status).toBe('idle');

    const paused = getTaskPauseReason('task-s-pending-verification');
    expect(paused?.reason).toBe('planning_terminal_blocked_members');
  });

  it('does not terminalize a session with an outstanding session.requestCapability intent', () => {
    seedIdleSession('s-capability');
    stageIntent('s-capability', {
      kind: 'session.requestCapability',
      state: 'staged',
      payload: JSON.stringify({ capability: 'Bash(npm run *)' }),
    });
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    const processed = orchestrator.sweepIdleTerminalSessions(() => NOW);
    expect(processed).toBe(0);
    expect(getSession('s-capability')?.status).toBe('idle');
  });

  it('does not terminalize a design session that still owes a gated design artifact', () => {
    seedIdleSession('s-owes-artifact', { sessionType: 'design' });
    stageIntent('s-owes-artifact', {
      kind: 'completeness.disposition',
      state: 'committed',
      payload: JSON.stringify({
        taskId: 'task-s-owes-artifact',
        rowId: 1,
        project: null,
        milestone: null,
        probed: [],
        questions: [],
        runAt: new Date(NOW).toISOString(),
      }),
    });
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    const processed = orchestrator.sweepIdleTerminalSessions(() => NOW);
    expect(processed).toBe(0);
    expect(getSession('s-owes-artifact')?.status).toBe('idle');
  });

  it('never terminalizes a session whose subprocess is still live in-memory, regardless of age', () => {
    seedIdleSession('s-live', { endedAt: NOW - 1000 * 60 * 60 * 24 * 30 });
    stageIntent('s-live');
    const sessionManager = makeSessionManager(new Set(['s-live']));
    const orchestrator = new PlanningOrchestrator(sessionManager);

    const processed = orchestrator.sweepIdleTerminalSessions(() => NOW);
    expect(processed).toBe(0);
    expect(getSession('s-live')?.status).toBe('idle');
  });

  it('does not sweep a session below the configured age floor even though it otherwise satisfies the completeness predicate', () => {
    seedIdleSession('s-too-recent', { endedAt: TOO_RECENT });
    stageIntent('s-too-recent');
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    const processed = orchestrator.sweepIdleTerminalSessions(() => NOW);
    expect(processed).toBe(0);
    expect(getSession('s-too-recent')?.status).toBe('idle');
  });

  it('sweep-then-archive: countLivePlanningSessions excludes a swept session, and archiveConcludedSessionsOlderThan then reclaims it', () => {
    seedIdleSession('s-sweep-archive');
    stageIntent('s-sweep-archive');
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    expect(countLivePlanningSessions()).toBe(1);
    orchestrator.sweepIdleTerminalSessions(() => NOW);
    expect(getSession('s-sweep-archive')?.status).toBe('done');
    expect(countLivePlanningSessions()).toBe(0);

    const archived = archiveConcludedSessionsOlderThan(Date.now() + 1000);
    expect(archived).toContain('s-sweep-archive');
  });

  it('archiveConcludedSessionsOlderThan still refuses to archive any session at idle (existing guard untouched)', () => {
    seedIdleSession('s-still-idle');
    stageIntent('s-still-idle', { state: 'staged' });
    // Deliberately never swept — still idle with a pending disposition.
    const archived = archiveConcludedSessionsOlderThan(NOW + 1);
    expect(archived).not.toContain('s-still-idle');
    expect(getSession('s-still-idle')?.status).toBe('idle');
  });
});
