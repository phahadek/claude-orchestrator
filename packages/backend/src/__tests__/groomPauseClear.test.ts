import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db/db.js';
import {
  insertSession,
  setTaskPauseReason,
  getTaskPauseReason,
  clearGroomAttributedTaskPauseReasons,
} from '../db/queries.js';
import { deriveDisplayStatus } from '../tasks/TaskStatusEngine.js';

const GROOM_SID = '11111111-1111-4111-8111-111111111111';
const DESIGN_SID = '22222222-2222-4222-8222-222222222222';
const OPS_SID = '33333333-3333-4333-8333-333333333333';
const STANDARD_SID = '44444444-4444-4444-8444-444444444444';
const CRASH_GROOM_SID = '55555555-5555-4555-8555-555555555555';
const CRASH_DESIGN_SID = '66666666-6666-4666-8666-666666666666';

function seed(
  sessionId: string,
  taskId: string,
  sessionType: string,
  startedAt = Date.now(),
): void {
  insertSession({
    session_id: sessionId,
    task_id: taskId,
    task_url: `https://notion.so/${taskId}`,
    project_context_url: 'https://notion.so/ctx',
    status: 'done',
    started_at: startedAt,
    session_type: sessionType,
    project_id: null,
  });
}

beforeEach(() => {
  db.prepare('DELETE FROM task_pause_reasons').run();
  db.prepare('DELETE FROM sessions').run();
});

describe('clearGroomAttributedTaskPauseReasons', () => {
  it('clears groom-attributed planning pauses and leaves design/ops/standard rows', () => {
    seed(GROOM_SID, 'groom-named', 'groom');
    setTaskPauseReason(
      'groom-named',
      'planning_terminal_blocked_members',
      `Planning session ${GROOM_SID} reached terminal with 1 blocked intent`,
    );

    // Crash rows name no session: attributed via the task's latest session.
    seed(CRASH_GROOM_SID, 'groom-crash', 'groom');
    setTaskPauseReason('groom-crash', 'planning_crashed', 'runner_non_zero');

    seed(DESIGN_SID, 'design-task', 'design');
    setTaskPauseReason(
      'design-task',
      'planning_terminal_no_decision',
      `Design session ${DESIGN_SID} reached terminal`,
    );

    seed(CRASH_DESIGN_SID, 'design-crash', 'design');
    setTaskPauseReason('design-crash', 'planning_crashed', 'runner_non_zero');

    seed(OPS_SID, 'ops-task', 'ops');
    setTaskPauseReason(
      'ops-task',
      'planning_terminal_blocked_members',
      `Planning session ${OPS_SID} reached terminal`,
    );

    seed(STANDARD_SID, 'standard-task', 'standard');
    setTaskPauseReason('standard-task', 'resume_failed', 'worktree missing');

    expect(clearGroomAttributedTaskPauseReasons()).toBe(2);

    expect(getTaskPauseReason('groom-named')).toBeNull();
    expect(getTaskPauseReason('groom-crash')).toBeNull();
    expect(getTaskPauseReason('design-task')?.reason).toBe(
      'planning_terminal_no_decision',
    );
    expect(getTaskPauseReason('design-crash')?.reason).toBe('planning_crashed');
    expect(getTaskPauseReason('ops-task')?.reason).toBe(
      'planning_terminal_blocked_members',
    );
    expect(getTaskPauseReason('standard-task')?.reason).toBe('resume_failed');
  });

  it('is idempotent', () => {
    seed(GROOM_SID, 'groom-named', 'groom');
    setTaskPauseReason(
      'groom-named',
      'planning_terminal_blocked_members',
      `Planning session ${GROOM_SID} reached terminal`,
    );
    seed(DESIGN_SID, 'design-task', 'design');
    setTaskPauseReason(
      'design-task',
      'planning_terminal_no_decision',
      `Design session ${DESIGN_SID} reached terminal`,
    );

    expect(clearGroomAttributedTaskPauseReasons()).toBe(1);
    expect(clearGroomAttributedTaskPauseReasons()).toBe(0);
    expect(getTaskPauseReason('design-task')?.reason).toBe(
      'planning_terminal_no_decision',
    );
  });

  it('uses the latest session when a crash row names no session', () => {
    seed(DESIGN_SID, 'mixed-task', 'design', 1000);
    seed(GROOM_SID, 'mixed-task', 'groom', 2000);
    setTaskPauseReason('mixed-task', 'planning_crashed', 'runner_non_zero');

    expect(clearGroomAttributedTaskPauseReasons()).toBe(1);
    expect(getTaskPauseReason('mixed-task')).toBeNull();
  });

  it('a task whose only pause was groom-attributed derives its Notion-status group, not needs_attention', () => {
    seed(GROOM_SID, 'groom-named', 'groom');
    setTaskPauseReason(
      'groom-named',
      'planning_terminal_blocked_members',
      `Planning session ${GROOM_SID} reached terminal`,
    );
    const input = (pauseReason: ReturnType<typeof getTaskPauseReason>) => ({
      notionStatus: '🗂️ Ready',
      codeSessionStatus: null,
      prState: null,
      prDraft: false,
      reviewVerdict: null,
      reviewIterationCount: 0,
      reviewIterationCap: 3,
      pauseReason,
    });

    expect(deriveDisplayStatus(input(getTaskPauseReason('groom-named')))).toBe(
      'needs_attention',
    );

    clearGroomAttributedTaskPauseReasons();

    expect(deriveDisplayStatus(input(getTaskPauseReason('groom-named')))).toBe(
      'ready',
    );
  });
});
