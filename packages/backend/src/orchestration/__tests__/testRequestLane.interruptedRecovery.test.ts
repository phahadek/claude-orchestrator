/**
 * Boot-sweep delivery: recoverInterruptedTestRequestRuns must hand a
 * test_request feedback item to the requesting session, since the in-process
 * continuation that would have delivered the result died with the process.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { insertSession, insertTestRequestRun } from '../../db/queries';
import {
  checkTestRequestHold,
  recoverInterruptedTestRequestRuns,
  setTestRequestLaneSessionManager,
} from '../testRequestLane';
import type { SessionManager } from '../../session/SessionManager';

const enqueueFeedback = vi.fn(async () => undefined);

function addSession(id: string, status: string): void {
  insertSession({
    session_id: id,
    task_id: `task-${id}`,
    task_url: '',
    project_context_url: '',
    project_id: 'proj-1',
    status,
    started_at: Date.now(),
  } as Parameters<typeof insertSession>[0]);
}

function addRun(id: string, sessionId: string | null, queued = false): void {
  insertTestRequestRun(
    id,
    'proj-1',
    `hash-${id}`,
    sessionId,
    Date.now(),
    null,
    undefined,
    'session_request',
    queued ? 'queued' : 'running',
  );
}

describe('recoverInterruptedTestRequestRuns session delivery', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM test_request_runs').run();
    db.prepare('DELETE FROM sessions').run();
    enqueueFeedback.mockReset();
    enqueueFeedback.mockResolvedValue(undefined);
    setTestRequestLaneSessionManager({
      enqueueFeedback,
    } as unknown as SessionManager);
  });

  it.each([false, true])(
    'enqueues exactly one test_request item for a live session (queued=%s)',
    (queued) => {
      addSession('s-live', 'running');
      addRun('r1', 's-live', queued);
      recoverInterruptedTestRequestRuns();
      expect(enqueueFeedback).toHaveBeenCalledTimes(1);
      const [sid, source, payload] = enqueueFeedback.mock.calls[0] as unknown as [
        string,
        string,
        string,
      ];
      expect(sid).toBe('s-live');
      expect(source).toBe('test_request');
      const parsed = JSON.parse(payload);
      expect(parsed.runId).toBe('r1');
      expect(parsed.passed).toBe(false);
      expect(parsed.interrupted).toBe(true);
      expect(parsed.output).toMatch(/backend restarted/);
      expect(parsed.output).toMatch(/not a test failure/);
      expect(parsed.output).toMatch(/test\.request/);
      expect(parsed.intentId).toBeUndefined();
    },
  );

  it('does not enqueue for terminal, missing, or null sessions', () => {
    addSession('s-done', 'done');
    addRun('r-done', 's-done');
    addRun('r-missing', 's-missing');
    addRun('r-null', null);
    recoverInterruptedTestRequestRuns();
    expect(enqueueFeedback).not.toHaveBeenCalled();
  });

  it('keeps sweeping when one enqueue throws or rejects', () => {
    addSession('s-a', 'running');
    addSession('s-b', 'running');
    addRun('ra', 's-a');
    addRun('rb', 's-b');
    enqueueFeedback.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect(() => recoverInterruptedTestRequestRuns()).not.toThrow();
    expect(enqueueFeedback).toHaveBeenCalledTimes(2);
    const states = db
      .prepare(`SELECT state FROM test_request_runs`)
      .all() as Array<{ state: string }>;
    expect(states.every((r) => r.state === 'failed')).toBe(true);
  });

  it('does not hold a later test.request on the same tree', () => {
    addSession('s-live', 'running');
    addRun('r-hold', 's-live');
    recoverInterruptedTestRequestRuns();
    expect(
      checkTestRequestHold({
        projectId: 'proj-1',
        sessionId: 's-live',
        contentHash: 'hash-r-hold',
        runKind: 'full',
        baseSha: null,
      }),
    ).toEqual({ held: false });
  });
});
