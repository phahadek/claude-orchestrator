/**
 * Tests for the gate-state backfill tooling (packages/backend/src/gate/gateBackfill.ts).
 *
 * AC: a sample Gate body parses to gate_item + gate_item_source rows grouped
 * by source task (via heading-[id] or a title→id resolver); min_deployed_commit
 * comes from local_branches.merge_commit_sha (null when unmerged); classification
 * defaults to needs-triage; re-running is idempotent; unresolvable/M9-M10
 * carryover sources land source-less with a null min-commit.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import {
  insertSession,
  insertLocalBranch,
  markLocalBranchMerged,
  upsertTaskCache,
} from '../../db/queries.js';
import {
  parseGateBody,
  backfillGateBody,
  taskCacheTitleResolver,
  type TaskIdResolver,
} from '../gateBackfill.js';
import { getItem, listByMilestone } from '../gateStore.js';

beforeEach(() => {
  db.prepare('DELETE FROM gate_item_event').run();
  db.prepare('DELETE FROM gate_item_source').run();
  db.prepare('DELETE FROM gate_item').run();
  db.prepare('DELETE FROM local_branches').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM task_cache').run();
  db.prepare('DELETE FROM audit_log').run();
});

function mergeSourceTask(taskId: string, commitSha: string): void {
  insertSession({
    session_id: `session:${taskId}`,
    task_id: taskId,
    task_url: null,
    project_context_url: null,
    status: 'done',
    started_at: 0,
    session_type: 'standard',
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
  const branch = insertLocalBranch({
    project_id: 'polimarket-analyser',
    session_id: `session:${taskId}`,
    branch_name: `feature/${taskId}`,
    base_branch: 'dev',
    status: 'open',
    review_result: null,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  });
  markLocalBranchMerged(branch.id, commitSha);
}

const SAMPLE_BODY = `
#### Add env var to deploy script [notion:src-a]
- Verify the deploy script writes the new env var
- Confirm the var is read at boot (Prod-Mutating)

#### Rename the config key [notion:src-b]
- Confirm no stale references to the old key name

#### Legacy title-only item
- Confirm the legacy path still resolves

#### M9/M10 carryover: retag backfill [notion:src-carryover]
- Spot-check ten retagged rows
`;

describe('parseGateBody', () => {
  it('groups items under their #### <source-task> [id] heading', () => {
    const groups = parseGateBody(SAMPLE_BODY);
    expect(groups).toHaveLength(4);
    expect(groups[0]).toMatchObject({
      sourceTitle: 'Add env var to deploy script',
      sourceId: 'notion:src-a',
      isCarryover: false,
      items: [
        'Verify the deploy script writes the new env var',
        'Confirm the var is read at boot (Prod-Mutating)',
      ],
    });
    expect(groups[2]).toMatchObject({
      sourceTitle: 'Legacy title-only item',
      sourceId: null,
    });
    expect(groups[3].isCarryover).toBe(true);
  });
});

describe('backfillGateBody', () => {
  it('creates a gate_item + gate_item_source per item, source resolved via heading [id]', () => {
    mergeSourceTask('notion:src-a', 'abc123');
    const result = backfillGateBody(SAMPLE_BODY, {
      project: 'polimarket-analyser',
      milestone: 'M12',
      now: new Date(0).toISOString(),
    });
    expect(result.created).toBe(5);

    const items = listByMilestone('polimarket-analyser', 'M12');
    const first = items.find(
      (i) => i.text === 'Verify the deploy script writes the new env var',
    )!;
    expect(first.sources).toEqual([
      expect.objectContaining({
        sourceTaskId: 'notion:src-a',
        sourceTaskTitle: 'Add env var to deploy script',
        mergeCommit: 'abc123',
      }),
    ]);
    expect(first.minDeployedCommit).toBe('abc123');
    expect(first.classification).toBe('needs-triage');
  });

  it('reads an explicit trailing (Classification) tag off the item text', () => {
    backfillGateBody(SAMPLE_BODY, {
      project: 'polimarket-analyser',
      milestone: 'M12',
      now: new Date(0).toISOString(),
    });
    const items = listByMilestone('polimarket-analyser', 'M12');
    const triaged = items.find(
      (i) => i.text === 'Confirm the var is read at boot',
    )!;
    expect(triaged.classification).toBe('Prod-Mutating');
  });

  it('leaves min_deployed_commit null when the source is unmerged', () => {
    const result = backfillGateBody(SAMPLE_BODY, {
      project: 'polimarket-analyser',
      milestone: 'M12',
      now: new Date(0).toISOString(),
    });
    const items = listByMilestone('polimarket-analyser', 'M12');
    const item = items.find(
      (i) => i.text === 'Confirm no stale references to the old key name',
    )!;
    expect(item.minDeployedCommit).toBeUndefined();
    expect(result.created).toBe(5);
  });

  it('resolves legacy title-only headings against the milestone board cache', () => {
    upsertTaskCache(
      'board:milestone-db-id-12',
      JSON.stringify([
        { id: 'notion:src-legacy', title: 'Legacy title-only item' },
      ]),
    );
    mergeSourceTask('notion:src-legacy', 'legacy-sha');
    backfillGateBody(SAMPLE_BODY, {
      project: 'polimarket-analyser',
      milestone: 'M12',
      milestoneBoardIds: ['milestone-db-id-12'],
      now: new Date(0).toISOString(),
    });
    const items = listByMilestone('polimarket-analyser', 'M12');
    const item = items.find(
      (i) => i.text === 'Confirm the legacy path still resolves',
    )!;
    expect(item.sources[0].sourceTaskId).toBe('notion:src-legacy');
    expect(item.minDeployedCommit).toBe('legacy-sha');
  });

  it('leaves an unresolvable title-only heading source-less with a null min-commit', () => {
    backfillGateBody(SAMPLE_BODY, {
      project: 'polimarket-analyser',
      milestone: 'M12',
      now: new Date(0).toISOString(),
    });
    const items = listByMilestone('polimarket-analyser', 'M12');
    const item = items.find(
      (i) => i.text === 'Confirm the legacy path still resolves',
    )!;
    expect(item.sources).toEqual([]);
    expect(item.minDeployedCommit).toBeUndefined();
  });

  it('treats M9/M10 carryover blocks as source-less with a null min-commit even with an [id]', () => {
    mergeSourceTask('notion:src-carryover', 'carryover-sha');
    backfillGateBody(SAMPLE_BODY, {
      project: 'polimarket-analyser',
      milestone: 'M12',
      now: new Date(0).toISOString(),
    });
    const items = listByMilestone('polimarket-analyser', 'M12');
    const item = items.find((i) => i.text === 'Spot-check ten retagged rows')!;
    expect(item.sources).toEqual([]);
    expect(item.minDeployedCommit).toBeUndefined();
  });

  it('is idempotent: re-running the same body creates no duplicate rows', () => {
    mergeSourceTask('notion:src-a', 'abc123');
    const first = backfillGateBody(SAMPLE_BODY, {
      project: 'polimarket-analyser',
      milestone: 'M12',
      now: new Date(0).toISOString(),
    });
    const before = listByMilestone('polimarket-analyser', 'M12').length;

    const second = backfillGateBody(SAMPLE_BODY, {
      project: 'polimarket-analyser',
      milestone: 'M12',
      now: new Date(1).toISOString(),
    });
    const after = listByMilestone('polimarket-analyser', 'M12').length;

    expect(first.created).toBe(5);
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(5);
    expect(after).toBe(before);
    expect(second.itemIds.sort()).toEqual(first.itemIds.sort());
  });

  it('mints a fresh row when the same source gets a differently-worded item (hash keys on item text)', () => {
    backfillGateBody('#### Src [notion:src-x]\n- Original wording\n', {
      project: 'polimarket-analyser',
      milestone: 'M12',
      now: new Date(0).toISOString(),
    });
    const result = backfillGateBody(
      '#### Src [notion:src-x]\n- Edited wording\n',
      {
        project: 'polimarket-analyser',
        milestone: 'M12',
        now: new Date(0).toISOString(),
      },
    );
    expect(result.created).toBe(1);
    expect(listByMilestone('polimarket-analyser', 'M12')).toHaveLength(2);
  });

  it('supports an injected resolver and merge-commit lookup', () => {
    const resolver: TaskIdResolver = {
      resolveByTitle: vi.fn().mockReturnValue('notion:injected'),
    };
    const result = backfillGateBody('#### Untagged source\n- One item\n', {
      project: 'polimarket-analyser',
      milestone: 'M12',
      now: new Date(0).toISOString(),
      resolver,
      mergeCommitLookup: { getMergeCommit: () => 'injected-sha' },
    });
    expect(result.created).toBe(1);
    const item = getItem(result.itemIds[0]);
    expect(item?.sources[0].sourceTaskId).toBe('notion:injected');
    expect(item?.minDeployedCommit).toBe('injected-sha');
  });
});

describe('taskCacheTitleResolver', () => {
  it('matches titles case/whitespace-insensitively across the given board ids', () => {
    upsertTaskCache(
      'board:m1',
      JSON.stringify([{ id: 'notion:t1', title: '  Some Task  ' }]),
    );
    expect(
      taskCacheTitleResolver.resolveByTitle('some task', ['m0', 'm1']),
    ).toBe('notion:t1');
  });

  it('returns null when no board has a matching title', () => {
    expect(taskCacheTitleResolver.resolveByTitle('nope', ['m1'])).toBeNull();
  });
});
