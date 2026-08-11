/**
 * Tests for DeferredBlockerSweep.
 *
 * Verifies:
 * - A Ready task depending on an already-Deferred task records exactly one
 *   surfacing audit event naming both task ids.
 * - A dependency that is not Deferred (e.g. In Progress) records no event.
 * - A second sweep over the same still-Deferred pair does not re-record.
 * - The sweep never writes task status or dependsOn.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/queries.js', () => ({
  getAllBoardCacheTasks: vi.fn(),
}));

vi.mock('../../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
  hasDeferredBlockerSurfacedEvent: vi.fn(),
}));

import { getAllBoardCacheTasks } from '../../db/queries.js';
import {
  recordEvent,
  hasDeferredBlockerSurfacedEvent,
} from '../../audit/AuditLog.js';
import { DeferredBlockerSweep } from '../DeferredBlockerSweep.js';

function makeSweep() {
  return new DeferredBlockerSweep({
    listBoardTasks: getAllBoardCacheTasks,
  });
}

describe('DeferredBlockerSweep', () => {
  beforeEach(() => {
    vi.mocked(hasDeferredBlockerSurfacedEvent).mockReturnValue(false);
    vi.mocked(recordEvent).mockClear();
  });

  it('surfaces a Ready task blocked by an already-Deferred dependency', () => {
    vi.mocked(getAllBoardCacheTasks).mockReturnValue([
      {
        id: 'notion:ready-task',
        status: '🗂️ Ready',
        dependsOn: ['notion:deferred-task'],
      },
      {
        id: 'notion:deferred-task',
        status: '⏭️ Deferred',
        dependsOn: [],
      },
    ]);

    makeSweep().scanOnce();

    expect(recordEvent).toHaveBeenCalledTimes(1);
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'task_deferred_blocks_dependents',
        task_id: 'notion:deferred-task',
        payload: expect.objectContaining({
          deferredTaskId: 'notion:deferred-task',
          dependentTaskIds: ['notion:ready-task'],
        }),
      }),
    );
  });

  it('records no event when the dependency is not Deferred', () => {
    vi.mocked(getAllBoardCacheTasks).mockReturnValue([
      {
        id: 'notion:ready-task',
        status: '🗂️ Ready',
        dependsOn: ['notion:in-progress-task'],
      },
      {
        id: 'notion:in-progress-task',
        status: '🔄 In Progress',
        dependsOn: [],
      },
    ]);

    makeSweep().scanOnce();

    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('does not re-record the event for an already-surfaced pair', () => {
    vi.mocked(hasDeferredBlockerSurfacedEvent).mockReturnValue(true);
    vi.mocked(getAllBoardCacheTasks).mockReturnValue([
      {
        id: 'notion:ready-task',
        status: '🗂️ Ready',
        dependsOn: ['notion:deferred-task'],
      },
      {
        id: 'notion:deferred-task',
        status: '⏭️ Deferred',
        dependsOn: [],
      },
    ]);

    makeSweep().scanOnce();

    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('never writes task status or dependsOn — only reads the board cache and records an audit event', () => {
    const boardTasks = [
      {
        id: 'notion:ready-task',
        status: '🗂️ Ready',
        dependsOn: ['notion:deferred-task'],
      },
      {
        id: 'notion:deferred-task',
        status: '⏭️ Deferred',
        dependsOn: [],
      },
    ];
    vi.mocked(getAllBoardCacheTasks).mockReturnValue(boardTasks);

    makeSweep().scanOnce();

    // Board cache entries passed into the sweep are untouched — no
    // in-place status/dependsOn mutation.
    expect(boardTasks[0].status).toBe('🗂️ Ready');
    expect(boardTasks[0].dependsOn).toEqual(['notion:deferred-task']);
    expect(boardTasks[1].status).toBe('⏭️ Deferred');

    // The only side effect is the audit event — its payload carries task
    // ids, never a status or dependsOn write.
    expect(recordEvent).toHaveBeenCalledTimes(1);
    const [call] = vi.mocked(recordEvent).mock.calls;
    const event = call[0] as { payload: Record<string, unknown> };
    expect(event.payload).not.toHaveProperty('status');
    expect(event.payload).not.toHaveProperty('dependsOn');
  });
});
