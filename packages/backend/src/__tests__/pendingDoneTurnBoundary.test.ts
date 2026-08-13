/**
 * A deferred done-transition (markSessionDone called while a session's turn
 * was still in flight, e.g. PRMergeWatcher racing a still-running review
 * session) must be drained on the turn-boundary result event, not tied to
 * process exit — a session that parks alive between turns (the normal
 * resting state) never exits on its own, so a drain bound to process exit
 * would strand it at status='running' with a live subprocess forever.
 *
 * Part 1 exercises applyPendingDone's contract directly against a real
 * in-memory db (ordering, the terminal-status regression branch, and the
 * blast-radius guard). Part 2 exercises SessionManager's turn-boundary
 * drain + reap, and its run()-settle / boot-sweep backstops.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Part 1: applyPendingDone / markSessionIdle contract (real db) ─────────

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db/db.js';
import {
  markSessionDone,
  markSessionIdle,
  applyPendingDone,
} from '../db/queries.js';

function insertSession(opts: {
  session_id: string;
  status: string;
  pr_url?: string | null;
}) {
  db.prepare(
    `INSERT INTO sessions (session_id, status, started_at, pr_url)
     VALUES (@session_id, @status, 0, @pr_url)`,
  ).run({
    session_id: opts.session_id,
    status: opts.status,
    pr_url: opts.pr_url ?? null,
  });
}

function getRow(sessionId: string) {
  return db
    .prepare(`SELECT * FROM sessions WHERE session_id = @session_id`)
    .get({ session_id: sessionId }) as {
    status: string;
    pending_done_ended_at: number | null;
    pending_done_pr_url: string | null;
  };
}

function auditEventCount(sessionId: string, eventType: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM audit_log WHERE actor_id = @id AND event_type = @t`,
      )
      .get({ id: sessionId, t: eventType }) as { c: number }
  ).c;
}

beforeEach(() => {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM audit_log').run();
});

describe('applyPendingDone — turn-boundary contract', () => {
  it('applies a deferred done-transition with no process exit involved', () => {
    insertSession({ session_id: 's1', status: 'running' });
    markSessionDone('s1', 1000, 'https://pr', 'auto_merger');

    // Deferred: still running, pending fields set.
    let row = getRow('s1');
    expect(row.status).toBe('running');
    expect(row.pending_done_ended_at).toBe(1000);

    // Drained purely on the turn-boundary signal — no process exit occurred.
    const applied = applyPendingDone('s1');
    expect(applied).toBe(true);

    row = getRow('s1');
    expect(row.status).toBe('done');
    expect(row.pending_done_ended_at).toBeNull();
  });

  it('drops a deferred done whose session reached terminal via another path', () => {
    insertSession({ session_id: 's2', status: 'running' });
    markSessionDone('s2', 1000, null, 'auto_merger');

    // Session reached terminal a different way (e.g. crashed) before the drain fired.
    db.prepare(
      `UPDATE sessions SET status = 'error' WHERE session_id = 's2'`,
    ).run();

    const applied = applyPendingDone('s2');
    expect(applied).toBe(false);

    const row = getRow('s2');
    expect(row.status).toBe('error');
    expect(row.pending_done_ended_at).toBeNull();
  });

  it('drain-then-clean-exit converges on done (clean exit does not clobber it)', () => {
    insertSession({ session_id: 's3', status: 'running' });
    markSessionDone('s3', 1000, null, 'auto_merger');

    expect(applyPendingDone('s3')).toBe(true);
    expect(getRow('s3').status).toBe('done');

    // The clean-exit path (AgentSession.handleCleanExit) now runs its own write.
    const effective = markSessionIdle('s3', 2000, null);
    expect(effective).toBe('done');
    expect(getRow('s3').status).toBe('done');
    expect(auditEventCount('s3', 'session_idle_write_skipped_terminal')).toBe(
      1,
    );
  });

  it('clean-exit-then-drain converges on done — markSessionIdle drains the pending transition itself, rather than parking at idle first', () => {
    insertSession({ session_id: 's4', status: 'running' });
    markSessionDone('s4', 1000, null, 'auto_merger');

    // Clean exit races ahead of the turn-boundary drain — the running-to-idle
    // transition itself applies the deferred done instead of landing idle.
    const effective = markSessionIdle('s4', 1500, null);
    expect(effective).toBe('done');
    expect(getRow('s4').status).toBe('done');

    // The pending row is already cleared, so a subsequent drain is a no-op.
    expect(applyPendingDone('s4')).toBe(false);
    expect(getRow('s4').status).toBe('done');
  });

  it('regression: turn-boundary result, then a deferred done from auto_merger, then the running-to-idle transition — all converge on done', () => {
    // Turn-boundary result event: the turn completes and no done was
    // deferred yet, so the session simply parks alive (status stays
    // 'running' with no pending_done — this call is a no-op).
    insertSession({ session_id: 's6', status: 'running' });
    expect(applyPendingDone('s6')).toBe(false);

    // A caller (auto_merger) asks for done while the session is parked
    // alive at 'running' — the in-flight guard defers it.
    markSessionDone('s6', 5000, 'https://github.com/o/r/pull/7', 'auto_merger');
    expect(getRow('s6').status).toBe('running');
    expect(getRow('s6').pending_done_ended_at).toBe(5000);

    // The session later transitions off running to idle (e.g. the process
    // driving it exits) — this is the drain point that used to be missed
    // entirely for a session that parks alive between turns.
    const effective = markSessionIdle('s6', 6000, null);

    expect(effective).toBe('done');
    const row = getRow('s6');
    expect(row.status).toBe('done');
    expect(row.pending_done_ended_at).toBeNull();
    expect(row.pending_done_pr_url).toBeNull();
  });

  it('a standard coding session parked idle with an open PR is never given a pending_done_*', () => {
    insertSession({
      session_id: 's5',
      status: 'running',
      pr_url: 'https://pr/5',
    });

    // Its own turn ends cleanly (parks idle awaiting review) — no markSessionDone call.
    markSessionIdle('s5', 1000, 'https://pr/5');

    const row = getRow('s5');
    expect(row.status).toBe('idle');
    expect(row.pending_done_ended_at).toBeNull();

    // The drain is therefore a no-op for it.
    expect(applyPendingDone('s5')).toBe(false);
    expect(getRow('s5').status).toBe('idle');
  });
});

// ─── Part 2: SessionManager's turn-boundary drain + reap, and backstops ────
//
// db/db.js stays mocked to the same in-memory test db as Part 1 (see the
// vi.mock above) — db/queries is left un-mocked so SessionManager's real
// markSessionDone/applyPendingDone calls operate on that same db. Everything
// else SessionManager.ts imports at module scope is mocked to a lightweight
// stub, matching the established pattern in SessionManager.enqueueFeedback.test.ts.

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execSync: vi.fn().mockReturnValue(''), exec: vi.fn() };
});

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  const stub = {
    ...actual,
    writeFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue(''),
    mkdirSync: vi.fn(),
    statSync: vi.fn().mockReturnValue({ isFile: () => false }),
  };
  return { ...stub, default: stub };
});

vi.mock('../config', () => ({
  config: {},
  runtimeSettings: { session_mode: 'cli', max_concurrent_code_sessions: 10 },
  getProjectById: vi.fn().mockReturnValue(null),
  normalizePath: (p: string) => p,
}));

vi.mock('../orchestration/memoryAdmission', () => ({
  // respawnSession's memory-admission gate — real os.freemem() is
  // unreliable/low in CI/sandboxed hosts, so tests always see headroom
  // unless a test explicitly overrides this mock.
  hasMemoryHeadroom: vi.fn().mockReturnValue({
    allowed: true,
    freeMemMB: 8192,
    minHostFreeMemoryMB: 4096,
    perSessionReserveMB: 3072,
    projectedFreeMB: 5120,
  }),
}));

vi.mock('../config/corporateMode', () => ({
  getCorporateMode: vi
    .fn()
    .mockReturnValue({ gates: { dockerMandatory: false } }),
}));

vi.mock('../session/orchestrator-config', () => ({
  loadOrchestratorConfig: vi.fn().mockReturnValue({
    mainBranch: 'main',
    bootstrapScript: null,
    prGate: null,
    bashRules: null,
    allowedTools: [],
    mcp_servers: undefined,
  }),
  isGrantable: vi.fn().mockReturnValue(false),
  isToolShapedCapability: vi.fn().mockReturnValue(false),
  getSessionAllowedTools: vi.fn().mockReturnValue([]),
}));

vi.mock('../session/ContextBuilder', () => ({
  buildSessionContext: vi.fn().mockReturnValue('context'),
}));

vi.mock('../session/orchestrator-claudemd', () => ({
  buildReviewClaudeMd: vi.fn().mockReturnValue('review context'),
  buildDepthReviewClaudeMd: vi.fn().mockReturnValue('depth review context'),
}));

vi.mock('../session/branchModel', () => ({
  resolveStartingPoint: vi
    .fn()
    .mockReturnValue({ startingPoint: 'dev', milestoneSlug: null }),
  ensureMilestoneBranch: vi.fn(),
  deriveBranchSlug: vi
    .fn()
    .mockImplementation(
      (s: string) => `feature/${s.toLowerCase().replace(/\s+/g, '-')}`,
    ),
  resolveResumeBranchSlug: vi
    .fn()
    .mockImplementation(
      (s: string) => `feature/${s.toLowerCase().replace(/\s+/g, '-')}`,
    ),
}));

vi.mock('../routes/tasks', () => ({
  emitTaskUpdated: vi.fn(),
  broadcastTaskStatusChanged: vi.fn(),
}));

vi.mock('../notion/NotionClient', () => ({
  parseSection: vi.fn().mockReturnValue(''),
}));

vi.mock('../tasks/TaskStatusEngine', () => ({
  deriveDisplayStatusFromDb: vi.fn().mockReturnValue('starting'),
}));

vi.mock('../session/CliSessionRunner', () => ({
  CliSessionRunner: vi.fn().mockImplementation(() => ({
    sendMessage: vi.fn(),
    endSession: vi.fn(),
    run: vi.fn().mockReturnValue(new Promise(() => {})),
  })),
}));

vi.mock('../session/ApiSessionRunner', () => ({
  ApiSessionRunner: vi.fn().mockImplementation(() => ({
    sendMessage: vi.fn(),
    endSession: vi.fn(),
  })),
}));

vi.mock('../session/DockerSessionRunner', () => ({
  DockerSessionRunner: vi.fn().mockImplementation(() => ({
    sendMessage: vi.fn(),
    endSession: vi.fn(),
  })),
  reapOrphanContainers: vi.fn(),
}));

vi.mock('../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn().mockReturnValue({
    fetchTaskPage: vi.fn().mockResolvedValue('task content'),
    updateStatus: vi.fn().mockResolvedValue(undefined),
  }),
}));

import { SessionManager } from '../session/SessionManager';

describe('SessionManager — turn-boundary drain + reap', () => {
  it('applies a deferred done on the result event and reaps a still-live (parked) session', () => {
    insertSession({ session_id: 's6', status: 'running' });
    markSessionDone('s6', 1000, null, 'auto_merger');
    expect(getRow('s6').status).toBe('running');

    const sm = new SessionManager();
    const fakeSession = { endSession: vi.fn() };
    (sm as unknown as { sessions: Map<string, unknown> }).sessions.set(
      's6',
      fakeSession,
    );

    sm.emit('message', {
      type: 'session_event',
      sessionId: 's6',
      eventType: 'result',
      content: '',
    });

    expect(getRow('s6').status).toBe('done');
    expect(fakeSession.endSession).toHaveBeenCalledTimes(1);
  });

  it('does not drain on a non-result session_event', () => {
    insertSession({ session_id: 's6b', status: 'running' });
    markSessionDone('s6b', 1000, null, 'auto_merger');

    const sm = new SessionManager();
    sm.emit('message', {
      type: 'session_event',
      sessionId: 's6b',
      eventType: 'assistant_text',
      content: 'still working',
    });

    expect(getRow('s6b').status).toBe('running');
  });

  it('boot-sweep backstop (resumeOrphanSessions) still applies a pending done', async () => {
    insertSession({ session_id: 's7', status: 'running' });
    markSessionDone('s7', 1000, null, 'auto_merger');
    // Simulate the backend restarting mid-way through a clean exit: the row
    // landed at idle via some path other than markSessionIdle's own drain
    // (e.g. a crash between the status write and the pending_done clear),
    // leaving pending_done_* unapplied — the scenario
    // getSessionsWithUnappliedPendingDone covers.
    db.prepare(
      `UPDATE sessions SET status = 'idle' WHERE session_id = 's7'`,
    ).run();
    expect(getRow('s7').status).toBe('idle');
    expect(getRow('s7').pending_done_ended_at).not.toBeNull();

    const sm = new SessionManager();
    await sm.resumeOrphanSessions();

    expect(getRow('s7').status).toBe('done');
  });

  it('run()-settle backstop (applyPendingDoneForSettledSession) still applies a pending done', () => {
    insertSession({ session_id: 's8', status: 'running' });
    markSessionDone('s8', 1000, null, 'auto_merger');

    const sm = new SessionManager();
    (
      sm as unknown as {
        applyPendingDoneForSettledSession: (id: string) => void;
      }
    ).applyPendingDoneForSettledSession('s8');

    expect(getRow('s8').status).toBe('done');
  });
});
