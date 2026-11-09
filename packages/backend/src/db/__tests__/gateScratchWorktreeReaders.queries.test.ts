/**
 * PR-gate runs live in per-run `.gate-scratch` trees with session_id NULL, so
 * worktree_path is their only link to the owning session. The worktree-keyed
 * readers must resolve a scratch back to its session worktree.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import {
  insertSession,
  insertTestRequestRun,
  hasQueuedOrRunningTestRunForWorktree,
} from '../queries.js';
import { newGateScratchPath } from '../../orchestration/combinedTree.js';

const PROJECT_ID = 'proj-1';
const WT = '/srv/worktrees/task-a';

function insertGateRun(
  id: string,
  hash: string,
  worktreePath: string,
  state: 'queued' | 'running' = 'queued',
): void {
  insertTestRequestRun(
    id,
    PROJECT_ID,
    hash,
    null,
    1000,
    null,
    undefined,
    undefined,
    state,
    'full',
    null,
    worktreePath,
  );
}

function breadthOrigin(id: string): string {
  return (
    db
      .prepare('SELECT breadth_origin FROM test_request_runs WHERE id = ?')
      .get(id) as { breadth_origin: string }
  ).breadth_origin;
}

function addSession(sessionId: string, worktreePath: string): void {
  insertSession({
    session_id: sessionId,
    task_id: null,
    task_url: null,
    project_context_url: null,
    project_id: PROJECT_ID,
    status: 'running',
    started_at: 1,
    worktree_path: worktreePath,
  } as Parameters<typeof insertSession>[0]);
}

beforeEach(() => {
  db.prepare('DELETE FROM test_request_runs').run();
  db.prepare('DELETE FROM sessions').run();
});

describe('hasQueuedOrRunningTestRunForWorktree', () => {
  it('is true for a queued gate run on a scratch derived from the worktree', () => {
    insertGateRun('r1', 'h1', newGateScratchPath(WT), 'queued');
    expect(hasQueuedOrRunningTestRunForWorktree(WT)).toBe(true);
  });

  it('is true for a running gate run on a derived scratch', () => {
    insertGateRun('r1', 'h1', newGateScratchPath(WT), 'running');
    expect(hasQueuedOrRunningTestRunForWorktree(WT)).toBe(true);
  });

  it('is false for a scratch of a different worktree whose basename extends this one', () => {
    insertGateRun('r1', 'h1', newGateScratchPath('/srv/worktrees/task-a-more'));
    expect(hasQueuedOrRunningTestRunForWorktree(WT)).toBe(false);
  });

  it('still matches a run on the worktree itself', () => {
    insertGateRun('r1', 'h1', WT, 'running');
    expect(hasQueuedOrRunningTestRunForWorktree(WT)).toBe(true);
  });
});

describe('breadth origin for gate-scratch runs', () => {
  it('resolves to the owning session for a derived scratch', () => {
    addSession('s1', WT);
    insertGateRun('r1', 'h1', newGateScratchPath(WT));
    expect(breadthOrigin('r1')).toBe('session:s1');
  });

  it('gives two gate runs on different trees the same origin', () => {
    addSession('s1', WT);
    insertGateRun('r1', 'h1', newGateScratchPath(WT));
    insertGateRun('r2', 'h2', newGateScratchPath(WT));
    expect(breadthOrigin('r1')).toBe(breadthOrigin('r2'));
  });

  it('falls back to tree origin when the worktree is shared by several sessions', () => {
    addSession('s1', WT);
    addSession('s2', WT);
    insertGateRun('r1', 'h1', newGateScratchPath(WT));
    expect(breadthOrigin('r1')).toBe('tree:h1');
  });

  it('does not attribute a sibling-prefix scratch to the session', () => {
    addSession('s1', WT);
    insertGateRun('r1', 'h1', newGateScratchPath('/srv/worktrees/task-a-more'));
    expect(breadthOrigin('r1')).toBe('tree:h1');
  });
});
