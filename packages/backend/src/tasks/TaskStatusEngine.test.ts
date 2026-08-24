import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db/db';
import {
  deriveDisplayStatus,
  recordDisplayStatusTransition,
} from './TaskStatusEngine';
import type { TaskStatusInput } from './TaskStatusEngine';
import { pauseReasonFromCanonical } from '../db/pauseReason';
import { setLastRecordedDisplayStatus } from '../db/queries';

function makeInput(overrides: Partial<TaskStatusInput> = {}): TaskStatusInput {
  return {
    notionStatus: '🗂️ Ready',
    codeSessionStatus: null,
    prState: null,
    prDraft: false,
    reviewVerdict: null,
    reviewIterationCount: 0,
    reviewIterationCap: 3,
    pauseReason: null,
    ...overrides,
  };
}

describe('deriveDisplayStatus', () => {
  // ─── Notion status as primary source of truth ──────────────────────────────

  it("returns 'in_progress' when Notion says In Progress even with an open PR", () => {
    expect(
      deriveDisplayStatus(
        makeInput({ notionStatus: '🔄 In Progress', prState: 'open' }),
      ),
    ).toBe('in_progress');
  });

  it("returns 'in_review' when Notion says In Review and no open PR", () => {
    expect(
      deriveDisplayStatus(
        makeInput({ notionStatus: '👀 In Review', prState: null }),
      ),
    ).toBe('in_review');
  });

  it("returns 'in_progress' when Notion says In Progress and session is running", () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '🔄 In Progress',
          codeSessionStatus: 'running',
        }),
      ),
    ).toBe('in_progress');
  });

  it("returns 'ready' when Notion says Ready even if session is running", () => {
    expect(
      deriveDisplayStatus(
        makeInput({ notionStatus: '🗂️ Ready', codeSessionStatus: 'running' }),
      ),
    ).toBe('ready');
  });

  it("returns 'ready' when Notion says Ready even if PR is open", () => {
    expect(
      deriveDisplayStatus(
        makeInput({ notionStatus: '🗂️ Ready', prState: 'open' }),
      ),
    ).toBe('ready');
  });

  // ─── ready ─────────────────────────────────────────────────────────────────

  it("returns 'ready' when notionStatus is '🗂️ Ready' and codeSessionStatus is null", () => {
    expect(deriveDisplayStatus(makeInput())).toBe('ready');
  });

  it("returns 'ready' when all inputs indicate no active work", () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '🗂️ Ready',
          codeSessionStatus: null,
          prState: null,
        }),
      ),
    ).toBe('ready');
  });

  // ─── in_progress ───────────────────────────────────────────────────────────

  it("returns 'in_progress' when notionStatus is '🔄 In Progress' and no running session", () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '🔄 In Progress',
          codeSessionStatus: null,
          prState: null,
        }),
      ),
    ).toBe('in_progress');
  });

  // ─── in_review ─────────────────────────────────────────────────────────────

  it("returns 'in_review' when notionStatus is '👀 In Review' and PR is open", () => {
    expect(
      deriveDisplayStatus(
        makeInput({ notionStatus: '👀 In Review', prState: 'open' }),
      ),
    ).toBe('in_review');
  });

  it("returns 'in_review' when notionStatus is '👀 In Review' and reviewVerdict is 'needs_changes'", () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '👀 In Review',
          prState: 'open',
          reviewVerdict: 'needs_changes',
        }),
      ),
    ).toBe('in_review');
  });

  it("returns 'in_review' when notionStatus is '👀 In Review' and reviewVerdict is 'incomplete'", () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '👀 In Review',
          prState: 'open',
          reviewVerdict: 'incomplete',
        }),
      ),
    ).toBe('in_review');
  });

  // ─── needs_attention ───────────────────────────────────────────────────────

  it("returns 'needs_attention' when notionStatus is '👀 In Review' and pauseReason is 'max_reviews'", () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '👀 In Review',
          prState: 'open',
          pauseReason: 'max_reviews',
        }),
      ),
    ).toBe('needs_attention');
  });

  it("returns 'needs_attention' for any non-null pauseReason", () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '👀 In Review',
          prState: 'open',
          pauseReason: 'stuck_timeout',
        }),
      ),
    ).toBe('needs_attention');
  });

  it("returns 'needs_attention' even when pauseReason is set outside of In Review", () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '🔄 In Progress',
          pauseReason: 'stuck_timeout',
        }),
      ),
    ).toBe('needs_attention');
  });

  it("does NOT return 'needs_attention' when pauseReason is null", () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '👀 In Review',
          prState: 'open',
          reviewIterationCount: 5,
          reviewIterationCap: 3,
        }),
      ),
    ).toBe('in_review');
  });

  // ─── ready_to_merge ────────────────────────────────────────────────────────

  it("returns 'ready_to_merge' when notionStatus is '👀 In Review', reviewVerdict is 'approved' and prState is 'open'", () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '👀 In Review',
          prState: 'open',
          reviewVerdict: 'approved',
        }),
      ),
    ).toBe('ready_to_merge');
  });

  it("returns 'ready_to_merge' even when pauseReason is set if verdict is approved", () => {
    // ready_to_merge takes priority over needs_attention
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '👀 In Review',
          prState: 'open',
          reviewVerdict: 'approved',
          pauseReason: 'max_reviews',
        }),
      ),
    ).toBe('ready_to_merge');
  });

  // ─── done ──────────────────────────────────────────────────────────────────

  it("returns 'done' when prState is 'merged'", () => {
    expect(deriveDisplayStatus(makeInput({ prState: 'merged' }))).toBe('done');
  });

  it("returns 'ready' (not done) when prState is 'closed' — closed PR is not terminal", () => {
    expect(deriveDisplayStatus(makeInput({ prState: 'closed' }))).toBe('ready');
  });

  it("returns 'in_progress' (not done) when prState is 'closed' and Notion says In Progress", () => {
    expect(
      deriveDisplayStatus(
        makeInput({ notionStatus: '🔄 In Progress', prState: 'closed' }),
      ),
    ).toBe('in_progress');
  });

  it("returns 'ready' (not done) when prState is 'closed' and Notion says Ready", () => {
    expect(
      deriveDisplayStatus(
        makeInput({ notionStatus: '🗂️ Ready', prState: 'closed' }),
      ),
    ).toBe('ready');
  });

  it("returns 'done' when prState is 'closed' and notionStatus is '✅ Done' — Notion is source of truth", () => {
    expect(
      deriveDisplayStatus(
        makeInput({ notionStatus: '✅ Done', prState: 'closed' }),
      ),
    ).toBe('done');
  });

  it("returns 'done' even when reviewVerdict is 'approved' if PR is merged", () => {
    expect(
      deriveDisplayStatus(
        makeInput({ prState: 'merged', reviewVerdict: 'approved' }),
      ),
    ).toBe('done');
  });

  it("returns 'done' when prState is 'merged' regardless of Notion status", () => {
    expect(
      deriveDisplayStatus(
        makeInput({ notionStatus: '🔄 In Progress', prState: 'merged' }),
      ),
    ).toBe('done');
  });

  // ─── empty / unknown notionStatus (cache miss) ─────────────────────────────

  it("returns 'backlog' when notionStatus is empty (cache miss)", () => {
    expect(deriveDisplayStatus(makeInput({ notionStatus: '' }))).toBe(
      'backlog',
    );
  });

  it("returns 'backlog' when notionStatus is unrecognized", () => {
    expect(
      deriveDisplayStatus(makeInput({ notionStatus: 'Some Future Status' })),
    ).toBe('backlog');
  });

  it("returns 'backlog' (not 'ready') when notionStatus is empty even with no PR", () => {
    expect(
      deriveDisplayStatus(
        makeInput({ notionStatus: '', prState: null, codeSessionStatus: null }),
      ),
    ).toBe('backlog');
  });

  it("returns 'done' (not 'backlog') when PR is merged and notionStatus is empty", () => {
    expect(
      deriveDisplayStatus(makeInput({ notionStatus: '', prState: 'merged' })),
    ).toBe('done');
  });

  // ─── blocked ───────────────────────────────────────────────────────────────

  it("returns 'blocked' when notionStatus is '🚫 Blocked' with no pauseReason", () => {
    expect(deriveDisplayStatus(makeInput({ notionStatus: '🚫 Blocked' }))).toBe(
      'blocked',
    );
  });

  it("returns 'blocked' (not 'needs_attention') when notionStatus is '🚫 Blocked' with a pauseReason", () => {
    // Explicit Blocked status takes precedence over pause_reason so an operator
    // sees 'blocked' rather than 'needs_attention' and can act on the right signal.
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '🚫 Blocked',
          pauseReason: 'stuck_timeout',
        }),
      ),
    ).toBe('blocked');
  });

  // ─── deferred ──────────────────────────────────────────────────────────────

  it("returns 'deferred' when notionStatus is '⏭️ Deferred' with no pauseReason", () => {
    expect(
      deriveDisplayStatus(makeInput({ notionStatus: '⏭️ Deferred' })),
    ).toBe('deferred');
  });

  it("returns 'deferred' (not 'needs_attention') when notionStatus is '⏭️ Deferred' with a pauseReason", () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '⏭️ Deferred',
          pauseReason: 'stuck_timeout',
        }),
      ),
    ).toBe('deferred');
  });

  // ─── Notion status fallback ────────────────────────────────────────────────

  it("returns 'done' when notionStatus is '✅ Done' and no PR/session", () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '✅ Done',
          codeSessionStatus: null,
          prState: null,
        }),
      ),
    ).toBe('done');
  });

  it("returns 'in_review' when notionStatus is '👀 In Review' and no PR", () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '👀 In Review',
          codeSessionStatus: null,
          prState: null,
        }),
      ),
    ).toBe('in_review');
  });

  // ─── priority ordering ─────────────────────────────────────────────────────

  it('done (merged PR) takes priority over Notion In Progress', () => {
    expect(
      deriveDisplayStatus(
        makeInput({ notionStatus: '🔄 In Progress', prState: 'merged' }),
      ),
    ).toBe('done');
  });

  it('done (merged PR) takes priority over ready_to_merge', () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '👀 In Review',
          prState: 'merged',
          reviewVerdict: 'approved',
        }),
      ),
    ).toBe('done');
  });

  it('ready_to_merge takes priority over needs_attention (within In Review)', () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '👀 In Review',
          prState: 'open',
          reviewVerdict: 'approved',
          pauseReason: 'max_reviews',
        }),
      ),
    ).toBe('ready_to_merge');
  });

  it('needs_attention takes priority over in_review (within In Review)', () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '👀 In Review',
          prState: 'open',
          pauseReason: 'max_reviews',
        }),
      ),
    ).toBe('needs_attention');
  });

  // ─── auto_recovering ───────────────────────────────────────────────────────

  it("returns 'auto_recovering' (not 'needs_attention') for ci_failing while automatic recovery budget remains", () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '👀 In Review',
          prState: 'open',
          pauseReason: pauseReasonFromCanonical('ci_failing'),
          flakeRecoveryAttempts: 0,
          flakeRecoveryMaxRetries: 2,
        }),
      ),
    ).toBe('auto_recovering');
  });

  it("returns 'auto_recovering' (not 'needs_attention') for analyze_failing outside In Review while automatic recovery budget remains", () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '🔄 In Progress',
          pauseReason: pauseReasonFromCanonical('analyze_failing'),
          flakeRecoveryAttempts: 1,
          flakeRecoveryMaxRetries: 2,
        }),
      ),
    ).toBe('auto_recovering');
  });

  it("returns 'needs_attention' for ci_failing once flake_recovery_attempts reaches the max — escalation still happens", () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '👀 In Review',
          prState: 'open',
          pauseReason: pauseReasonFromCanonical('ci_failing'),
          flakeRecoveryAttempts: 2,
          flakeRecoveryMaxRetries: 2,
        }),
      ),
    ).toBe('needs_attention');
  });

  it("returns 'needs_attention' for analyze_failing once flake_recovery_attempts exceeds the max", () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '🔄 In Progress',
          pauseReason: pauseReasonFromCanonical('analyze_failing'),
          flakeRecoveryAttempts: 5,
          flakeRecoveryMaxRetries: 2,
        }),
      ),
    ).toBe('needs_attention');
  });

  it("returns 'needs_attention' immediately for max_reviews (manual_action) regardless of flake_recovery_attempts", () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '👀 In Review',
          prState: 'open',
          pauseReason: pauseReasonFromCanonical('max_reviews'),
          flakeRecoveryAttempts: 0,
          flakeRecoveryMaxRetries: 2,
        }),
      ),
    ).toBe('needs_attention');
  });

  it("returns 'needs_attention' immediately for merge_conflict (manual_action) regardless of flake_recovery_attempts", () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '🔄 In Progress',
          pauseReason: pauseReasonFromCanonical('merge_conflict'),
          flakeRecoveryAttempts: 0,
          flakeRecoveryMaxRetries: 2,
        }),
      ),
    ).toBe('needs_attention');
  });

  it("returns 'needs_attention' immediately for a terminal-severity reason (pr_closed) regardless of flake_recovery_attempts", () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '🔄 In Progress',
          pauseReason: pauseReasonFromCanonical('pr_closed'),
          flakeRecoveryAttempts: 0,
          flakeRecoveryMaxRetries: 2,
        }),
      ),
    ).toBe('needs_attention');
  });

  it("returns 'needs_attention' immediately for stuck_timeout (recoverable + automatic) regardless of flake_recovery_attempts — unaffected by the auto_recovering gate", () => {
    expect(
      deriveDisplayStatus(
        makeInput({
          notionStatus: '🔄 In Progress',
          pauseReason: pauseReasonFromCanonical('stuck_timeout'),
          flakeRecoveryAttempts: 0,
          flakeRecoveryMaxRetries: 2,
        }),
      ),
    ).toBe('needs_attention');
  });
});

describe('recordDisplayStatusTransition', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM audit_log').run();
    db.prepare('DELETE FROM task_display_status_log').run();
  });

  function getEvents(taskId: string): Array<{ payload: string }> {
    return db
      .prepare(
        `SELECT payload FROM audit_log WHERE event_type = 'task_display_status_changed' AND task_id = ? ORDER BY id ASC`,
      )
      .all(taskId) as Array<{ payload: string }>;
  }

  it('emits an event when the derived displayStatus changes from one value to another', () => {
    recordDisplayStatusTransition('task-1', 'in_progress', {
      notionStatus: '🔄 In Progress',
      pauseReason: null,
      flakeRecoveryAttempts: 0,
      flakeRecoveryMaxRetries: 0,
    });
    recordDisplayStatusTransition('task-1', 'in_review', {
      notionStatus: '👀 In Review',
      pauseReason: null,
      flakeRecoveryAttempts: 0,
      flakeRecoveryMaxRetries: 0,
    });

    const events = getEvents('task-1');
    expect(events).toHaveLength(2);
    expect(JSON.parse(events[0].payload)).toMatchObject({
      from: null,
      to: 'in_progress',
    });
    expect(JSON.parse(events[1].payload)).toMatchObject({
      from: 'in_progress',
      to: 'in_review',
    });
  });

  it('emits no event when the derived value is unchanged across repeated calls', () => {
    for (let i = 0; i < 5; i++) {
      recordDisplayStatusTransition('task-2', 'ready', {
        notionStatus: '🗂️ Ready',
        pauseReason: null,
        flakeRecoveryAttempts: 0,
        flakeRecoveryMaxRetries: 0,
      });
    }

    expect(getEvents('task-2')).toHaveLength(1);
  });

  it('carries the deciding inputs alongside from/to in the payload', () => {
    recordDisplayStatusTransition('task-3', 'needs_attention', {
      notionStatus: '🔄 In Progress',
      pauseReason: pauseReasonFromCanonical('merge_conflict'),
      flakeRecoveryAttempts: 2,
      flakeRecoveryMaxRetries: 3,
    });

    const events = getEvents('task-3');
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload)).toMatchObject({
      from: null,
      to: 'needs_attention',
      notion_status: '🔄 In Progress',
      pause_reason: 'merge_conflict',
      pause_severity: 'needs_attention',
      retry_strategy: 'manual_action',
      flake_recovery_attempts: 2,
      flake_recovery_max_retries: 3,
    });
  });

  it('records the auto_recovering -> needs_attention transition when flake_recovery_attempts reaches the max', () => {
    recordDisplayStatusTransition('task-4', 'auto_recovering', {
      notionStatus: '🔄 In Progress',
      pauseReason: pauseReasonFromCanonical('ci_failing'),
      flakeRecoveryAttempts: 1,
      flakeRecoveryMaxRetries: 2,
    });
    recordDisplayStatusTransition('task-4', 'needs_attention', {
      notionStatus: '🔄 In Progress',
      pauseReason: pauseReasonFromCanonical('ci_failing'),
      flakeRecoveryAttempts: 2,
      flakeRecoveryMaxRetries: 2,
    });

    const events = getEvents('task-4');
    expect(events).toHaveLength(2);
    expect(JSON.parse(events[1].payload)).toMatchObject({
      from: 'auto_recovering',
      to: 'needs_attention',
      flake_recovery_attempts: 2,
      flake_recovery_max_retries: 2,
    });
  });

  it('produces zero rows for a task whose display status never changes across many view builds', () => {
    // Prime the last-recorded value so every subsequent call is a no-op —
    // simulating a task already settled at 'backlog' before this window of
    // repeated view builds begins.
    setLastRecordedDisplayStatus('task-5', 'backlog');

    for (let i = 0; i < 50; i++) {
      recordDisplayStatusTransition('task-5', 'backlog', {
        notionStatus: '🔲 Backlog',
        pauseReason: null,
        flakeRecoveryAttempts: 0,
        flakeRecoveryMaxRetries: 0,
      });
    }

    expect(getEvents('task-5')).toHaveLength(0);
  });
});
