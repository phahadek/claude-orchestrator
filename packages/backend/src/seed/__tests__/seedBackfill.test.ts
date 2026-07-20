/**
 * Tests for the config-seed backfill tooling
 * (packages/backend/src/seed/seedBackfill.ts).
 *
 * AC: a sample config-seed body parses to the correct seed_item +
 * seed_item_source rows, grouped by source task; min_deployed_commit comes
 * from local_branches.merge_commit_sha and is null for an unmerged source;
 * reruns are idempotent (no duplicate rows); unresolvable / carryover
 * sources land source-less with a null min-commit.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import {
  parseConfigSeedBody,
  resolveSourceId,
  computeSeedKey,
  backfillConfigSeedTask,
} from '../seedBackfill.js';
import { listSeedItemSources } from '../../db/queries.js';

const PROJECT = 'proj-1';
const MILESTONE = 'M11';

function insertMergedSource(taskId: string, mergeCommitSha: string): void {
  const sessionId = `sess-${taskId}`;
  db.prepare(
    `INSERT INTO sessions (session_id, task_id, project_id, status, started_at)
     VALUES (?, ?, ?, 'done', '2026-01-01T00:00:00.000Z')`,
  ).run(sessionId, taskId, PROJECT);
  db.prepare(
    `INSERT INTO local_branches
       (project_id, session_id, branch_name, base_branch, status, review_result, merge_commit_sha, created_at, updated_at)
     VALUES (?, ?, 'feature/x', 'dev', 'merged', 'approved', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run(PROJECT, sessionId, mergeCommitSha);
}

function insertUnmergedSource(taskId: string): void {
  const sessionId = `sess-${taskId}`;
  db.prepare(
    `INSERT INTO sessions (session_id, task_id, project_id, status, started_at)
     VALUES (?, ?, ?, 'done', '2026-01-01T00:00:00.000Z')`,
  ).run(sessionId, taskId, PROJECT);
  db.prepare(
    `INSERT INTO local_branches
       (project_id, session_id, branch_name, base_branch, status, review_result, created_at, updated_at)
     VALUES (?, ?, 'feature/y', 'dev', 'open', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run(PROJECT, sessionId);
}

const SAMPLE_BODY = `
#### Add the seed-state store [task-store-1]
- seed_item table gets a default row for cohort X
- alias flag Y defaults to true

#### Wire the unmerged worker [task-unmerged-1]
- worker default config Z

#### M9/M10 carryover
- legacy alias flag W
`;

beforeEach(() => {
  db.prepare('DELETE FROM seed_item_event').run();
  db.prepare('DELETE FROM seed_item_source').run();
  db.prepare('DELETE FROM seed_item').run();
  db.prepare('DELETE FROM local_branches').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM audit_log').run();
});

describe('parseConfigSeedBody', () => {
  it('groups seeds by source-task heading, capturing the embedded id', () => {
    const groups = parseConfigSeedBody(SAMPLE_BODY);
    expect(groups).toEqual([
      {
        sourceTaskTitle: 'Add the seed-state store',
        embeddedSourceId: 'task-store-1',
        seeds: [
          'seed_item table gets a default row for cohort X',
          'alias flag Y defaults to true',
        ],
      },
      {
        sourceTaskTitle: 'Wire the unmerged worker',
        embeddedSourceId: 'task-unmerged-1',
        seeds: ['worker default config Z'],
      },
      {
        sourceTaskTitle: 'M9/M10 carryover',
        embeddedSourceId: null,
        seeds: ['legacy alias flag W'],
      },
    ]);
  });
});

describe('resolveSourceId', () => {
  it('prefers the embedded id over a title match', () => {
    expect(
      resolveSourceId('Some Task', 'embedded-id', [
        { id: 'title-match-id', title: 'Some Task' },
      ]),
    ).toBe('embedded-id');
  });

  it('falls back to a case/whitespace-insensitive title match', () => {
    expect(
      resolveSourceId('  Some   Task  ', null, [
        { id: 'title-match-id', title: 'some task' },
      ]),
    ).toBe('title-match-id');
  });

  it('returns null when neither an id nor a title match exists', () => {
    expect(resolveSourceId('Unknown Task', null, [])).toBeNull();
  });
});

describe('computeSeedKey', () => {
  it('is deterministic for the same inputs', () => {
    const a = computeSeedKey('p', 'm', 'src', 'spec');
    const b = computeSeedKey('p', 'm', 'src', 'spec');
    expect(a).toBe(b);
  });

  it('differs when any input differs', () => {
    const base = computeSeedKey('p', 'm', 'src', 'spec');
    expect(computeSeedKey('p2', 'm', 'src', 'spec')).not.toBe(base);
    expect(computeSeedKey('p', 'm2', 'src', 'spec')).not.toBe(base);
    expect(computeSeedKey('p', 'm', 'src2', 'spec')).not.toBe(base);
    expect(computeSeedKey('p', 'm', 'src', 'spec2')).not.toBe(base);
  });
});

describe('backfillConfigSeedTask', () => {
  it('writes seed_item + seed_item_source rows grouped by source task, with merge commit derived from local_branches', () => {
    insertMergedSource('task-store-1', 'abc123');
    insertUnmergedSource('task-unmerged-1');

    const result = backfillConfigSeedTask({
      project: PROJECT,
      milestone: MILESTONE,
      taskBody: SAMPLE_BODY,
      now: '2026-07-13T00:00:00.000Z',
    });

    expect(result.createdIds).toHaveLength(4);
    expect(result.skippedIds).toHaveLength(0);
    expect(result.unresolvedSources).toEqual(['M9/M10 carryover']);

    const rows = db
      .prepare('SELECT * FROM seed_item ORDER BY spec')
      .all() as any[];
    expect(rows).toHaveLength(4);

    const storeRow = rows.find((r) => r.spec.startsWith('seed_item table'));
    expect(storeRow.min_deployed_commit).toBe('abc123');
    const sources = listSeedItemSources(storeRow.id);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      source_task_id: 'task-store-1',
      source_task_title: 'Add the seed-state store',
      merge_commit: 'abc123',
    });

    const unmergedRow = rows.find((r) => r.spec.startsWith('worker default'));
    expect(unmergedRow.min_deployed_commit).toBeNull();

    const carryoverRow = rows.find((r) => r.spec.startsWith('legacy alias'));
    expect(carryoverRow.min_deployed_commit).toBeNull();
    expect(listSeedItemSources(carryoverRow.id)).toHaveLength(0);
  });

  it('is idempotent on rerun: no duplicate rows, but a newly-merged source refreshes min_deployed_commit', () => {
    insertUnmergedSource('task-unmerged-1');

    const first = backfillConfigSeedTask({
      project: PROJECT,
      milestone: MILESTONE,
      taskBody: SAMPLE_BODY,
      now: '2026-07-13T00:00:00.000Z',
    });
    expect(first.createdIds).toHaveLength(4);

    // Source that was unmerged on the first pass merges before the rerun.
    db.prepare(
      `UPDATE local_branches SET status = 'merged', merge_commit_sha = 'def456' WHERE session_id = 'sess-task-unmerged-1'`,
    ).run();

    const second = backfillConfigSeedTask({
      project: PROJECT,
      milestone: MILESTONE,
      taskBody: SAMPLE_BODY,
      now: '2026-07-13T01:00:00.000Z',
    });

    expect(second.createdIds).toHaveLength(0);
    expect(second.skippedIds).toHaveLength(4);

    const totalRows = db
      .prepare('SELECT COUNT(*) as n FROM seed_item')
      .get() as { n: number };
    expect(totalRows.n).toBe(4);

    const unmergedRow = db
      .prepare(`SELECT * FROM seed_item WHERE spec LIKE 'worker default%'`)
      .get() as any;
    expect(unmergedRow.min_deployed_commit).toBe('def456');
  });

  it('resolves a source-less title via the candidates list when no id is embedded', () => {
    const body = `#### Carryover Task\n- some seed spec\n`;
    const result = backfillConfigSeedTask({
      project: PROJECT,
      milestone: MILESTONE,
      taskBody: body,
      candidates: [{ id: 'resolved-id', title: 'carryover task' }],
      lookupMergeCommit: () => 'commit-xyz',
      now: '2026-07-13T00:00:00.000Z',
    });

    expect(result.unresolvedSources).toEqual([]);
    const row = db
      .prepare('SELECT * FROM seed_item WHERE spec = ?')
      .get('some seed spec') as any;
    expect(row.min_deployed_commit).toBe('commit-xyz');
    const sources = listSeedItemSources(row.id);
    expect(sources[0].source_task_id).toBe('resolved-id');
  });
});
