/**
 * Coverage for the no-staged-decision terminal backstop: a dispatched
 * planning session that reaches terminal (no pending intents, nothing new
 * staged) having staged nothing that counts as a decision — no task-write/
 * arch-write/gate/seed intent, no ops_journal transition, no explicit
 * planning.noOp marker — gets exactly one bounded self-correct re-turn
 * nudge, then, if it still reaches terminal empty, a
 * planning_terminal_no_decision needs-attention pause. See
 * PlanningOrchestrator.checkTerminal.test.ts for the pre-existing
 * terminal-detection (staged-count-snapshot) coverage this backstop sits on
 * top of.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../db/db', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn(),
}));

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
import { getTaskBackend } from '../tasks/TaskBackend';

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
  sessionType = 'groom',
  opts: { projectId?: string } = {},
): void {
  insertSession({
    session_id: sessionId,
    task_id: TASK_ID,
    task_url: 'https://notion.so/task-1',
    project_context_url: 'https://notion.so/ctx',
    status: 'running',
    started_at: Date.now(),
    session_type: sessionType,
    project_id: opts.projectId ?? null,
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
    payload: JSON.stringify({ taskId: TASK_ID, status: 'Ready' }),
    payload_hash: `hash-${counter}`,
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

/** Flushes the microtask queue past the `await` in onSessionParked. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function crashCountFor(taskId: string): number {
  const row = db
    .prepare(
      'SELECT consecutive_crashes FROM task_crash_counts WHERE task_id = ?',
    )
    .get(taskId) as { consecutive_crashes: number } | undefined;
  return row?.consecutive_crashes ?? 0;
}

function terminalReasonFor(sessionId: string): string | null {
  const row = db
    .prepare(
      'SELECT terminal_completion_reason FROM sessions WHERE session_id = ?',
    )
    .get(sessionId) as
    | { terminal_completion_reason: string | null }
    | undefined;
  return row?.terminal_completion_reason ?? null;
}

beforeEach(() => {
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM task_crash_counts').run();
  db.prepare('DELETE FROM task_pause_reasons').run();
  counter = 0;
  vi.mocked(getTaskBackend).mockReset();
});

describe('PlanningOrchestrator.checkTerminal — kind-aware "staged a decision" predicate', () => {
  it('a staged task-write decision intent (committed) counts — reaches terminal via the normal path, no nudge', () => {
    seedSession();
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    const intent = stageIntent({ kind: 'task.setStatus' });
    orchestrator.checkTerminal(SESSION_ID); // prime snapshot
    db.prepare(`UPDATE staged_intent SET state = 'committed' WHERE id = ?`).run(
      intent.id,
    );

    expect(orchestrator.checkTerminal(SESSION_ID)).toBe(true);
    expect(sessionManager.endSession).toHaveBeenCalledWith(SESSION_ID);
    expect(sessionManager.enqueueFeedback).not.toHaveBeenCalled();
    expect(getTaskPauseReason(TASK_ID)).toBeNull();
  });

  it('a staged ops_journal transition (journal.setState, committed) counts — reaches terminal, no nudge', () => {
    seedSession(SESSION_ID, 'ops');
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    const intent = stageIntent({
      kind: 'journal.setState',
      payload: JSON.stringify({ taskId: TASK_ID, state: 'candidate' }),
    });
    orchestrator.checkTerminal(SESSION_ID);
    db.prepare(`UPDATE staged_intent SET state = 'committed' WHERE id = ?`).run(
      intent.id,
    );

    expect(orchestrator.checkTerminal(SESSION_ID)).toBe(true);
    expect(sessionManager.endSession).toHaveBeenCalledWith(SESSION_ID);
    expect(sessionManager.enqueueFeedback).not.toHaveBeenCalled();
    expect(getTaskPauseReason(TASK_ID)).toBeNull();
  });

  it('a staged explicit no-op marker (planning.noOp) counts — reaches terminal, no nudge', () => {
    seedSession();
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    stageIntent({
      kind: 'planning.noOp',
      payload: JSON.stringify({ taskId: TASK_ID, reason: 'nothing to do' }),
    });
    // A staged (undispositioned) no-op never blocks terminal — it requires
    // no operator disposition.
    expect(orchestrator.checkTerminal(SESSION_ID)).toBe(true);
    expect(sessionManager.endSession).toHaveBeenCalledWith(SESSION_ID);
    expect(sessionManager.enqueueFeedback).not.toHaveBeenCalled();
    expect(getTaskPauseReason(TASK_ID)).toBeNull();
  });

  it('session.requestCapability / decision.pickOne alone do not count as a staged decision', () => {
    seedSession();
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    const intent = stageIntent({
      kind: 'decision.pickOne',
      payload: JSON.stringify({ prompt: 'which?', options: [{ label: 'a' }] }),
    });
    orchestrator.checkTerminal(SESSION_ID);
    db.prepare(`UPDATE staged_intent SET state = 'rejected' WHERE id = ?`).run(
      intent.id,
    );

    // Reaches terminal (nothing pending, nothing new) but with no staged
    // decision — the first occurrence nudges rather than surfacing a pause.
    expect(orchestrator.checkTerminal(SESSION_ID)).toBe(false);
    expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(1);
    expect(getSession(SESSION_ID)?.status).toBe('running');
  });
});

describe('PlanningOrchestrator.checkTerminal — terminal-no-decision backstop', () => {
  it('nudges exactly once, then on a second empty terminal sets planning_terminal_no_decision (docs session)', () => {
    seedSession(SESSION_ID, 'docs');
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    // Turn 1: parks terminal-empty — nothing staged at all.
    expect(orchestrator.checkTerminal(SESSION_ID)).toBe(false);
    expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(1);
    expect(sessionManager.enqueueFeedback).toHaveBeenCalledWith(
      SESSION_ID,
      expect.any(String),
      expect.stringContaining('stage your decision'),
    );
    expect(getSession(SESSION_ID)?.status).toBe('running');
    expect(getTaskPauseReason(TASK_ID)).toBeNull();

    // Turn 2 (the nudge's re-turn): still nothing staged.
    expect(orchestrator.checkTerminal(SESSION_ID)).toBe(true);
    expect(sessionManager.endSession).toHaveBeenCalledWith(SESSION_ID);
    // Bounded: still exactly one nudge, not a second.
    expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(1);

    const paused = getTaskPauseReason(TASK_ID);
    expect(paused?.reason).toBe('planning_terminal_no_decision');
    expect(paused?.severity).toBe('needs_attention');
  });

  it('the nudge does not increment the task crash-retry counter', () => {
    seedSession();
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    orchestrator.checkTerminal(SESSION_ID);
    orchestrator.checkTerminal(SESSION_ID);

    expect(crashCountFor(TASK_ID)).toBe(0);
  });

  it('regression: a groom session that parks idle with zero staged intents is detected purely via the session_ended(idle) wiring — not just a direct checkTerminal() call — for both the first-occurrence nudge and the second-occurrence pause', async () => {
    // Exercises the actual production signal path (onMessage -> onSessionParked
    // -> checkTerminal) end to end, rather than calling checkTerminal directly
    // as the other tests in this file do. This is the path a dispatched groom
    // session's clean-exit broadcast (AgentSession.handleCleanExit ->
    // markSessionIdle -> session_ended status=idle) actually drives in
    // production — a gap here (the check never running, or never being wired
    // to a park) would reproduce a session sitting idle forever with nothing
    // staged and no nudge/pause, indistinguishable from a crash.
    seedSession();
    const sessionManager = makeSessionManager();
    new PlanningOrchestrator(sessionManager);

    // First park: nothing staged at all.
    sessionManager.emit('message', {
      type: 'session_ended',
      sessionId: SESSION_ID,
      status: 'idle',
    });
    await flush();

    expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(1);
    expect(sessionManager.enqueueFeedback).toHaveBeenCalledWith(
      SESSION_ID,
      expect.any(String),
      expect.stringContaining('stage your decision'),
    );
    expect(sessionManager.endSession).not.toHaveBeenCalled();
    expect(getSession(SESSION_ID)?.status).toBe('running');
    expect(getTaskPauseReason(TASK_ID)).toBeNull();

    // Second park (the nudge's own re-turn): still nothing staged — reaches
    // terminal status via the same event-driven path, not a direct call.
    sessionManager.emit('message', {
      type: 'session_ended',
      sessionId: SESSION_ID,
      status: 'idle',
    });
    await flush();

    expect(sessionManager.endSession).toHaveBeenCalledWith(SESSION_ID);
    // Still bounded to exactly one nudge across both parks.
    expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(1);
    expect(getTaskPauseReason(TASK_ID)).toBeNull();
  });
});

describe('PlanningOrchestrator.checkTerminal — design closing-set-incomplete backstop', () => {
  it('a design session with only a committed decision.pickOne intent that parks empty twice is not terminalized — resumed instead of nudged into the no-decision pause', () => {
    seedSession(SESSION_ID, 'design');
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    const intent = stageIntent({ kind: 'decision.pickOne' });
    orchestrator.checkTerminal(SESSION_ID); // prime snapshot: intent still staged
    db.prepare(`UPDATE staged_intent SET state = 'committed' WHERE id = ?`).run(
      intent.id,
    );

    // Park 1: nothing pending, nothing new, closing set not applied — resumed,
    // not terminalized, and not routed through the no-decision nudge/pause.
    expect(orchestrator.checkTerminal(SESSION_ID)).toBe(false);
    expect(sessionManager.endSession).not.toHaveBeenCalled();
    expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(1);
    expect(sessionManager.enqueueFeedback).toHaveBeenCalledWith(
      SESSION_ID,
      expect.any(String),
      expect.stringContaining('closing set'),
      { attemptTerminalResume: true },
    );
    expect(getSession(SESSION_ID)?.status).toBe('running');
    expect(getTaskPauseReason(TASK_ID)).toBeNull();

    // Park 2: still nothing new — resumed again (one resume per park), still
    // not terminalized.
    expect(orchestrator.checkTerminal(SESSION_ID)).toBe(false);
    expect(sessionManager.endSession).not.toHaveBeenCalled();
    expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(2);
    expect(getSession(SESSION_ID)?.status).toBe('running');
    expect(getTaskPauseReason(TASK_ID)).toBeNull();
  });

  it('the same design session terminalizes as planning_no_pending_dispositions and closes the task once its closing set is applied', () => {
    seedSession(SESSION_ID, 'design', { projectId: 'proj-1' });
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);
    const updateStatus = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getTaskBackend).mockReturnValue({
      fetchTaskPage: vi.fn(),
      updateStatus,
    } as unknown as ReturnType<typeof getTaskBackend>);

    const pickOne = stageIntent({ kind: 'decision.pickOne' });
    orchestrator.checkTerminal(SESSION_ID); // prime snapshot
    db.prepare(`UPDATE staged_intent SET state = 'committed' WHERE id = ?`).run(
      pickOne.id,
    );
    // Still not applied — one resume, not terminal.
    expect(orchestrator.checkTerminal(SESSION_ID)).toBe(false);

    // Now the session stages and commits its full closing set.
    stageIntent({
      kind: 'completeness.disposition',
      state: 'committed',
      payload: JSON.stringify({
        taskId: TASK_ID,
        rowId: 1,
        project: null,
        milestone: null,
        probed: [],
        questions: [],
        runAt: new Date().toISOString(),
      }),
    });
    stageIntent({ kind: 'arch.updateUnit', state: 'committed' });
    stageIntent({ kind: 'task.create', state: 'committed' });

    // Prime the snapshot for this newly staged batch, then confirm on the
    // next (empty) park — the same staged-count-snapshot discipline every
    // other test in this file follows.
    expect(orchestrator.checkTerminal(SESSION_ID)).toBe(false);
    expect(orchestrator.checkTerminal(SESSION_ID)).toBe(true);
    expect(sessionManager.endSession).toHaveBeenCalledWith(SESSION_ID);
    expect(terminalReasonFor(SESSION_ID)).toBe(
      'planning_no_pending_dispositions',
    );
    expect(getTaskPauseReason(TASK_ID)).toBeNull();
    expect(updateStatus).toHaveBeenCalledWith(
      TASK_ID,
      '✅ Done',
      expect.objectContaining({ sessionId: SESSION_ID }),
    );
  });

  it('a design session that exceeds the resume budget gets a needs-attention pause and stays non-terminal', () => {
    seedSession(SESSION_ID, 'design');
    const sessionManager = makeSessionManager();
    const orchestrator = new PlanningOrchestrator(sessionManager);

    const intent = stageIntent({ kind: 'decision.pickOne' });
    orchestrator.checkTerminal(SESSION_ID); // prime snapshot
    db.prepare(`UPDATE staged_intent SET state = 'committed' WHERE id = ?`).run(
      intent.id,
    );

    // Exhaust the resume budget with repeated empty parks.
    let terminal = false;
    for (let i = 0; i < 10; i++) {
      terminal = orchestrator.checkTerminal(SESSION_ID);
      if (terminal) break;
    }

    expect(terminal).toBe(false);
    expect(sessionManager.endSession).not.toHaveBeenCalled();
    expect(getSession(SESSION_ID)?.status).toBe('running');
    const paused = getTaskPauseReason(TASK_ID);
    expect(paused?.reason).toBe('planning_design_closing_set_resume_exhausted');
    expect(paused?.severity).toBe('needs_attention');
  });
});

describe('PlanningOrchestrator.checkTerminal — non-design session types keep the two-strike backstop', () => {
  it.each(['groom', 'ops', 'docs'])(
    'a %s session with no staged decision still gets the nudge->pause->terminal treatment unchanged',
    (sessionType) => {
      seedSession(SESSION_ID, sessionType);
      const sessionManager = makeSessionManager();
      const orchestrator = new PlanningOrchestrator(sessionManager);

      expect(orchestrator.checkTerminal(SESSION_ID)).toBe(false);
      expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(1);
      expect(getSession(SESSION_ID)?.status).toBe('running');
      expect(getTaskPauseReason(TASK_ID)).toBeNull();

      expect(orchestrator.checkTerminal(SESSION_ID)).toBe(true);
      expect(sessionManager.endSession).toHaveBeenCalledWith(SESSION_ID);
      expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(1);
      const paused = getTaskPauseReason(TASK_ID);
      if (sessionType === 'groom') {
        expect(paused).toBeNull();
      } else {
        expect(paused?.reason).toBe('planning_terminal_no_decision');
      }
    },
  );
});
