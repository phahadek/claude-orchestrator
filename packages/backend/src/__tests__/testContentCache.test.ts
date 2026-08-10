import { describe, it, expect, vi } from 'vitest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  const db = setupTestDb();
  return { db };
});

import {
  getTestContentCacheResult,
  upsertTestContentCacheResult,
  deleteTestContentCacheResult,
} from '../db/queries.js';

// ── orchestrator_test_content_cache — F2's shared cache ──────────────────────
//
// Keyed by (project_id, content_hash) rather than (pr_number, repo, sha) —
// this is what lets ReviewOrchestrator.runTestPipeline (the push-triggered
// pre-run) and PreReviewPipeline.buildTestsStage (the review pipeline's own
// check) share one cached verdict for the same tree content, and what
// PRMergeWatcher's merge-gate read consults directly.

describe('orchestrator_test_content_cache queries', () => {
  it('returns undefined for a content hash with no prior result', () => {
    expect(getTestContentCacheResult('proj-1', 'hash-a')).toBeUndefined();
  });

  it('a write from one caller is visible to a different caller reading the same key — the "shared cache" property', () => {
    // Simulates ReviewOrchestrator.runTestPipeline writing the result...
    upsertTestContentCacheResult('proj-1', 'hash-a', true, 'all tests passed');

    // ...and PreReviewPipeline.buildTestsStage (or PRMergeWatcher's
    // merge-gate read) independently reading it back by the same key.
    const result = getTestContentCacheResult('proj-1', 'hash-a');
    expect(result).toMatchObject({
      project_id: 'proj-1',
      content_hash: 'hash-a',
      passed: 1,
      output: 'all tests passed',
    });
  });

  it('scopes by project_id — a hit in one project is not visible to another project with the same content hash', () => {
    upsertTestContentCacheResult('proj-1', 'shared-hash', true, 'ok');
    expect(getTestContentCacheResult('proj-2', 'shared-hash')).toBeUndefined();
  });

  it('upsert overwrites an existing entry for the same key (flaky-rerun repopulation)', () => {
    upsertTestContentCacheResult('proj-1', 'hash-b', false, 'flaky failure');
    expect(getTestContentCacheResult('proj-1', 'hash-b')?.passed).toBe(0);

    upsertTestContentCacheResult('proj-1', 'hash-b', true, 'passed on rerun');
    const result = getTestContentCacheResult('proj-1', 'hash-b');
    expect(result?.passed).toBe(1);
    expect(result?.output).toBe('passed on rerun');
  });

  it('delete removes the entry — the flaky.confirm invalidation path', () => {
    upsertTestContentCacheResult('proj-1', 'hash-c', true, 'ok');
    expect(getTestContentCacheResult('proj-1', 'hash-c')).toBeDefined();

    deleteTestContentCacheResult('proj-1', 'hash-c');
    expect(getTestContentCacheResult('proj-1', 'hash-c')).toBeUndefined();
  });
});
