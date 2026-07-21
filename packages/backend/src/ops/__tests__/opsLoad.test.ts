/**
 * Tests for the in-process ops-load loader (packages/backend/src/ops/opsLoad.ts).
 *
 * AC: loadOpsContext pre-seeds exactly one pending ops_journal entry per
 * eligible (executable) task; task classification matches a fixture board
 * (executable / dep-blocked / needs-grooming / closed / done, only ✅ Done
 * satisfies a dep); reconcile/trim drops now-Done/Deferred/removed entries
 * and preserves worked fields for still-open tasks; the newly-unblocked
 * signal fires the run after a blocking dep goes ✅ Done.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../config', () => ({
  config: { notionApiKey: 'test', notionDatabaseId: 'test', port: 3000 },
}));

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { execFileSync } from 'child_process';
import { db } from '../../db/db.js';
import {
  insertProject,
  insertMilestone,
  upsertOpsJournalEntry,
  listOpsJournalEntries,
  getOpsJournalEntry,
  insertSession,
  insertLocalBranch,
  markLocalBranchMerged,
  recordProjectDeployedSha,
} from '../../db/queries.js';
import { loadOpsContext } from '../opsLoad.js';
import { getEntry } from '../opsJournal.js';

const TARGET_BOARD = 'target-board-id';
const PROJECT = 'proj-1';
const MILESTONE = 'm-1';
const CONTEXT_PAGE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

beforeEach(() => {
  db.prepare('DELETE FROM ops_journal').run();
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM task_cache').run();
  db.prepare('DELETE FROM milestones').run();
  db.prepare('DELETE FROM projects').run();

  insertProject({
    id: PROJECT,
    name: 'Project One',
    project_dir: '/tmp/project-one',
    context_url: `https://www.notion.so/${CONTEXT_PAGE_ID.replace(/-/g, '')}`,
    github_repo: null,
    task_source: 'notion',
  });
  insertMilestone({
    id: MILESTONE,
    project_id: PROJECT,
    name: 'M1',
    source_id: TARGET_BOARD,
    canonical_short_id: 'M1',
    display_order: 1,
  });
});

// ─── Notion API fixture / mock fetch ───────────────────────────────────────

function titleProp(text: string) {
  return { type: 'title', title: [{ text: { content: text } }] };
}
function selectProp(name: string | null) {
  return { type: 'select', select: name ? { name } : null };
}
function richTextProp(text: string) {
  return {
    type: 'rich_text',
    rich_text: text ? [{ text: { content: text } }] : [],
  };
}

interface FixtureRow {
  id: string;
  name: string;
  type: string;
  status: string;
  dependsOn?: string;
}

let rows: FixtureRow[] = [];
const testingBodies: Record<string, string> = {};

function pageFor(row: FixtureRow) {
  return {
    id: row.id,
    url: `https://notion.so/${row.id}`,
    properties: {
      'Task Name': titleProp(row.name),
      Status: selectProp(row.status),
      Type: selectProp(row.type),
      'Depends On': richTextProp(row.dependsOn ?? ''),
      Notes: richTextProp(''),
    },
  };
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

beforeEach(() => {
  global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';

    const boardMatch = u.match(/\/databases\/([^/]+)\/query/);
    if (boardMatch && method === 'POST') {
      const boardId = boardMatch[1];
      const boardRows = boardId === TARGET_BOARD ? rows : [];
      return jsonResponse({
        results: boardRows.map(pageFor),
        has_more: false,
        next_cursor: null,
      });
    }

    const pageMatch = u.match(/\/pages\/([^/]+)$/);
    if (pageMatch && method === 'GET') {
      const id = pageMatch[1];
      return jsonResponse({
        id,
        url: `https://notion.so/${id}`,
        properties: { Name: titleProp('Context Doc') },
      });
    }

    const blocksMatch = u.match(/\/blocks\/([^/]+)\/children/);
    if (blocksMatch && method === 'GET') {
      const id = blocksMatch[1];
      const body = testingBodies[id];
      const results = body
        ? [
            {
              id: 'block-1',
              type: 'paragraph',
              paragraph: { rich_text: [{ text: { content: body } }] },
            },
          ]
        : [];
      return jsonResponse({ results, has_more: false, next_cursor: null });
    }

    throw new Error(`unmocked fetch ${method} ${u}`);
  }) as unknown as typeof fetch;
});

describe('loadOpsContext — classification', () => {
  it('classifies tasks into executable / dep-blocked / needs-grooming / closed / done', async () => {
    rows = [
      {
        id: 'task-op-ready',
        name: 'Op ready no deps',
        type: '🔧 Operational',
        status: '🗂️ Ready',
      },
      {
        id: 'task-op-blocked',
        name: 'Op blocked on ready dep',
        type: '🔧 Operational',
        status: '🗂️ Ready',
        dependsOn: 'task-op-ready',
      },
      {
        id: 'task-inv-inprogress',
        name: 'Investigation in progress, dep done',
        type: '🔎 Investigation',
        status: '🔄 In Progress',
        dependsOn: 'task-done',
      },
      {
        id: 'task-backlog',
        name: 'Needs grooming',
        type: '🔎 Investigation',
        status: '🔲 Backlog',
      },
      {
        id: 'task-done',
        name: 'Already done',
        type: '🔧 Operational',
        status: '✅ Done',
      },
      {
        id: 'task-review',
        name: 'In review',
        type: '🔧 Operational',
        status: '👀 In Review',
      },
      {
        id: 'task-tooling',
        name: 'Leftover tooling',
        type: '🛠️ Tooling',
        status: '🗂️ Ready',
      },
      {
        id: 'task-code',
        name: 'Not an ops type',
        type: '💻 Code',
        status: '🗂️ Ready',
      },
      {
        id: 'task-deferred-dep',
        name: 'Blocked by deferred dep',
        type: '🔧 Operational',
        status: '🗂️ Ready',
        dependsOn: 'task-deferred',
      },
      {
        id: 'task-deferred',
        name: 'Deferred',
        type: '🔧 Operational',
        status: '⏭️ Deferred',
      },
    ];

    const result = await loadOpsContext(MILESTONE);

    expect(result.worklist.executable.map((t) => t.id).sort()).toEqual(
      ['task-inv-inprogress', 'task-op-ready'].sort(),
    );
    expect(result.worklist.dep_blocked.map((t) => t.id).sort()).toEqual(
      ['task-op-blocked', 'task-deferred-dep'].sort(),
    );
    expect(result.worklist.needs_grooming.map((t) => t.id)).toEqual([
      'task-backlog',
    ]);
    expect(result.worklist.closed_not_done.map((t) => t.id)).toEqual([
      'task-review',
    ]);
    expect(result.worklist.leftover_tooling.map((t) => t.id)).toEqual([
      'task-tooling',
    ]);
    expect(result.boards.target.counts.done_or_deferred).toBe(2);

    // Only ✅ Done satisfies a dep — Ready and Deferred both block.
    const blocked = result.worklist.dep_blocked.find(
      (t) => t.id === 'task-op-blocked',
    );
    expect(blocked?.blockingDepIds).toEqual(['task-op-ready']);
    const deferredBlocked = result.worklist.dep_blocked.find(
      (t) => t.id === 'task-deferred-dep',
    );
    expect(deferredBlocked?.blockingDepIds).toEqual(['task-deferred']);
  });

  it('excludes test-authoring 🧪 Testing tasks and folds observational Testing in as executable', async () => {
    rows = [
      {
        id: 'task-testing-obs',
        name: 'Observational test',
        type: '🧪 Testing',
        status: '🗂️ Ready',
      },
      {
        id: 'task-testing-authoring',
        name: 'Authoring test',
        type: '🧪 Testing',
        status: '🗂️ Ready',
      },
    ];
    testingBodies['task-testing-authoring'] = 'Mode: 🧪 Testing · authoring';

    const result = await loadOpsContext(MILESTONE);

    expect(result.worklist.executable.map((t) => t.id)).toEqual([
      'task-testing-obs',
    ]);
    expect(result.worklist.test_authoring.map((t) => t.id)).toEqual([
      'task-testing-authoring',
    ]);
  });

  it('loads the project master context page', async () => {
    rows = [];
    const result = await loadOpsContext(MILESTONE);
    expect(result.contextPages).toHaveLength(1);
    expect(result.contextPages[0].id).toBe(CONTEXT_PAGE_ID);
    expect(result.contextPages[0].title).toBe('Project Context');
  });
});

describe('loadOpsContext — ops_journal pre-seed / reconcile', () => {
  it('pre-seeds exactly one pending entry per executable task', async () => {
    rows = [
      {
        id: 'exec-1',
        name: 'Executable 1',
        type: '🔧 Operational',
        status: '🗂️ Ready',
      },
      {
        id: 'exec-2',
        name: 'Executable 2',
        type: '🔎 Investigation',
        status: '🔄 In Progress',
      },
      {
        id: 'blocked-1',
        name: 'Blocked',
        type: '🔧 Operational',
        status: '🗂️ Ready',
        dependsOn: 'exec-1',
      },
    ];

    await loadOpsContext(MILESTONE);

    const entries = listOpsJournalEntries();
    expect(entries.map((e) => e.task_id).sort()).toEqual(['exec-1', 'exec-2']);
    for (const e of entries) expect(e.state).toBe('pending');
  });

  it('drops entries for tasks now Done/Deferred/removed and preserves worked fields for still-open tasks', async () => {
    rows = [
      {
        id: 'still-open',
        name: 'Still open',
        type: '🔧 Operational',
        status: '🗂️ Ready',
      },
    ];

    upsertOpsJournalEntry({
      task_id: 'still-open',
      project: PROJECT,
      milestone: MILESTONE,
      state: 'candidate',
      disposition: null,
      worked_in: null,
      evidence: JSON.stringify(['proof']),
      finding_or_proposal: null,
      falsification: null,
      filed_followons: null,
      needs_from_operator: null,
      resolution: null,
      updated_at: new Date(0).toISOString(),
    } as never);
    upsertOpsJournalEntry({
      task_id: 'now-gone',
      project: PROJECT,
      milestone: MILESTONE,
      state: 'staged-proposal',
      disposition: null,
      worked_in: null,
      evidence: null,
      finding_or_proposal: null,
      falsification: null,
      filed_followons: null,
      needs_from_operator: null,
      resolution: null,
      updated_at: new Date(0).toISOString(),
    } as never);

    await loadOpsContext(MILESTONE);

    expect(getOpsJournalEntry('now-gone')).toBeUndefined();
    const stillOpen = getEntry('still-open');
    expect(stillOpen?.state).toBe('candidate');
    expect(stillOpen?.evidence).toEqual(['proof']);
  });

  it('does not touch ops_journal entries belonging to other projects/milestones', async () => {
    rows = [];
    upsertOpsJournalEntry({
      task_id: 'other-task',
      project: 'other-project',
      milestone: 'other-milestone',
      state: 'pending',
      disposition: null,
      worked_in: null,
      evidence: null,
      finding_or_proposal: null,
      falsification: null,
      filed_followons: null,
      needs_from_operator: null,
      resolution: null,
      updated_at: new Date(0).toISOString(),
    } as never);

    await loadOpsContext(MILESTONE);

    expect(getOpsJournalEntry('other-task')).toBeDefined();
  });

  it('fires the newly-unblocked signal the run after a blocking dep goes ✅ Done', async () => {
    rows = [
      {
        id: 'dep-task',
        name: 'Dependency',
        type: '🔧 Operational',
        status: '🗂️ Ready',
      },
      {
        id: 'blocked-task',
        name: 'Blocked task',
        type: '🔧 Operational',
        status: '🗂️ Ready',
        dependsOn: 'dep-task',
      },
    ];

    const first = await loadOpsContext(MILESTONE);
    expect(first.worklist.dep_blocked.map((t) => t.id)).toEqual([
      'blocked-task',
    ]);
    expect(first.worklist.newly_unblocked).toEqual([]);

    // Dep resolves; bust the 60s board cache so the second run re-fetches.
    db.prepare('DELETE FROM task_cache WHERE task_id LIKE ?').run('board:%');
    rows = [
      {
        id: 'dep-task',
        name: 'Dependency',
        type: '🔧 Operational',
        status: '✅ Done',
      },
      {
        id: 'blocked-task',
        name: 'Blocked task',
        type: '🔧 Operational',
        status: '🗂️ Ready',
      },
    ];

    const second = await loadOpsContext(MILESTONE);
    expect(second.worklist.executable.map((t) => t.id)).toContain(
      'blocked-task',
    );
    expect(second.worklist.newly_unblocked.map((t) => t.id)).toEqual([
      'blocked-task',
    ]);
  });
});

describe('loadOpsContext — dep deploy-gating', () => {
  // Real commit shas from this repo's own history, so createLocalGitAncestrySource's
  // `git merge-base --is-ancestor` has a genuine ancestry relationship to check
  // against, run with project_dir pointed at this checkout.
  const repoDir = process.cwd();
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoDir,
  })
    .toString()
    .trim();
  const ancestorSha = execFileSync('git', ['rev-parse', 'HEAD~3'], {
    cwd: repoDir,
  })
    .toString()
    .trim();

  function seedMergedDep(taskId: string, mergeCommitSha: string) {
    const sessionId = `sess-${taskId}`;
    // getMergeCommitForTask normalizes bare ids to `notion:<id>` before
    // looking up sessions.task_id — match that here.
    insertSession({
      session_id: sessionId,
      task_id: `notion:${taskId}`,
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
      project_id: PROJECT,
      session_id: sessionId,
      branch_name: `feature/${taskId}`,
      base_branch: 'dev',
      status: 'open',
      review_result: null,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    });
    markLocalBranchMerged(branch.id, mergeCommitSha);
  }

  beforeEach(() => {
    // Point the fixture project at this real git checkout so the ancestry
    // check has a genuine repo to run `git merge-base` against.
    db.prepare('UPDATE projects SET project_dir = ? WHERE id = ?').run(
      repoDir,
      PROJECT,
    );
    db.prepare('DELETE FROM sessions').run();
    db.prepare('DELETE FROM local_branches').run();
    db.prepare('DELETE FROM project_deployed_sha').run();
  });

  it('classifies a ✅ Done-but-undeployed dep as dep_blocked, not executable', async () => {
    seedMergedDep('dep-task', headSha);
    // Deployed SHA is an older commit that does not contain the dep's merge commit.
    recordProjectDeployedSha(PROJECT, ancestorSha);

    rows = [
      {
        id: 'dep-task',
        name: 'Dependency',
        type: '🔧 Operational',
        status: '✅ Done',
      },
      {
        id: 'ops-task',
        name: 'Depends on undeployed dep',
        type: '🔧 Operational',
        status: '🗂️ Ready',
        dependsOn: 'dep-task',
      },
    ];

    const result = await loadOpsContext(MILESTONE);

    expect(result.worklist.dep_blocked.map((t) => t.id)).toEqual([
      'ops-task',
    ]);
    expect(result.worklist.executable.map((t) => t.id)).not.toContain(
      'ops-task',
    );
    const blocked = result.worklist.dep_blocked.find(
      (t) => t.id === 'ops-task',
    );
    expect(blocked?.blockingDepIds).toEqual(['dep-task']);
    expect(blocked?.blockingDepTitles).toEqual(['Dependency']);
  });

  it('becomes executable once the dep is ✅ Done and its merge commit is deployed', async () => {
    seedMergedDep('dep-task', headSha);
    // Deployed SHA now covers (is a descendant of / equal to) the dep's merge commit.
    recordProjectDeployedSha(PROJECT, headSha);

    rows = [
      {
        id: 'dep-task',
        name: 'Dependency',
        type: '🔧 Operational',
        status: '✅ Done',
      },
      {
        id: 'ops-task',
        name: 'Depends on deployed dep',
        type: '🔧 Operational',
        status: '🗂️ Ready',
        dependsOn: 'dep-task',
      },
    ];

    const result = await loadOpsContext(MILESTONE);

    expect(result.worklist.executable.map((t) => t.id)).toContain(
      'ops-task',
    );
    expect(result.worklist.dep_blocked.map((t) => t.id)).not.toContain(
      'ops-task',
    );
  });
});
