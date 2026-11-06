import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import {
  setTaskUrgent,
  getTaskExecutionFlags,
  listTaskExecutionFlagsForProject,
  setTaskExecuteNow,
  clearTaskExecuteNow,
} from '../queries.js';

const UUID = '3f822f91-52f3-81ce-9574-c9b8208b7037';

beforeEach(() => {
  db.prepare('DELETE FROM task_execution_flags').run();
});

describe('task_execution_flags', () => {
  it('round-trips urgent true -> false with actor and timestamp stamped', () => {
    setTaskUrgent(`notion:${UUID}`, 'proj-1', true, 'human');
    const on = getTaskExecutionFlags(`notion:${UUID}`)!;
    expect(on.urgent).toBe(1);
    expect(on.urgent_set_by).toBe('human');
    expect(on.urgent_set_at).toBeGreaterThan(0);

    setTaskUrgent(`notion:${UUID}`, 'proj-1', false, 'human');
    const off = getTaskExecutionFlags(`notion:${UUID}`)!;
    expect(off.urgent).toBe(0);
    expect(off.urgent_set_by).toBe('human');
    expect(off.urgent_set_at).toBeGreaterThan(0);
  });

  it('resolves bare and notion:-prefixed ids to the same row', () => {
    setTaskUrgent(UUID, 'proj-1', true, 'human');
    expect(getTaskExecutionFlags(`notion:${UUID}`)?.urgent).toBe(1);
    expect(getTaskExecutionFlags(UUID)?.urgent).toBe(1);
    const count = db
      .prepare('SELECT COUNT(*) AS c FROM task_execution_flags')
      .get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('lists rows by project', () => {
    setTaskUrgent('a', 'proj-1', true, 'human');
    setTaskUrgent('b', 'proj-2', true, 'human');
    expect(listTaskExecutionFlagsForProject('proj-1')).toHaveLength(1);
  });

  it('sets and clears execute-now without touching urgent', () => {
    setTaskUrgent('a', 'proj-1', true, 'human');
    setTaskExecuteNow('a', 'proj-1', 'merge_conflict');
    const set = getTaskExecutionFlags('a')!;
    expect(set.execute_now_reason).toBe('merge_conflict');
    expect(set.execute_now_set_at).toBeGreaterThan(0);
    expect(set.urgent).toBe(1);

    clearTaskExecuteNow('a', 'consumed');
    const cleared = getTaskExecutionFlags('a')!;
    expect(cleared.execute_now_reason).toBeNull();
    expect(cleared.execute_now_set_at).toBeNull();
    expect(cleared.urgent).toBe(1);
  });
});
