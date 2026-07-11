/**
 * In-process port of the vendored ops-load.mjs loader (Technical Architecture:
 * see the /ops skill + the Technical Architecture Notion page). Where the
 * vendored script shelled out to sibling scripts and wrote a file-based
 * ops-state.json, this module drives the same three on-load jobs entirely
 * in-process against the backend's own stores:
 *
 *   1. Load the fixed master context page(s) for the project via NotionClient
 *      (never a subprocess).
 *   2. Query the target board + neighbour (prior) boards, classify every
 *      🔧 Operational / 🔎 Investigation / observational 🧪 Testing task into
 *      executable / dep-blocked / needs-grooming / closed-not-done / done,
 *      resolve deps (only ✅ Done satisfies a hard dep), flag leftover
 *      🛠️ Tooling, and exclude test-authoring 🧪 Testing.
 *   3. Pre-seed one pending ops_journal entry per executable task (via
 *      reconcileJournal — which also preserves worked fields for still-open
 *      tasks and trims entries whose task is now Done/Deferred/removed), and
 *      compute the newly-unblocked signal.
 *
 * This module is a pure read against Notion; the only write is to ops_journal
 * via reconcileJournal. No session-facing transport, no Notion write-back.
 */

import {
  getMilestoneById,
  getProjectRowById,
  listMilestonesByProject,
  getTaskCache,
  upsertTaskCache,
  listOpsJournalEntries,
} from '../db/queries';
import { NotionClient, normalizeNotionId } from '../notion/NotionClient';
import type { NotionTask } from '../notion/types';
import { reconcileJournal, type OpsBoardTaskRow } from './opsJournal';
import { formatTaskId } from '../tasks/taskId';

// ─── Notion status vocabulary (matches the values NotionClient reads/writes) ──
const STATUS = {
  backlog: '🔲 Backlog',
  ready: '🗂️ Ready',
  inProgress: '🔄 In Progress',
  inReview: '👀 In Review',
  done: '✅ Done',
  deferred: '⏭️ Deferred',
} as const;

// /ops targets Type = "🔧 Operational" OR "🔎 Investigation", PLUS observational /
// E2E "🧪 Testing" folded in as an Investigation variant. Tolerant of the emoji
// being stripped — match on the word. Legacy "🛠️ Tooling" is surfaced separately
// as needing reclassification. Test-AUTHORING Testing tasks are excluded (💻 Code).
const opsTypeMatcher = (t: string) => /operational|investigation/i.test(t);
const testingTypeMatcher = (t: string) => /testing/i.test(t);
const toolingTypeMatcher = (t: string) => /tooling/i.test(t);
const modeOf = (type: string): 'operational' | 'investigation' =>
  /investigation/i.test(type) ? 'investigation' : 'operational';

/**
 * A 🧪 Testing task folds into /ops only as observational / E2E work.
 * Test-authoring carries an explicit `Mode: 🧪 Testing · authoring` marker in
 * the page body; absent one we default to observational (fold in).
 */
function isTestAuthoring(markdown: string): boolean {
  const m = markdown.match(
    /mode\s*:.*testing.*?(authoring|observational|e2e|end[-\s]?to[-\s]?end)/is,
  );
  return !!m && /authoring/i.test(m[1]);
}

const normId = (id: string) => id.replace(/-/g, '').toLowerCase();

// ─── result shapes ──────────────────────────────────────────────────────────

interface PageDoc {
  id: string;
  title: string;
  markdown: string;
}

interface BoardRef {
  id: string; // milestone id
  board: string; // Notion board (data source) id
}

interface TaskRef {
  id: string;
  title: string;
  status: string;
  url: string;
}

interface OpsTaskEntry extends TaskRef {
  type: string;
  mode: 'operational' | 'investigation';
  priority?: string;
  dependsOn: string[];
  blockingDepIds: string[];
  depStatus: 'ready' | 'blocked';
}

interface OpsBoardSummary {
  milestone: string;
  board: string;
  counts: {
    executable: number;
    dep_blocked: number;
    needs_grooming: number;
    closed_not_done: number;
    done_or_deferred: number;
    leftover_tooling: number;
    test_authoring_excluded: number;
  };
}

export interface OpsLoadResult {
  contextPages: PageDoc[];
  boards: { target: OpsBoardSummary; neighbours: BoardRef[] };
  worklist: {
    executable: OpsTaskEntry[];
    dep_blocked: OpsTaskEntry[];
    needs_grooming: OpsTaskEntry[];
    closed_not_done: OpsTaskEntry[];
    leftover_tooling: TaskRef[];
    test_authoring: TaskRef[];
    /** Executable tasks that were dep-blocked as of the previous loadOpsContext
     *  run for this project/milestone, and whose blocking dep(s) have since
     *  gone ✅ Done. */
    newly_unblocked: OpsTaskEntry[];
  };
}

export interface OpsLoadOptions {
  /** Overrides/validates the project the milestone resolves to. */
  project?: string;
  /** Extra fixed context pages to load alongside the project's master context page. */
  contextPages?: { id: string; title?: string }[];
  /** Max number of prior (lower display_order) milestones to load as neighbour boards. */
  neighbourLimit?: number;
  /** Injectable for tests; defaults to a fresh NotionClient. */
  notion?: NotionClient;
}

function depBlockedCacheKey(project: string, milestone: string): string {
  return `ops-dep-blocked:${project}:${milestone}`;
}

function toTaskRef(t: NotionTask): TaskRef {
  return { id: t.id, title: t.title, status: t.status, url: t.notionUrl };
}

/**
 * Assemble the /ops context for a milestone: load the master context page(s),
 * classify the target board's Operational/Investigation/observational-Testing
 * tasks, and pre-seed/reconcile/trim the ops_journal staging store.
 */
export async function loadOpsContext(
  milestoneId: string,
  opts: OpsLoadOptions = {},
): Promise<OpsLoadResult> {
  const milestone = getMilestoneById(milestoneId);
  if (!milestone) throw new Error(`ops-load: unknown milestone ${milestoneId}`);
  if (opts.project && opts.project !== milestone.project_id) {
    throw new Error(
      `ops-load: milestone ${milestoneId} belongs to project ${milestone.project_id}, not ${opts.project}`,
    );
  }
  const project = milestone.project_id;
  const board = milestone.source_id;
  if (!board)
    throw new Error(
      `ops-load: milestone ${milestoneId} has no Notion board (source_id) configured`,
    );

  const notion = opts.notion ?? new NotionClient();

  // ── neighbours: prior milestones (by display_order) on the same project ──
  const neighbourLimit = opts.neighbourLimit ?? 3;
  const siblings = listMilestonesByProject(project).filter(
    (m) => m.id !== milestone.id && m.source_id,
  );
  const priorSiblings = siblings.filter(
    (m) => m.display_order < milestone.display_order,
  );
  const neighbours: BoardRef[] = priorSiblings
    .slice(-neighbourLimit)
    .map((m) => ({ id: m.id, board: m.source_id as string }));

  // ── Job 1: load the master context page(s) ──────────────────────────────
  const projectRow = getProjectRowById(project);
  const contextPageIds: { id: string; title?: string }[] = [];
  const masterId = projectRow?.context_url
    ? normalizeNotionId(projectRow.context_url)
    : null;
  if (masterId) contextPageIds.push({ id: masterId, title: 'Project Context' });
  for (const p of opts.contextPages ?? []) contextPageIds.push(p);

  const contextPages: PageDoc[] = [];
  for (const p of contextPageIds) {
    const { title, markdown } = await notion.fetchPageMarkdown(
      formatTaskId('notion', p.id),
    );
    contextPages.push({ id: p.id, title: p.title ?? title, markdown });
  }

  // ── Job 2: query target + neighbour boards, resolve deps, classify ──────
  const targetRows = await notion.fetchBoardTasks(board);
  const neighbourRowSets = await Promise.all(
    neighbours.map((n) => notion.fetchBoardTasks(n.board)),
  );

  const depMap = new Map<string, { status: string; title: string }>();
  for (const r of targetRows)
    depMap.set(normId(r.id), { status: r.status, title: r.title });
  for (const rows of neighbourRowSets)
    for (const r of rows)
      depMap.set(normId(r.id), { status: r.status, title: r.title });

  const executable: OpsTaskEntry[] = [];
  const depBlocked: OpsTaskEntry[] = [];
  const needsGrooming: OpsTaskEntry[] = [];
  const closedNotDone: OpsTaskEntry[] = [];
  const done: TaskRef[] = [];
  const leftoverTooling: TaskRef[] = [];
  const testAuthoring: TaskRef[] = [];

  for (const row of targetRows) {
    const { type, status } = row;
    const isDone = status === STATUS.done || status === STATUS.deferred;

    // Flag any still-open legacy 🛠️ Tooling — the split retired it.
    if (toolingTypeMatcher(type) && !isDone) {
      leftoverTooling.push(toTaskRef(row));
      continue;
    }

    const isOps = opsTypeMatcher(type);
    const isTesting = testingTypeMatcher(type);
    if (!isOps && !isTesting) continue;

    if (isDone) {
      done.push(toTaskRef(row));
      continue;
    }

    const isInReview = status === STATUS.inReview;
    const isBacklog = status === STATUS.backlog;
    const isExecutable =
      status === STATUS.ready || status === STATUS.inProgress;
    if (!isExecutable && !isBacklog && !isInReview) continue;

    let mode: 'operational' | 'investigation';
    if (isTesting) {
      const { markdown } = await notion.fetchPageMarkdown(
        formatTaskId('notion', row.id),
      );
      if (isTestAuthoring(markdown)) {
        testAuthoring.push(toTaskRef(row));
        continue;
      }
      mode = 'investigation';
    } else {
      mode = modeOf(type);
    }

    // Only ✅ Done satisfies a hard dep — 🗂️ Ready and ⏭️ Deferred both block.
    // Unresolved/external deps (on a board not loaded) are not counted as blocking.
    const blockingDepIds = row.dependsOn.filter((depId) => {
      const dep = depMap.get(normId(depId));
      return dep !== undefined && dep.status !== STATUS.done;
    });
    const depStatus: 'ready' | 'blocked' =
      blockingDepIds.length === 0 ? 'ready' : 'blocked';

    const entry: OpsTaskEntry = {
      ...toTaskRef(row),
      type,
      mode,
      priority: row.priority,
      dependsOn: row.dependsOn,
      blockingDepIds,
      depStatus,
    };

    if (isExecutable) {
      (depStatus === 'blocked' ? depBlocked : executable).push(entry);
    } else if (isBacklog) {
      needsGrooming.push(entry);
    } else if (isInReview) {
      closedNotDone.push(entry);
    }
  }

  // ── newly-unblocked signal ───────────────────────────────────────────────
  // Tasks that were dep-blocked as of the previous run for this project/milestone
  // whose blocking dep(s) have since gone ✅ Done (i.e. now executable).
  const cacheKey = depBlockedCacheKey(project, milestoneId);
  const priorRow = getTaskCache(cacheKey);
  const priorBlockedIds: Set<string> = new Set(
    priorRow ? (JSON.parse(priorRow.raw_json) as string[]) : [],
  );
  const newlyUnblocked = executable.filter((t) => priorBlockedIds.has(t.id));
  upsertTaskCache(cacheKey, JSON.stringify(depBlocked.map((t) => t.id)));

  // ── Job 3: pre-seed / reconcile / trim ops_journal ──────────────────────
  // reconcileJournal is scoped to whatever liveBoard rows are passed in, so we
  // pass through entries belonging to other project/milestone combos untouched
  // (only executable tasks belonging to *this* run get seeded/trimmed).
  const otherEntries = listOpsJournalEntries().filter(
    (e) => e.project !== project || e.milestone !== milestoneId,
  );
  const liveBoard: OpsBoardTaskRow[] = [
    ...executable.map((t) => ({
      taskId: t.id,
      project,
      milestone: milestoneId,
    })),
    ...otherEntries.map((e) => ({
      taskId: e.task_id,
      project: e.project,
      milestone: e.milestone,
    })),
  ];
  reconcileJournal(liveBoard);

  return {
    contextPages,
    boards: {
      target: {
        milestone: milestoneId,
        board,
        counts: {
          executable: executable.length,
          dep_blocked: depBlocked.length,
          needs_grooming: needsGrooming.length,
          closed_not_done: closedNotDone.length,
          done_or_deferred: done.length,
          leftover_tooling: leftoverTooling.length,
          test_authoring_excluded: testAuthoring.length,
        },
      },
      neighbours,
    },
    worklist: {
      executable,
      dep_blocked: depBlocked,
      needs_grooming: needsGrooming,
      closed_not_done: closedNotDone,
      leftover_tooling: leftoverTooling,
      test_authoring: testAuthoring,
      newly_unblocked: newlyUnblocked,
    },
  };
}
