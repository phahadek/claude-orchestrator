import { describe, it, expect, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import {
  upsertTaskCache,
  isStructurallyUnresolvableSource,
} from '../queries.js';

function seedCommittedNoOp(taskId: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO staged_intent
      (id, kind, payload, payload_hash, task_id, project_id, state, created_at, updated_at)
     VALUES (?, 'planning.noOp', ?, 'hash', ?, 'proj-1', 'committed', ?, ?)`,
  ).run(
    `noop-${taskId}`,
    JSON.stringify({ taskId, reason: 'already satisfied elsewhere' }),
    taskId,
    now,
    now,
  );
}

function seedPullRequestRow(taskId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO pull_requests
      (pr_number, pr_url, task_id, repo, state, draft, created_at, updated_at, synced_at)
     VALUES (?, ?, ?, 'acme/repo', 'open', 0, ?, ?, ?)`,
  ).run(
    1,
    `https://github.com/acme/repo/pull/${taskId}`,
    taskId,
    now,
    now,
    now,
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

  it('returns true for a ✅ Done 💻 Code source with no PR row and a committed planning.noOp intent naming it', () => {
    upsertTaskCache(
      'notion:code-noop-done',
      JSON.stringify({ type: '💻 Code', status: '✅ Done' }),
    );
    seedCommittedNoOp('notion:code-noop-done');

    expect(isStructurallyUnresolvableSource('notion:code-noop-done')).toBe(
      true,
    );
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

  it('returns true for an ⏭️ Deferred 💻 Code source with no PR row and a committed noOp intent', () => {
    upsertTaskCache(
      'notion:code-deferred-noop',
      JSON.stringify({ type: '💻 Code', status: '⏭️ Deferred' }),
    );
    seedCommittedNoOp('notion:code-deferred-noop');

    expect(isStructurallyUnresolvableSource('notion:code-deferred-noop')).toBe(
      true,
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
