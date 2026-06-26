/**
 * DB-level tests for task_repo_assignments table and query functions.
 *
 * AC: Table created; assignment write/read round-trips; rejects a repo
 * not in the project's set.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db/db.js';
import {
  setTaskRepoAssignment,
  getTaskRepoAssignment,
  deleteTaskRepoAssignment,
} from '../db/queries.js';

beforeEach(() => {
  db.prepare('DELETE FROM task_repo_assignments').run();
});

describe('task_repo_assignments table', () => {
  it('table exists in the schema', () => {
    const row = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='task_repo_assignments'`,
      )
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('task_repo_assignments');
  });
});

describe('setTaskRepoAssignment / getTaskRepoAssignment', () => {
  it('round-trips a write and read', () => {
    setTaskRepoAssignment(
      'task-1',
      'proj-1',
      'owner/repo-a',
      'user@example.com',
      ['owner/repo-a', 'owner/repo-b'],
    );
    const row = getTaskRepoAssignment('task-1');
    expect(row).toBeDefined();
    expect(row!.task_id).toBe('task-1');
    expect(row!.project_id).toBe('proj-1');
    expect(row!.repo).toBe('owner/repo-a');
    expect(row!.assigned_by).toBe('user@example.com');
    expect(typeof row!.assigned_at).toBe('number');
  });

  it('returns undefined for a task with no assignment', () => {
    expect(getTaskRepoAssignment('nonexistent-task')).toBeUndefined();
  });

  it('rejects a repo not in the project repo set', () => {
    expect(() =>
      setTaskRepoAssignment(
        'task-2',
        'proj-1',
        'owner/wrong-repo',
        'user@example.com',
        ['owner/repo-a', 'owner/repo-b'],
      ),
    ).toThrow('Repo "owner/wrong-repo" is not in the project\'s repo set');
  });

  it('upserts when called twice for the same task_id', () => {
    setTaskRepoAssignment(
      'task-3',
      'proj-1',
      'owner/repo-a',
      'first-user',
      ['owner/repo-a', 'owner/repo-b'],
    );
    setTaskRepoAssignment(
      'task-3',
      'proj-1',
      'owner/repo-b',
      'second-user',
      ['owner/repo-a', 'owner/repo-b'],
    );
    const row = getTaskRepoAssignment('task-3');
    expect(row!.repo).toBe('owner/repo-b');
    expect(row!.assigned_by).toBe('second-user');
  });

  it('works for a single-repo allowedRepos set', () => {
    setTaskRepoAssignment(
      'task-4',
      'proj-single',
      'owner/only-repo',
      'system',
      ['owner/only-repo'],
    );
    const row = getTaskRepoAssignment('task-4');
    expect(row!.repo).toBe('owner/only-repo');
  });
});

describe('deleteTaskRepoAssignment', () => {
  it('removes the assignment', () => {
    setTaskRepoAssignment(
      'task-5',
      'proj-1',
      'owner/repo-a',
      'user',
      ['owner/repo-a'],
    );
    expect(getTaskRepoAssignment('task-5')).toBeDefined();
    deleteTaskRepoAssignment('task-5');
    expect(getTaskRepoAssignment('task-5')).toBeUndefined();
  });

  it('is a no-op for a task with no assignment', () => {
    expect(() => deleteTaskRepoAssignment('no-such-task')).not.toThrow();
  });
});
