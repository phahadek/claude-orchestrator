import { describe, it, expect, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import { runMigrations } from '../schema.js';
import {
  upsertTaskCache,
  isStructurallyUnresolvableSource,
  listUnfilledGateItemSourceTaskIds,
  updateGateItemSourceMergeCommit,
  markGateItemSourceClosedWithoutMerge,
} from '../queries.js';

let seq = 0;

function seedSession(sessionType: string, taskId: string): string {
  const id = `sess-${++seq}`;
  db.prepare(
    `INSERT INTO sessions (session_id, task_id, status, started_at, session_type)
     VALUES (?, ?, 'done', ?, ?)`,
  ).run(id, taskId, Date.now(), sessionType);
  return id;
}

function seedCommittedNoOp(
  taskId: string,
  opts: { dedupKey?: string; sessionType?: string } = {},
): void {
  const now = Date.now();
  const sessionId = seedSession(opts.sessionType ?? 'standard', taskId);
  db.prepare(
    `INSERT INTO staged_intent
      (id, kind, payload, payload_hash, task_id, project_id, session_id, state, created_at, updated_at)
     VALUES (?, 'planning.noOp', ?, 'hash', ?, 'proj-1', ?, 'committed', ?, ?)`,
  ).run(
    `noop-${++seq}`,
    JSON.stringify({ taskId, reason: 'already satisfied elsewhere' }),
    opts.dedupKey ?? taskId,
    sessionId,
    now,
    now,
  );
}

function seedPullRequestRow(
  taskId: string,
  state: 'open' | 'closed' | 'merged' = 'open',
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO pull_requests
      (pr_number, pr_url, task_id, repo, state, draft, created_at, updated_at, synced_at)
     VALUES (?, ?, ?, 'acme/repo', ?, 0, ?, ?, ?)`,
  ).run(
    ++seq,
    `https://github.com/acme/repo/pull/${taskId}`,
    taskId,
    state,
    now,
    now,
    now,
  );
}

function seedGateSource(taskId: string): string {
  const itemId = `gi-${++seq}`;
  db.prepare(
    `INSERT INTO gate_item (id, project, milestone, text, classification, state, updated_at)
     VALUES (?, 'proj-1', 'M1', 'item', 'blocking', 'open', ?)`,
  ).run(itemId, new Date().toISOString());
  db.prepare(
    `INSERT INTO gate_item_source (gate_item_id, source_task_id, source_task_title, added_at)
     VALUES (?, ?, 't', ?)`,
  ).run(itemId, taskId, new Date().toISOString());
  return itemId;
}

function marker(itemId: string): string | null {
  return (
    db
      .prepare(
        `SELECT closed_without_merge_at AS m FROM gate_item_source WHERE gate_item_id = ?`,
      )
      .get(itemId) as { m: string | null }
  ).m;
}

function cacheDoneCode(taskId: string): void {
  upsertTaskCache(
    taskId,
    JSON.stringify({ type: '💻 Code', status: '✅ Done' }),
  );
}

describe('isStructurallyUnresolvableSource', () => {
  it('returns true for a 📐 Design source, without requiring any pull_requests row', () => {
    upsertTaskCache('notion:design-1', JSON.stringify({ type: '📐 Design' }));

    expect(isStructurallyUnresolvableSource('notion:design-1')).toBe(true);
  });

  it('returns true for a 🧪 Testing source, without requiring any pull_requests row', () => {
    upsertTaskCache('notion:testing-1', JSON.stringify({ type: '🧪 Testing' }));

    expect(isStructurallyUnresolvableSource('notion:testing-1')).toBe(true);
  });

  it('returns true for a 📋 Planning source, without requiring any pull_requests row', () => {
    upsertTaskCache(
      'notion:planning-1',
      JSON.stringify({ type: '📋 Planning' }),
    );

    expect(isStructurallyUnresolvableSource('notion:planning-1')).toBe(true);
  });

  it('returns true for a 📝 Docs source, without requiring any pull_requests row', () => {
    upsertTaskCache('notion:docs-1', JSON.stringify({ type: '📝 Docs' }));

    expect(isStructurallyUnresolvableSource('notion:docs-1')).toBe(true);
  });

  it('returns true for a 🎨 Assets source, without requiring any pull_requests row', () => {
    upsertTaskCache('notion:assets-1', JSON.stringify({ type: '🎨 Assets' }));

    expect(isStructurallyUnresolvableSource('notion:assets-1')).toBe(true);
  });

  it('returns true for a 🔎 Investigation source, without requiring any pull_requests row', () => {
    upsertTaskCache(
      'notion:investigation-1',
      JSON.stringify({ type: '🔎 Investigation' }),
    );

    expect(isStructurallyUnresolvableSource('notion:investigation-1')).toBe(
      true,
    );
  });

  it('returns false for a 💻 Code source', () => {
    upsertTaskCache('notion:code-1', JSON.stringify({ type: '💻 Code' }));

    expect(isStructurallyUnresolvableSource('notion:code-1')).toBe(false);
  });

  it('returns true for a 💻 Code source whose gate source row carries the closed-without-merge marker', () => {
    cacheDoneCode('notion:code-marked');
    const itemId = seedGateSource('notion:code-marked');
    markGateItemSourceClosedWithoutMerge(
      itemId,
      'notion:code-marked',
      new Date().toISOString(),
    );

    expect(isStructurallyUnresolvableSource('notion:code-marked')).toBe(true);
    expect(listUnfilledGateItemSourceTaskIds()).not.toContain(
      'notion:code-marked',
    );
  });

  it('returns false for a ✅ Done 💻 Code source with only a committed noOp row and no marker — the noOp row is no longer read', () => {
    cacheDoneCode('notion:code-noop-unmarked');
    seedCommittedNoOp('notion:code-noop-unmarked');

    expect(isStructurallyUnresolvableSource('notion:code-noop-unmarked')).toBe(
      false,
    );
  });

  it('setSourceMergeCommit-level update sets merge_commit and clears the marker', () => {
    cacheDoneCode('notion:code-remerged');
    const itemId = seedGateSource('notion:code-remerged');
    markGateItemSourceClosedWithoutMerge(
      itemId,
      'notion:code-remerged',
      new Date().toISOString(),
    );
    expect(marker(itemId)).not.toBeNull();

    updateGateItemSourceMergeCommit(itemId, 'notion:code-remerged', 'a'.repeat(40));

    expect(marker(itemId)).toBeNull();
    expect(isStructurallyUnresolvableSource('notion:code-remerged')).toBe(
      false,
    );
  });

  it('markGateItemSourceClosedWithoutMerge leaves a row that already has a merge_commit unmarked', () => {
    cacheDoneCode('notion:code-filled');
    const itemId = seedGateSource('notion:code-filled');
    updateGateItemSourceMergeCommit(itemId, 'notion:code-filled', 'b'.repeat(40));
    markGateItemSourceClosedWithoutMerge(
      itemId,
      'notion:code-filled',
      new Date().toISOString(),
    );

    expect(marker(itemId)).toBeNull();
  });

  describe('closed_without_merge_at backfill', () => {
    it('marks both live shapes (closed-unmerged PR + noOp under bare id and ::noop: key) and the sources stop being unresolved', () => {
      for (const [taskId, dedupKey] of [
        ['notion:bf-bare', 'notion:bf-bare'],
        ['notion:bf-kind', 'notion:bf-kind::noop:already_satisfied'],
      ]) {
        cacheDoneCode(taskId);
        seedPullRequestRow(taskId, 'closed');
        seedCommittedNoOp(taskId, { dedupKey });
      }
      const bare = seedGateSource('notion:bf-bare');
      const kind = seedGateSource('notion:bf-kind');

      runMigrations(db);

      expect(marker(bare)).not.toBeNull();
      expect(marker(kind)).not.toBeNull();
      expect(isStructurallyUnresolvableSource('notion:bf-bare')).toBe(true);
      expect(isStructurallyUnresolvableSource('notion:bf-kind')).toBe(true);
    });

    it('is idempotent: re-running migrations keeps the first timestamp', () => {
      cacheDoneCode('notion:bf-idem');
      seedCommittedNoOp('notion:bf-idem');
      const itemId = seedGateSource('notion:bf-idem');
      runMigrations(db);
      const first = marker(itemId);
      expect(first).not.toBeNull();

      runMigrations(db);

      expect(marker(itemId)).toBe(first);
    });

    it('does not mark a closed-PR Done Code task with no noOp (still escalates)', () => {
      cacheDoneCode('notion:bf-no-noop');
      seedPullRequestRow('notion:bf-no-noop', 'closed');
      const itemId = seedGateSource('notion:bf-no-noop');

      runMigrations(db);

      expect(marker(itemId)).toBeNull();
      expect(isStructurallyUnresolvableSource('notion:bf-no-noop')).toBe(false);
    });

    it('does not mark a row whose only committed noOp came from a groom/design session', () => {
      cacheDoneCode('notion:bf-groom');
      seedCommittedNoOp('notion:bf-groom', { sessionType: 'groom' });
      const itemId = seedGateSource('notion:bf-groom');

      runMigrations(db);

      expect(marker(itemId)).toBeNull();
    });

    it('does not mark a task with a merged PR row', () => {
      cacheDoneCode('notion:bf-merged');
      seedPullRequestRow('notion:bf-merged', 'merged');
      seedCommittedNoOp('notion:bf-merged');
      const itemId = seedGateSource('notion:bf-merged');

      runMigrations(db);

      expect(marker(itemId)).toBeNull();
    });
  });

  it('returns false for a ✅ Done 💻 Code source with a pull_requests row, regardless of any noOp intent', () => {
    upsertTaskCache(
      'notion:code-with-pr',
      JSON.stringify({ type: '💻 Code', status: '✅ Done' }),
    );
    seedPullRequestRow('notion:code-with-pr');
    seedCommittedNoOp('notion:code-with-pr');

    expect(isStructurallyUnresolvableSource('notion:code-with-pr')).toBe(false);
  });

  it('returns false for a ✅ Done 💻 Code source with no PR row and no committed noOp intent — the genuine dropped-webhook case, which must still escalate', () => {
    upsertTaskCache(
      'notion:code-dropped-webhook',
      JSON.stringify({ type: '💻 Code', status: '✅ Done' }),
    );

    expect(
      isStructurallyUnresolvableSource('notion:code-dropped-webhook'),
    ).toBe(false);
  });

  it('returns false for a 🔄 In Progress 💻 Code source with no PR row and no noOp intent', () => {
    upsertTaskCache(
      'notion:code-in-progress',
      JSON.stringify({ type: '💻 Code', status: '🔄 In Progress' }),
    );

    expect(isStructurallyUnresolvableSource('notion:code-in-progress')).toBe(
      false,
    );
  });

  it('returns false for an ⏭️ Deferred 💻 Code source with no PR row and no committed noOp intent — must still escalate', () => {
    upsertTaskCache(
      'notion:code-deferred-no-noop',
      JSON.stringify({ type: '💻 Code', status: '⏭️ Deferred' }),
    );

    expect(
      isStructurallyUnresolvableSource('notion:code-deferred-no-noop'),
    ).toBe(false);
  });
});
