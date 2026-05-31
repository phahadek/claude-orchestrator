/**
 * Unit tests for session/<id> branch pruning.
 *
 * Covers:
 *   - done session with no PR → branch deleted
 *   - done session with open PR → branch kept
 *   - running session → branch kept
 *   - killed session with merged PR → branch deleted
 *   - missing branch → silent no-op
 *   - backfill dry-run mode (source-structure check)
 *   - dev/main guard (defense-in-depth)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'child_process';

// ── Module mocks ──────────────────────────────────────────────────────────

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execSync: vi.fn(),
  };
});

vi.mock('../db/queries', () => ({
  getSession: vi.fn(),
  getPRBySessionId: vi.fn(),
}));

import { pruneSessionBranch } from '../session/SessionManager';
import { getSession, getPRBySessionId } from '../db/queries';

const mockedExecSync = vi.mocked(execSync);
const mockedGetSession = vi.mocked(getSession);
const mockedGetPRBySessionId = vi.mocked(getPRBySessionId);

const PROJECT_DIR = '/test/project';
const SESSION_ID = 'aaaabbbb-cccc-dddd-eeee-ffffaaaabbbb';
const BRANCH_NAME = `session/${SESSION_ID}`;

function makeSession(status: string, pr_url: string | null = null) {
  return {
    session_id: SESSION_ID,
    status,
    pr_url,
    task_id: null,
    task_url: null,
    project_context_url: null,
    project_id: null,
    started_at: Date.now(),
    ended_at: null,
    worktree_path: null,
    archived: 0,
    favorited: 0,
    session_type: 'standard',
    note: null,
    tags: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    model: null,
    task_name: null,
    metadata: null,
    review_result: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: branch exists
  mockedExecSync.mockImplementation((cmd: string) => {
    if (String(cmd).includes('rev-parse')) return '' as never;
    return '' as never;
  });
});

// ── done session, no PR → branch deleted ─────────────────────────────────

describe('pruneSessionBranch — done session, no PR', () => {
  it('deletes the branch', () => {
    mockedGetSession.mockReturnValue(makeSession('done', null) as never);

    pruneSessionBranch(SESSION_ID, PROJECT_DIR);

    const deleteCalls = mockedExecSync.mock.calls.filter((c) =>
      String(c[0]).includes('branch -D'),
    );
    expect(deleteCalls.length).toBe(1);
    expect(String(deleteCalls[0][0])).toContain(BRANCH_NAME);
  });
});

// ── done session, open PR → branch kept ──────────────────────────────────

describe('pruneSessionBranch — done session, open PR', () => {
  it('does NOT delete the branch', () => {
    mockedGetSession.mockReturnValue(
      makeSession('done', 'https://github.com/owner/repo/pull/42') as never,
    );
    mockedGetPRBySessionId.mockReturnValue({ state: 'open' } as never);

    pruneSessionBranch(SESSION_ID, PROJECT_DIR);

    const deleteCalls = mockedExecSync.mock.calls.filter((c) =>
      String(c[0]).includes('branch -D'),
    );
    expect(deleteCalls.length).toBe(0);
  });
});

// ── running session → branch kept ────────────────────────────────────────

describe('pruneSessionBranch — running session', () => {
  it('does NOT delete the branch', () => {
    mockedGetSession.mockReturnValue(makeSession('running', null) as never);

    pruneSessionBranch(SESSION_ID, PROJECT_DIR);

    const deleteCalls = mockedExecSync.mock.calls.filter((c) =>
      String(c[0]).includes('branch -D'),
    );
    expect(deleteCalls.length).toBe(0);
  });
});

// ── killed session, merged PR → branch deleted ────────────────────────────

describe('pruneSessionBranch — killed session, merged PR', () => {
  it('deletes the branch', () => {
    mockedGetSession.mockReturnValue(
      makeSession('killed', 'https://github.com/owner/repo/pull/99') as never,
    );
    mockedGetPRBySessionId.mockReturnValue({ state: 'merged' } as never);

    pruneSessionBranch(SESSION_ID, PROJECT_DIR);

    const deleteCalls = mockedExecSync.mock.calls.filter((c) =>
      String(c[0]).includes('branch -D'),
    );
    expect(deleteCalls.length).toBe(1);
    expect(String(deleteCalls[0][0])).toContain(BRANCH_NAME);
  });
});

// ── error session, closed PR → branch deleted ────────────────────────────

describe('pruneSessionBranch — error session, closed PR', () => {
  it('deletes the branch', () => {
    mockedGetSession.mockReturnValue(
      makeSession('error', 'https://github.com/owner/repo/pull/7') as never,
    );
    mockedGetPRBySessionId.mockReturnValue({ state: 'closed' } as never);

    pruneSessionBranch(SESSION_ID, PROJECT_DIR);

    const deleteCalls = mockedExecSync.mock.calls.filter((c) =>
      String(c[0]).includes('branch -D'),
    );
    expect(deleteCalls.length).toBe(1);
  });
});

// ── missing branch → silent no-op ────────────────────────────────────────

describe('pruneSessionBranch — missing branch', () => {
  it('is a silent no-op when the branch does not exist', () => {
    // rev-parse throws → branch missing
    mockedExecSync.mockImplementation((cmd: string) => {
      if (String(cmd).includes('rev-parse'))
        throw new Error('unknown revision');
      return '' as never;
    });

    expect(() => pruneSessionBranch(SESSION_ID, PROJECT_DIR)).not.toThrow();

    const deleteCalls = mockedExecSync.mock.calls.filter((c) =>
      String(c[0]).includes('branch -D'),
    );
    expect(deleteCalls.length).toBe(0);
  });
});

// ── dev / main guard ──────────────────────────────────────────────────────

describe('pruneSessionBranch — dev/main guard', () => {
  it('never deletes dev even when session is done', () => {
    // This tests the defense-in-depth guard.
    // session/dev is not a valid session ID but we guard anyway.
    mockedGetSession.mockReturnValue(makeSession('done', null) as never);

    // The guarded check happens before rev-parse so no execSync call is made.
    pruneSessionBranch('dev', PROJECT_DIR);

    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it('never deletes main even when session is done', () => {
    mockedGetSession.mockReturnValue(makeSession('done', null) as never);

    pruneSessionBranch('main', PROJECT_DIR);

    expect(mockedExecSync).not.toHaveBeenCalled();
  });
});

// ── active-prune is called from cleanupWorktree ────────────────────────────

describe('SessionManager.ts structural: cleanupWorktree calls pruneSessionBranch', () => {
  it('calls pruneSessionBranch after worktree removal', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'session', 'SessionManager.ts'),
      'utf-8',
    );
    expect(source).toMatch(/pruneSessionBranch\s*\(\s*sessionId/);
  });
});

// ── backfill script structural: --dry-run and warning on missing row ──────

describe('scripts/prune-session-branches.mjs structural', () => {
  it('script exists and contains dry-run mode', () => {
    const fs = require('fs');
    const path = require('path');
    const scriptPath = path.join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'scripts',
      'prune-session-branches.mjs',
    );
    const source = fs.readFileSync(scriptPath, 'utf-8');
    expect(source).toContain('dry-run');
    expect(source).toContain('dryRun');
  });

  it('script warns and skips when no sessions row exists', () => {
    const fs = require('fs');
    const path = require('path');
    const scriptPath = path.join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'scripts',
      'prune-session-branches.mjs',
    );
    const source = fs.readFileSync(scriptPath, 'utf-8');
    expect(source).toMatch(/no sessions row/i);
    expect(source).toMatch(/skipping/i);
  });

  it('script applies terminal-status gate', () => {
    const fs = require('fs');
    const path = require('path');
    const scriptPath = path.join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'scripts',
      'prune-session-branches.mjs',
    );
    const source = fs.readFileSync(scriptPath, 'utf-8');
    expect(source).toContain('TERMINAL_STATUSES');
    expect(source).toContain("'done'");
    expect(source).toContain("'error'");
    expect(source).toContain("'killed'");
  });

  it('script guards dev and main', () => {
    const fs = require('fs');
    const path = require('path');
    const scriptPath = path.join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'scripts',
      'prune-session-branches.mjs',
    );
    const source = fs.readFileSync(scriptPath, 'utf-8');
    expect(source).toContain('ALWAYS_GUARDED');
    expect(source).toContain("'dev'");
    expect(source).toContain("'main'");
  });
});
