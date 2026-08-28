/**
 * Tests for the gate's merge-completion consumer
 * (packages/backend/src/gate/gateMergeConsumer.ts).
 *
 * AC: on a merge signal, gate_item_source.merge_commit is filled from
 * local_branches.merge_commit_sha and min_deployed_commit recomputes to the
 * latest across sources; a follow-on source with a later merge commit
 * advances min_deployed_commit and re-opens a previously passed item (via
 * the existing reconciler re-open path); the gate consumes the signal
 * rather than PRMergeWatcher calling into the gate store directly; the
 * reconciler catch-up net fills a merge_commit missed by a dropped event.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import { insertSession, insertLocalBranch } from '../../db/queries.js';
import * as queries from '../../db/queries.js';
import {
  insertItem,
  getItem,
  advanceState,
  appendEvent,
  addSource,
} from '../gateStore.js';
import {
  handleMergeCompleted,
  registerGateMergeConsumer,
  catchUpMergeCommits,
  configureUnresolvedSourceEscalationSink,
} from '../gateMergeConsumer.js';
import type { PRMergeWatcher } from '../../github/PRMergeWatcher.js';
import { upsertTaskCache } from '../../db/queries.js';

let stageMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  db.prepare('DELETE FROM gate_item_event').run();
  db.prepare('DELETE FROM gate_item_source').run();
  db.prepare('DELETE FROM gate_item').run();
  db.prepare('DELETE FROM local_branches').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM task_cache').run();
  db.prepare('DELETE FROM pull_requests').run();
  stageMock = vi.fn();
  configureUnresolvedSourceEscalationSink({ stage: stageMock });
});

function seedMergedSession(taskId: string, commitSha: string): void {
  const sessionId = `session-${taskId}-${commitSha}`;
  insertSession({
    session_id: sessionId,
    task_id: taskId,
    task_url: null,
    project_context_url: null,
    status: 'done',
    started_at: 0,
    task_name: null,
  } as never);
  insertLocalBranch({
    project_id: 'polimarket-analyser',
    session_id: sessionId,
    branch_name: `feature/${taskId}`,
    base_branch: 'dev',
    status: 'merged',
    review_result: null,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  } as never);
  db.prepare(
    `UPDATE local_branches SET merge_commit_sha = ? WHERE session_id = ?`,
  ).run(commitSha, sessionId);
}

describe('handleMergeCompleted', () => {
  it('fills gate_item_source.merge_commit and recomputes min_deployed_commit', () => {
    const item = insertItem({
      project: 'polimarket-analyser',
      milestone: 'M12',
      text: 'Verify the migration ran cleanly',
      classification: 'needs-triage',
      sources: [
        { sourceTaskId: 'notion:m1', sourceTaskTitle: 'Add migration' },
      ],
      updatedAt: new Date(0).toISOString(),
    });

    handleMergeCompleted({
      notion_task_id: 'notion:m1',
      merge_commit: 'abc123',
    });

    const updated = getItem(item.id);
    expect(updated?.sources[0].mergeCommit).toBe('abc123');
    expect(updated?.minDeployedCommit).toBe('abc123');
  });

  it('recomputes min_deployed_commit to the latest across multiple sources', () => {
    const item = insertItem({
      project: 'polimarket-analyser',
      milestone: 'M12',
      text: 'Verify both PRs landed cleanly',
      classification: 'needs-triage',
      sources: [
        { sourceTaskId: 'notion:s1', sourceTaskTitle: 'First PR' },
        { sourceTaskId: 'notion:s2', sourceTaskTitle: 'Second PR' },
      ],
      updatedAt: new Date(0).toISOString(),
    });

    handleMergeCompleted({
      notion_task_id: 'notion:s1',
      merge_commit: 'sha-1',
    });
    expect(getItem(item.id)?.minDeployedCommit).toBe('sha-1');

    handleMergeCompleted({
      notion_task_id: 'notion:s2',
      merge_commit: 'sha-2',
    });
    expect(getItem(item.id)?.minDeployedCommit).toBe('sha-2');
  });

  it('advances min_deployed_commit for a follow-on source and re-opens a passed item', () => {
    const item = insertItem({
      project: 'polimarket-analyser',
      milestone: 'M12',
      text: 'Check the alert threshold',
      classification: 'Read-Only',
      sources: [
        { sourceTaskId: 'notion:orig', sourceTaskTitle: 'Original fix' },
      ],
      updatedAt: new Date(0).toISOString(),
    });
    handleMergeCompleted({
      notion_task_id: 'notion:orig',
      merge_commit: 'sha-orig',
    });

    // Simulate: verified and passed against a deploy that contained sha-orig.
    appendEvent(item.id, {
      disposition: 'pass',
      deploySha: 'sha-orig',
      at: new Date(1).toISOString(),
    });
    advanceState(item.id, 'pass', 'pass', new Date(1).toISOString());
    expect(getItem(item.id)?.state).toBe('pass');

    // A follow-on fix task gets attached as a new source (the reconciler's
    // fail-path in production; simulated here directly).
    addSource(
      item.id,
      { sourceTaskId: 'notion:followup', sourceTaskTitle: 'Follow-up fix' },
      new Date(2).toISOString(),
    );

    handleMergeCompleted({
      notion_task_id: 'notion:followup',
      merge_commit: 'sha-followup',
    });

    const updated = getItem(item.id);
    expect(updated?.minDeployedCommit).toBe('sha-followup');
    // Re-opening itself is the reconciler's job (reconcileGateRunnability);
    // this consumer's contract is only to have advanced min_deployed_commit
    // past what the passed item was last verified against.
    expect(updated?.state).toBe('pass');
  });

  it('is a no-op when no gate item sources from the merged task', () => {
    expect(() =>
      handleMergeCompleted({
        notion_task_id: 'notion:unrelated',
        merge_commit: 'x',
      }),
    ).not.toThrow();
  });

  it('fills a source stored with the raw (unprefixed) Notion id when the merge event carries the prefixed id', () => {
    // Accretion/backfill historically wrote the raw Notion id while
    // PRMergeWatcher always emits the prefixed canonical id — the id-form
    // mismatch that left every min_deployed_commit null.
    const item = insertItem({
      project: 'polimarket-analyser',
      milestone: 'M11',
      text: 'Raw-id source item',
      classification: 'needs-triage',
      sources: [
        {
          sourceTaskId: 'raw-uuid-1234',
          sourceTaskTitle: 'Raw-id source task',
        },
      ],
      updatedAt: new Date(0).toISOString(),
    });

    handleMergeCompleted({
      notion_task_id: 'notion:raw-uuid-1234',
      merge_commit: 'sha-raw',
    });

    const updated = getItem(item.id);
    expect(updated?.sources[0].sourceTaskId).toBe('notion:raw-uuid-1234');
    expect(updated?.sources[0].mergeCommit).toBe('sha-raw');
    expect(updated?.minDeployedCommit).toBe('sha-raw');
  });
});

describe('registerGateMergeConsumer — the gate consumes the signal, decoupled from the merge flow', () => {
  it('reacts to merge_completed emitted on a bare EventEmitter (no gate-aware API on the watcher)', () => {
    const item = insertItem({
      project: 'polimarket-analyser',
      milestone: 'M12',
      text: 'Decoupling check',
      classification: 'needs-triage',
      sources: [
        { sourceTaskId: 'notion:decoupled', sourceTaskTitle: 'Decoupled task' },
      ],
      updatedAt: new Date(0).toISOString(),
    });

    const watcher = new EventEmitter() as unknown as PRMergeWatcher;
    registerGateMergeConsumer(watcher);
    (watcher as unknown as EventEmitter).emit('merge_completed', {
      notion_task_id: 'notion:decoupled',
      merge_commit: 'decoupled-sha',
    });

    expect(getItem(item.id)?.minDeployedCommit).toBe('decoupled-sha');
  });
});

describe('catchUpMergeCommits — reconciler durability net', () => {
  it('fills a merge_commit for a source whose merge_completed event was missed', async () => {
    const item = insertItem({
      project: 'polimarket-analyser',
      milestone: 'M12',
      text: 'Recovered after a missed event',
      classification: 'needs-triage',
      sources: [
        { sourceTaskId: 'notion:missed', sourceTaskTitle: 'Missed event task' },
      ],
      updatedAt: new Date(0).toISOString(),
    });
    expect(getItem(item.id)?.sources[0].mergeCommit).toBeUndefined();

    seedMergedSession('notion:missed', 'catchup-sha');

    const result = await catchUpMergeCommits();

    expect(result.filled).toBe(1);
    const updated = getItem(item.id);
    expect(updated?.sources[0].mergeCommit).toBe('catchup-sha');
    expect(updated?.minDeployedCommit).toBe('catchup-sha');
  });

  it('fills a raw-id source whose merged session is keyed by the prefixed task id (gap A)', async () => {
    const item = insertItem({
      project: 'polimarket-analyser',
      milestone: 'M11',
      text: 'GitHub-merged source stored raw',
      classification: 'needs-triage',
      sources: [
        { sourceTaskId: 'raw-github-task', sourceTaskTitle: 'GitHub task' },
      ],
      updatedAt: new Date(0).toISOString(),
    });

    // sessions.task_id is always the prefixed canonical form.
    seedMergedSession('notion:raw-github-task', 'github-merged-sha');

    const result = await catchUpMergeCommits();

    expect(result.filled).toBe(1);
    const updated = getItem(item.id);
    expect(updated?.sources[0].mergeCommit).toBe('github-merged-sha');
    expect(updated?.minDeployedCommit).toBe('github-merged-sha');
  });

  it('is a no-op when every source is either filled or still unmerged', async () => {
    insertItem({
      project: 'polimarket-analyser',
      milestone: 'M12',
      text: 'Still unmerged',
      classification: 'needs-triage',
      sources: [
        { sourceTaskId: 'notion:pending', sourceTaskTitle: 'Pending task' },
      ],
      updatedAt: new Date(0).toISOString(),
    });

    expect(await catchUpMergeCommits()).toEqual({ filled: 0 });
  });
});

describe('catchUpMergeCommits — backoff for a permanently-unresolved source', () => {
  it('does not re-issue a lookup for a source whose prior attempt returned no merge commit, within the backoff window', async () => {
    insertItem({
      project: 'polimarket-analyser',
      milestone: 'M12',
      text: 'Never resolves',
      classification: 'needs-triage',
      sources: [
        {
          sourceTaskId: 'notion:unresolvable',
          sourceTaskTitle: 'Ghost task',
        },
      ],
      updatedAt: new Date(0).toISOString(),
    });

    const spy = vi
      .spyOn(queries, 'getMergeCommitForTask')
      .mockResolvedValue(null);

    const first = await catchUpMergeCommits();
    expect(first.filled).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);

    // Still unresolved and still within the backoff window — no repeat
    // lookup, unlike the unbounded-retry behavior this test guards against.
    const second = await catchUpMergeCommits();
    expect(second.filled).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });
});

describe('catchUpMergeCommits — escalation ceiling excludes structurally/temporarily unresolvable sources', () => {
  /** Drives catchUpMergeCommits past the escalation ceiling, jumping the fake clock past the max backoff window between each call so every call performs a fresh lookup. */
  async function driveAttempts(times: number): Promise<void> {
    for (let i = 0; i < times; i++) {
      await catchUpMergeCommits();
      vi.advanceTimersByTime(25 * 60 * 60 * 1000);
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('never stages a mirror for a 📐 Design source, regardless of attempt count or elapsed time', async () => {
    insertItem({
      project: 'polimarket-analyser',
      milestone: 'M16',
      text: 'Design task can never produce a merge commit',
      classification: 'needs-triage',
      sources: [
        { sourceTaskId: 'notion:design-src', sourceTaskTitle: 'Design work' },
      ],
      updatedAt: new Date(0).toISOString(),
    });
    upsertTaskCache(
      'notion:design-src',
      JSON.stringify({ type: '📐 Design', status: '✅ Done' }),
    );

    await driveAttempts(10);

    expect(stageMock).not.toHaveBeenCalled();
  });

  it('never stages a mirror for a 🔧 Operational source with no associated PR, regardless of attempt count or elapsed time', async () => {
    insertItem({
      project: 'polimarket-analyser',
      milestone: 'M16',
      text: 'Operational task with no PR',
      classification: 'needs-triage',
      sources: [
        {
          sourceTaskId: 'notion:ops-src',
          sourceTaskTitle: 'Config change done by hand',
        },
      ],
      updatedAt: new Date(0).toISOString(),
    });
    upsertTaskCache(
      'notion:ops-src',
      JSON.stringify({ type: '🔧 Operational', status: '✅ Done' }),
    );

    await driveAttempts(10);

    expect(stageMock).not.toHaveBeenCalled();
  });

  it('does not count toward the escalation ceiling while a 💻 Code source remains unmerged', async () => {
    insertItem({
      project: 'polimarket-analyser',
      milestone: 'M16',
      text: 'Code task still in flight',
      classification: 'needs-triage',
      sources: [
        { sourceTaskId: 'notion:code-src', sourceTaskTitle: 'In-flight fix' },
      ],
      updatedAt: new Date(0).toISOString(),
    });
    upsertTaskCache(
      'notion:code-src',
      JSON.stringify({ type: '💻 Code', status: '🚫 Blocked' }),
    );

    await driveAttempts(10);

    expect(stageMock).not.toHaveBeenCalled();

    // Once the task actually reaches a terminal (Done) state, a still-null
    // merge commit is genuinely suspicious again and escalation can fire.
    upsertTaskCache(
      'notion:code-src',
      JSON.stringify({ type: '💻 Code', status: '✅ Done' }),
    );
    await driveAttempts(1);

    expect(stageMock).toHaveBeenCalledTimes(1);
  });

  it('still escalates a genuine dropped-webhook case: a 💻 Code source that reached Done with no resolvable merge commit', async () => {
    insertItem({
      project: 'polimarket-analyser',
      milestone: 'M16',
      text: 'Merged out-of-band, webhook dropped',
      classification: 'needs-triage',
      sources: [
        {
          sourceTaskId: 'notion:dropped-webhook',
          sourceTaskTitle: 'Out-of-band merge',
        },
      ],
      updatedAt: new Date(0).toISOString(),
    });
    upsertTaskCache(
      'notion:dropped-webhook',
      JSON.stringify({ type: '💻 Code', status: '✅ Done' }),
    );

    await driveAttempts(8);

    expect(stageMock).toHaveBeenCalledTimes(1);
  });
});
