/**
 * Tests for the seed store's merge-completion consumer
 * (packages/backend/src/seed/seedMergeConsumer.ts) — the seed twin of
 * gateMergeConsumer.
 *
 * AC: on a merge signal, seed_item_source.merge_commit is filled and
 * min_deployed_commit recomputes; the catch-up sweep backfills a
 * pre-existing item whose source task merged before the consumer existed;
 * a notion:-prefixed source task id resolves against a bare-UUID-keyed
 * sessions row (not a raw string compare).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import { insertSession, insertLocalBranch } from '../../db/queries.js';
import { insertItem, getItem } from '../seedStore.js';
import {
  handleMergeCompleted,
  registerSeedMergeConsumer,
  catchUpSeedMergeCommits,
} from '../seedMergeConsumer.js';
import type { PRMergeWatcher } from '../../github/PRMergeWatcher.js';

beforeEach(() => {
  db.prepare('DELETE FROM seed_item_event').run();
  db.prepare('DELETE FROM seed_item_source').run();
  db.prepare('DELETE FROM seed_item').run();
  db.prepare('DELETE FROM local_branches').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM audit_log').run();
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
  it('fills seed_item_source.merge_commit and recomputes min_deployed_commit', () => {
    const item = insertItem({
      project: 'polimarket-analyser',
      milestone: 'M12',
      spec: 'Set ALERT_THRESHOLD_MS to 500 in config',
      sources: [{ sourceTaskId: 'notion:m1', sourceTaskTitle: 'Add config' }],
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

  it('is a no-op when no seed item sources from the merged task', () => {
    expect(() =>
      handleMergeCompleted({
        notion_task_id: 'notion:unrelated',
        merge_commit: 'x',
      }),
    ).not.toThrow();
  });
});

describe('registerSeedMergeConsumer', () => {
  it('reacts to merge_completed emitted on a bare EventEmitter', () => {
    const item = insertItem({
      project: 'polimarket-analyser',
      milestone: 'M12',
      spec: 'Decoupling check',
      sources: [
        { sourceTaskId: 'notion:decoupled', sourceTaskTitle: 'Decoupled task' },
      ],
      updatedAt: new Date(0).toISOString(),
    });

    const watcher = new EventEmitter() as unknown as PRMergeWatcher;
    registerSeedMergeConsumer(watcher);
    (watcher as unknown as EventEmitter).emit('merge_completed', {
      notion_task_id: 'notion:decoupled',
      merge_commit: 'decoupled-sha',
    });

    expect(getItem(item.id)?.minDeployedCommit).toBe('decoupled-sha');
  });
});

describe('catchUpSeedMergeCommits — backfill for pre-existing rows', () => {
  it('fills a pre-existing item whose source task merged before the consumer existed', async () => {
    const item = insertItem({
      project: 'polimarket-analyser',
      milestone: 'M12',
      spec: 'Accreted before the consumer existed',
      sources: [
        { sourceTaskId: 'notion:missed', sourceTaskTitle: 'Missed event task' },
      ],
      updatedAt: new Date(0).toISOString(),
    });
    expect(getItem(item.id)?.sources[0].mergeCommit).toBeUndefined();

    // The task's PR merged (recorded in local_branches) before the
    // merge-completion consumer was ever registered — simulating the
    // 25 currently-NULL production rows.
    seedMergedSession('notion:missed', 'catchup-sha');

    const result = await catchUpSeedMergeCommits();

    expect(result.filled).toBe(1);
    const updated = getItem(item.id);
    expect(updated?.sources[0].mergeCommit).toBe('catchup-sha');
    expect(updated?.minDeployedCommit).toBe('catchup-sha');
  });

  it('resolves a notion:-prefixed source task id against a bare-UUID-keyed sessions row', async () => {
    const item = insertItem({
      project: 'polimarket-analyser',
      milestone: 'M12',
      spec: 'Raw-id source item',
      sources: [
        {
          sourceTaskId: 'raw-uuid-1234',
          sourceTaskTitle: 'Raw-id source task',
        },
      ],
      updatedAt: new Date(0).toISOString(),
    });

    // seed_item_source stores the source id normalized (notion:raw-uuid-1234)
    // while sessions.task_id is also normalized — a raw string compare
    // between the two forms as originally supplied ('raw-uuid-1234' vs
    // 'notion:raw-uuid-1234') would fail silently and return zero rows.
    seedMergedSession('notion:raw-uuid-1234', 'github-merged-sha');

    const result = await catchUpSeedMergeCommits();

    expect(result.filled).toBe(1);
    const updated = getItem(item.id);
    expect(updated?.sources[0].sourceTaskId).toBe('notion:raw-uuid-1234');
    expect(updated?.sources[0].mergeCommit).toBe('github-merged-sha');
    expect(updated?.minDeployedCommit).toBe('github-merged-sha');
  });

  it('is a no-op when every source is either filled or still unmerged', async () => {
    insertItem({
      project: 'polimarket-analyser',
      milestone: 'M12',
      spec: 'Still unmerged',
      sources: [
        { sourceTaskId: 'notion:pending', sourceTaskTitle: 'Pending task' },
      ],
      updatedAt: new Date(0).toISOString(),
    });

    expect(await catchUpSeedMergeCommits()).toEqual({ filled: 0 });
  });
});
