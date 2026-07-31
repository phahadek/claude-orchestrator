/**
 * Tests for getOtherRunningSessionsForTask — the sendOrResume supersede
 * sweep's lookup. Must only return rows when the *resuming* session is
 * itself a standard (code) session: a planning-session (groom/design/ops/
 * split) resume is not a continuation of a code session and must never
 * retire the task's live standard session. Task-id matching must resolve
 * hyphenated, hyphenless, and notion:-prefixed forms to the same task.
 */

import { describe, it, expect, beforeEach } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { vi } from 'vitest';
import { db } from '../db.js';
import { insertSession, getOtherRunningSessionsForTask } from '../queries.js';

beforeEach(() => {
  db.prepare('DELETE FROM sessions').run();
});

function seedSession(opts: {
  sessionId: string;
  taskId: string;
  sessionType: string;
  status?: string;
}): void {
  insertSession({
    session_id: opts.sessionId,
    task_id: opts.taskId,
    task_url: null,
    project_context_url: null,
    status: opts.status ?? 'running',
    started_at: 0,
    session_type: opts.sessionType,
    task_name: null,
    metadata: null,
    review_result: null,
    pause_reason: null,
    last_error_detail: null,
    events_pruned_at: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    compaction_count: 0,
    context_occupancy_tokens: 0,
  } as never);
}

const TASK_ID = 'notion:abcd1234-ab12-cd34-ef56-1234567890ab';

describe('getOtherRunningSessionsForTask', () => {
  it('returns a stale running standard session when the resuming session is standard', () => {
    seedSession({
      sessionId: 'stale-standard',
      taskId: TASK_ID,
      sessionType: 'standard',
    });

    const result = getOtherRunningSessionsForTask(
      TASK_ID,
      'resuming-standard',
      'standard',
    );

    expect(result.map((r) => r.session_id)).toEqual(['stale-standard']);
  });

  it.each(['groom', 'design', 'ops', 'split'])(
    'returns no rows when the resuming session type is %s, even with a stale running standard session',
    (planningType) => {
      seedSession({
        sessionId: 'live-standard',
        taskId: TASK_ID,
        sessionType: 'standard',
      });

      const result = getOtherRunningSessionsForTask(
        TASK_ID,
        'resuming-planning',
        planningType,
      );

      expect(result).toEqual([]);
    },
  );

  it('treats a null/undefined resuming session_type as standard (continuation sweep still runs)', () => {
    seedSession({
      sessionId: 'stale-standard',
      taskId: TASK_ID,
      sessionType: 'standard',
    });

    expect(
      getOtherRunningSessionsForTask(TASK_ID, 'resuming', null).map(
        (r) => r.session_id,
      ),
    ).toEqual(['stale-standard']);
    expect(
      getOtherRunningSessionsForTask(TASK_ID, 'resuming', undefined).map(
        (r) => r.session_id,
      ),
    ).toEqual(['stale-standard']);
  });

  it('excludes the given session_id', () => {
    seedSession({
      sessionId: 'self',
      taskId: TASK_ID,
      sessionType: 'standard',
    });

    const result = getOtherRunningSessionsForTask(TASK_ID, 'self', 'standard');
    expect(result).toEqual([]);
  });

  it.each([
    ['hyphenated', 'notion:abcd1234-ab12-cd34-ef56-1234567890ab'],
    ['hyphenless', 'notion:abcd1234ab12cd34ef561234567890ab'],
    ['bare hyphenless (no source prefix)', 'abcd1234ab12cd34ef561234567890ab'],
  ])('matches the %s form of the task id to a hyphenated stored row', (_label, candidateId) => {
    seedSession({
      sessionId: 'stale-standard',
      taskId: TASK_ID,
      sessionType: 'standard',
    });

    const result = getOtherRunningSessionsForTask(
      candidateId,
      'resuming',
      'standard',
    );

    expect(result.map((r) => r.session_id)).toEqual(['stale-standard']);
  });
});
