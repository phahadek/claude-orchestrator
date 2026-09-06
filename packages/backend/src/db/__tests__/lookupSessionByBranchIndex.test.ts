/**
 * Regression coverage for the sessions.feature_branch / legacy-fallback
 * indexes (schema.ts) that lookupSessionByBranch (queries.ts) now queries
 * against instead of loading every task_name IS NOT NULL row and matching
 * the branch in JS. Follows the shape of hasActiveSessionForTaskIndex.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db';
import { lookupSessionByBranch } from '../queries';
import { logger } from '../../logger';
import { deriveBranchSlug } from '../../session/branchSlug';

let sessionCounter = 0;

function insertSession(opts: {
  taskId: string | null;
  taskName: string | null;
  featureBranch?: string | null;
}): string {
  sessionCounter += 1;
  const sessionId = `sess-${sessionCounter}`;
  db.prepare(
    `INSERT INTO sessions (session_id, task_id, task_url, project_context_url,
       status, started_at, session_type, archived, task_name, feature_branch)
     VALUES (?, ?, 'https://notion.so/task', 'https://notion.so/ctx', 'running', ?, 'standard', 0, ?, ?)`,
  ).run(
    sessionId,
    opts.taskId,
    Date.now(),
    opts.taskName,
    opts.featureBranch ?? null,
  );
  return sessionId;
}

describe('lookupSessionByBranch — indexable branch lookup', () => {
  beforeEach(() => {
    sessionCounter = 0;
    db.prepare('DELETE FROM sessions').run();
  });

  it('resolves the primary feature_branch lookup via an index seek, not a full table scan', () => {
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT session_id, task_id FROM sessions WHERE feature_branch = ?`,
      )
      .all('feature/some-branch') as Array<{ detail: string }>;
    const detail = plan.map((row) => row.detail).join(' | ');
    expect(detail).toMatch(
      /SEARCH sessions USING INDEX idx_sessions_feature_branch/,
    );
    expect(detail).not.toMatch(/SCAN sessions\b/);
  });

  it('returns the single match for a row with feature_branch set', () => {
    insertSession({
      taskId: 'task-1',
      taskName: 'Some Task',
      featureBranch: 'feature/some-task-abc123',
    });
    const result = lookupSessionByBranch('feature/some-task-abc123');
    expect(result).toEqual({ session_id: 'sess-1', task_id: 'task-1' });
  });

  it('resolves a legacy row (feature_branch IS NULL) via the derived slug', () => {
    insertSession({
      taskId: 'task-2',
      taskName: 'Legacy Task',
      featureBranch: null,
    });
    const slug = deriveBranchSlug('Legacy Task', 'task-2');
    const result = lookupSessionByBranch(slug);
    expect(result).toEqual({ session_id: 'sess-1', task_id: 'task-2' });
  });

  it('does not execute the legacy fallback when the primary lookup already matched', () => {
    insertSession({
      taskId: 'task-3',
      taskName: 'Primary Task',
      featureBranch: 'feature/primary-task',
    });
    // A legacy row whose derived slug would also match "feature/primary-task"
    // if the fallback ran — proves the fallback is skipped once primary hits.
    insertSession({
      taskId: 'task-4',
      taskName: 'primary task',
      featureBranch: null,
    });

    const result = lookupSessionByBranch('feature/primary-task');
    expect(result).toEqual({ session_id: 'sess-1', task_id: 'task-3' });
  });

  it('returns null with a warning for zero matches', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const result = lookupSessionByBranch('feature/does-not-exist');
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('no session found'),
    );
    warnSpy.mockRestore();
  });

  it('returns null with a warning for multiple matches', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    insertSession({
      taskId: 'task-5',
      taskName: 'Dup Task A',
      featureBranch: 'feature/dup-branch',
    });
    insertSession({
      taskId: 'task-6',
      taskName: 'Dup Task B',
      featureBranch: 'feature/dup-branch',
    });
    const result = lookupSessionByBranch('feature/dup-branch');
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ambiguous'));
    warnSpy.mockRestore();
  });
});
