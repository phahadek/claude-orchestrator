import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

vi.setConfig({ testTimeout: 20_000 });

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import { spawnSync } from 'child_process';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadGroomContext,
  GroomManifest,
  GroomTaskSourceUnsupportedError,
  NotionReadClient,
  NotionTaskLike,
  isSizeCheckSeedOverThreshold,
  computeSeamSeed,
  extractPathToken,
  filesPathsEntryExistsInRepo,
  parseFilesPathsRawItems,
} from '../groomLoad';
import { toExternalId } from '../../tasks/taskId';
import { bindingConstraintIdsForRegions } from '../constraintCatalog';
import {
  insertProject,
  insertMilestone,
  updateProject,
} from '../../db/queries';
import { createUnit } from '../../architecture/ArchUnitStore';
import { SIZE_TYPE_CHECK } from '../../planning/procedureCore';

function git(args: string[], cwd: string) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

function setupRepo(): { repoDir: string; commit1: string; commit2: string } {
  const repoDir = mkdtempSync(join(tmpdir(), 'groom-load-'));
  mkdirSync(join(repoDir, 'packages/backend/src/notion'), { recursive: true });
  mkdirSync(join(repoDir, 'packages/backend/src/tasks'), { recursive: true });
  writeFileSync(
    join(repoDir, 'packages/backend/src/notion/NotionClient.ts'),
    'export const a = 1;\n',
  );
  writeFileSync(
    join(repoDir, 'packages/backend/src/tasks/NotionTaskBackend.ts'),
    'export const b = 1;\n',
  );
  git(['init'], repoDir);
  git(['config', 'user.email', 'test@test.com'], repoDir);
  git(['config', 'user.name', 'Test'], repoDir);
  git(['add', '.'], repoDir);
  git(['commit', '-m', 'init'], repoDir);
  const commit1 = git(['rev-parse', 'HEAD'], repoDir);

  // Change only the tasks package after commit1.
  writeFileSync(
    join(repoDir, 'packages/backend/src/tasks/NotionTaskBackend.ts'),
    'export const b = 2;\n',
  );
  git(['add', '.'], repoDir);
  git(['commit', '-m', 'update tasks'], repoDir);
  const commit2 = git(['rev-parse', 'HEAD'], repoDir);

  git(['branch', '-m', 'dev'], repoDir);
  return { repoDir, commit1, commit2 };
}

const MANIFEST: GroomManifest = {
  source_root: 'packages/backend/src',
  integration_branch: 'dev',
  packages: ['notion', 'tasks'],
  area_aliases: {},
  context_pages: [{ id: 'ctx-page-1', title: 'Technical Architecture' }],
  milestones: {
    'M-test': {
      board: 'fake-board',
      neighbours: [{ id: 'M-prev', board: 'fake-neighbour-board' }],
    },
  },
};

/** Same milestone, but ctx-page-1 is flagged as migrated into the arch_unit
 * store, alongside a second, never-migrated context page (ctx-page-2). */
const MANIFEST_MIGRATED: GroomManifest = {
  ...MANIFEST,
  context_pages: [
    {
      id: 'ctx-page-1',
      title: 'Technical Architecture',
      migratedToStore: true,
    },
    { id: 'ctx-page-2', title: 'Project Context' },
  ],
};

const CODE_ROW: NotionTaskLike = {
  id: 'code-task-1',
  title: 'Fix the notion client',
  status: '🔲 Backlog',
  type: '💻 Code',
  priority: '',
  notionUrl: 'n/a',
};
const TOOL_ROW: NotionTaskLike = {
  id: 'tool-task-1',
  title: 'Fix the task backend',
  status: '🔲 Backlog',
  type: '🛠️ Tooling',
  priority: '',
  notionUrl: 'n/a',
};
const DONE_ROW: NotionTaskLike = {
  id: 'done-task-1',
  title: 'Already finished',
  status: '✅ Done',
  type: '💻 Code',
  priority: '',
  notionUrl: 'n/a',
};
const NEIGHBOUR_ROW: NotionTaskLike = {
  id: 'neighbour-task-1',
  title: 'Still open on the prior milestone',
  status: '🔲 Backlog',
  type: '💻 Code',
  priority: '',
  notionUrl: 'n/a',
};

const TASK_PAGES: Record<
  string,
  { name: string; filesSection: string; rawMarkdown: string }
> = {
  'code-task-1': {
    name: CODE_ROW.title,
    filesSection: '- `packages/backend/src/notion/NotionClient.ts`',
    rawMarkdown:
      '## Files / paths affected\n- `packages/backend/src/notion/NotionClient.ts`',
  },
  'tool-task-1': {
    name: TOOL_ROW.title,
    filesSection: '- `packages/backend/src/tasks/NotionTaskBackend.ts`',
    rawMarkdown:
      '## Files / paths affected\n- `packages/backend/src/tasks/NotionTaskBackend.ts`',
  },
  'ctx-page-1': {
    name: 'Technical Architecture',
    filesSection: '',
    rawMarkdown: '# Technical Architecture\n\nSome context.',
  },
  'ctx-page-2': {
    name: 'Project Context',
    filesSection: '',
    rawMarkdown: '# Project Context\n\nNever migrated.',
  },
};

function fakeNotion(): NotionReadClient {
  return {
    async fetchReadyTasks(boardId: string) {
      if (boardId === 'fake-board') {
        return [{ task: CODE_ROW }, { task: TOOL_ROW }, { task: DONE_ROW }];
      }
      if (boardId === 'fake-neighbour-board') {
        return [{ task: NEIGHBOUR_ROW }];
      }
      return [];
    },
    async fetchTaskPage(taskId: string) {
      const externalId = toExternalId(taskId);
      const page = TASK_PAGES[externalId];
      if (!page) throw new Error(`no fixture page for ${externalId}`);
      return page;
    },
  };
}

describe('loadGroomContext', () => {
  let repoDir: string;

  afterEach(() => {
    if (repoDir) rmSync(repoDir, { recursive: true, force: true });
  });

  it('returns the board, target task bodies, neighbour board, and context pages for a fixture milestone', async () => {
    ({ repoDir } = setupRepo());
    const result = await loadGroomContext('M-test', {
      repoRoot: repoDir,
      manifest: MANIFEST,
      notionClient: fakeNotion(),
    });

    expect(result.board.map((r) => r.id).sort()).toEqual(
      [CODE_ROW.id, TOOL_ROW.id, DONE_ROW.id].sort(),
    );
    expect(result.targetTasks.map((t) => t.id).sort()).toEqual(
      [CODE_ROW.id, TOOL_ROW.id].sort(),
    ); // Done task excluded
    expect(
      result.targetTasks.find((t) => t.id === CODE_ROW.id)?.filesSection,
    ).toContain('NotionClient.ts');
    expect(result.neighbourBoards.map((r) => r.id)).toEqual([NEIGHBOUR_ROW.id]);
    expect(result.contextPages).toEqual([
      {
        id: 'ctx-page-1',
        title: 'Technical Architecture',
        markdown: '# Technical Architecture\n\nSome context.',
      },
    ]);
  });

  it('computes a deterministic size_check.files seed per task from its declared Files section', async () => {
    ({ repoDir } = setupRepo());
    const result = await loadGroomContext('M-test', {
      repoRoot: repoDir,
      manifest: MANIFEST,
      notionClient: fakeNotion(),
    });

    const codeTask = result.targetTasks.find((t) => t.id === CODE_ROW.id);
    expect(codeTask?.sizeCheckSeed).toEqual({
      files: 1,
      loc_method: 'estimated',
    });
    const toolTask = result.targetTasks.find((t) => t.id === TOOL_ROW.id);
    expect(toolTask?.sizeCheckSeed).toEqual({
      files: 1,
      loc_method: 'estimated',
    });
  });

  it('yields files: 0 without error when a task has no parseable Files section', async () => {
    ({ repoDir } = setupRepo());
    const notion = fakeNotion();
    const original = notion.fetchTaskPage.bind(notion);
    notion.fetchTaskPage = async (taskId: string) => {
      if (toExternalId(taskId) === CODE_ROW.id) {
        return {
          name: CODE_ROW.title,
          filesSection: '',
          rawMarkdown: 'No files mentioned here.',
        };
      }
      return original(taskId);
    };
    const result = await loadGroomContext('M-test', {
      repoRoot: repoDir,
      manifest: MANIFEST,
      notionClient: notion,
    });

    const codeTask = result.targetTasks.find((t) => t.id === CODE_ROW.id);
    expect(codeTask?.sizeCheckSeed).toEqual({
      files: 0,
      loc_method: 'estimated',
    });
  });

  it('computes a type_check artifact per task', async () => {
    ({ repoDir } = setupRepo());
    const result = await loadGroomContext('M-test', {
      repoRoot: repoDir,
      manifest: MANIFEST,
      notionClient: fakeNotion(),
    });

    const codeTask = result.targetTasks.find((t) => t.id === CODE_ROW.id);
    expect(codeTask?.typeCheck).toEqual({ decision: 'none' });
  });

  it('builds a deduped per-package code worklist from target task bodies', async () => {
    ({ repoDir } = setupRepo());
    const result = await loadGroomContext('M-test', {
      repoRoot: repoDir,
      manifest: MANIFEST,
      notionClient: fakeNotion(),
    });

    expect(result.codeWorklist.get('packages/backend/src/notion')).toEqual([
      'packages/backend/src/notion/NotionClient.ts',
    ]);
    expect(result.codeWorklist.get('packages/backend/src/tasks')).toEqual([
      'packages/backend/src/tasks/NotionTaskBackend.ts',
    ]);
  });

  it('computes git freshness correctly against the local integration branch', async () => {
    const setup = setupRepo();
    repoDir = setup.repoDir;
    const result = await loadGroomContext('M-test', {
      repoRoot: repoDir,
      manifest: MANIFEST,
      notionClient: fakeNotion(),
      priorShaByPackage: {
        // notion package unchanged between commit1 and the dev baseline (commit2) → fresh
        'packages/backend/src/notion': setup.commit1,
        // tasks package changed between commit1 and commit2 → stale
        'packages/backend/src/tasks': setup.commit1,
      },
    });

    expect(result.gitFreshness['packages/backend/src/notion'].status).toBe(
      'fresh',
    );
    expect(result.gitFreshness['packages/backend/src/tasks'].status).toBe(
      'stale',
    );
    expect(result.gitFreshness['packages/backend/src/notion'].baselineSha).toBe(
      setup.commit2,
    );
  });

  it('marks a package missing when there is no prior explored SHA', async () => {
    const setup = setupRepo();
    repoDir = setup.repoDir;
    const result = await loadGroomContext('M-test', {
      repoRoot: repoDir,
      manifest: MANIFEST,
      notionClient: fakeNotion(),
    });

    expect(result.gitFreshness['packages/backend/src/notion'].status).toBe(
      'missing',
    );
    expect(
      result.gitFreshness['packages/backend/src/notion'].priorSha,
    ).toBeNull();
  });

  it('passes task IDs in source:externalId form to fetchTaskPage, matching real NotionClient parsing', async () => {
    ({ repoDir } = setupRepo());
    const notion = fakeNotion();
    const seenIds: string[] = [];
    const original = notion.fetchTaskPage.bind(notion);
    notion.fetchTaskPage = async (taskId: string) => {
      seenIds.push(taskId);
      // Mirrors NotionClient.fetchTaskPage, which calls toExternalId(taskId)
      // and throws "Invalid task ID (no colon)" on an unprefixed raw ID.
      expect(() => toExternalId(taskId)).not.toThrow();
      return original(taskId);
    };

    await expect(
      loadGroomContext('M-test', {
        repoRoot: repoDir,
        manifest: MANIFEST,
        notionClient: notion,
      }),
    ).resolves.toBeDefined();
    expect(seenIds).toContain(`notion:${CODE_ROW.id}`);
    expect(seenIds).toContain('notion:ctx-page-1');
  });

  it('derives bindingConstraints per task from CONSTRAINT_CATALOG against its resolved regions', async () => {
    ({ repoDir } = setupRepo());
    const result = await loadGroomContext('M-test', {
      repoRoot: repoDir,
      manifest: MANIFEST,
      notionClient: fakeNotion(),
    });

    const codeTask = result.targetTasks.find((t) => t.id === CODE_ROW.id)!;
    expect(codeTask.bindingConstraints).toEqual(
      bindingConstraintIdsForRegions(codeTask.regions),
    );
    expect(codeTask.bindingConstraints).toContain('notion-single-writer');
  });

  it('parses Files/paths entries per task, git-validating each against tracked files', async () => {
    ({ repoDir } = setupRepo());
    const result = await loadGroomContext('M-test', {
      repoRoot: repoDir,
      manifest: MANIFEST,
      notionClient: fakeNotion(),
    });

    const codeTask = result.targetTasks.find((t) => t.id === CODE_ROW.id)!;
    expect(codeTask.filesPathsEntries).toEqual([
      {
        raw: '`packages/backend/src/notion/NotionClient.ts`',
        isNew: false,
        existsInRepo: true,
      },
    ]);
  });

  it('marks a Files/paths entry unresolved when it names a file not tracked in the repo', async () => {
    ({ repoDir } = setupRepo());
    const notion = fakeNotion();
    const original = notion.fetchTaskPage.bind(notion);
    notion.fetchTaskPage = async (taskId: string) => {
      if (toExternalId(taskId) === CODE_ROW.id) {
        return {
          name: CODE_ROW.title,
          filesSection: '- `packages/backend/src/notion/Nonexistent.ts`',
          rawMarkdown:
            '## Files / paths affected\n- `packages/backend/src/notion/Nonexistent.ts`',
        };
      }
      return original(taskId);
    };
    const result = await loadGroomContext('M-test', {
      repoRoot: repoDir,
      manifest: MANIFEST,
      notionClient: notion,
    });

    const codeTask = result.targetTasks.find((t) => t.id === CODE_ROW.id)!;
    expect(codeTask.filesPathsEntries).toEqual([
      {
        raw: '`packages/backend/src/notion/Nonexistent.ts`',
        isNew: false,
        existsInRepo: false,
      },
    ]);
  });

  it('resolves dependsOnTasks against the board + neighbour boards, including Done status', async () => {
    ({ repoDir } = setupRepo());
    const notion = fakeNotion();
    const original = notion.fetchReadyTasks.bind(notion);
    notion.fetchReadyTasks = async (boardId: string) => {
      if (boardId === 'fake-board') {
        return [
          {
            task: { ...CODE_ROW, dependsOn: [DONE_ROW.id, 'unknown-dep-id'] },
          },
          { task: TOOL_ROW },
          { task: DONE_ROW },
        ];
      }
      return original(boardId);
    };
    const result = await loadGroomContext('M-test', {
      repoRoot: repoDir,
      manifest: MANIFEST,
      notionClient: notion,
    });

    const codeTask = result.targetTasks.find((t) => t.id === CODE_ROW.id)!;
    expect(codeTask.dependsOnTasks).toEqual([
      { id: DONE_ROW.id, type: DONE_ROW.type, status: DONE_ROW.status },
      { id: 'unknown-dep-id', type: undefined, status: undefined },
    ]);
  });

  it('threads opts.skipCache through to fetchReadyTasks for the target board and every neighbour board', async () => {
    ({ repoDir } = setupRepo());
    const notion = fakeNotion();
    const calls: [string, boolean | undefined][] = [];
    const original = notion.fetchReadyTasks.bind(notion);
    notion.fetchReadyTasks = async (boardId: string, skipCache?: boolean) => {
      calls.push([boardId, skipCache]);
      return original(boardId, skipCache);
    };

    await loadGroomContext('M-test', {
      repoRoot: repoDir,
      manifest: MANIFEST,
      notionClient: notion,
      skipCache: true,
    });

    expect(calls).toEqual([
      ['fake-board', true],
      ['fake-neighbour-board', true],
    ]);
  });

  it('throws for an unregistered milestone', async () => {
    ({ repoDir } = setupRepo());
    await expect(
      loadGroomContext('M-unknown', {
        repoRoot: repoDir,
        manifest: MANIFEST,
        notionClient: fakeNotion(),
      }),
    ).rejects.toThrow(/not registered/);
  });

  describe('DB-resolved board & neighbours (milestones table)', () => {
    function notionWithBoards(
      boards: Record<string, NotionTaskLike[]>,
    ): NotionReadClient {
      return {
        async fetchReadyTasks(boardId: string) {
          return (boards[boardId] ?? []).map((task) => ({ task }));
        },
        async fetchTaskPage(taskId: string) {
          const externalId = toExternalId(taskId);
          const page = TASK_PAGES[externalId];
          if (!page) throw new Error(`no fixture page for ${externalId}`);
          return page;
        },
      };
    }

    beforeEach(() => {
      db.prepare('DELETE FROM milestones').run();
      db.prepare('DELETE FROM projects').run();
    });

    it('resolves the board from the milestones row when there is no manifest entry', async () => {
      ({ repoDir } = setupRepo());
      const PROJECT_ID = 'proj-db-only';
      insertProject({
        id: PROJECT_ID,
        name: 'DB Only Project',
        project_dir: repoDir,
        context_url: null,
        github_repo: null,
        task_source: 'notion',
      });
      insertMilestone({
        id: 'mil-db-only',
        project_id: PROJECT_ID,
        name: 'DB Only Milestone',
        source_id: 'fake-board',
        canonical_short_id: 'M-db-only',
        display_order: 1,
      });

      const result = await loadGroomContext('M-db-only', {
        repoRoot: repoDir,
        manifest: { ...MANIFEST, milestones: {} },
        projectId: PROJECT_ID,
        notionClient: notionWithBoards({
          'fake-board': [CODE_ROW, TOOL_ROW, DONE_ROW],
        }),
      });

      expect(result.board.map((r) => r.id).sort()).toEqual(
        [CODE_ROW.id, TOOL_ROW.id, DONE_ROW.id].sort(),
      );
    });

    it('falls back to the manifest board when the milestone has no resolvable row', async () => {
      ({ repoDir } = setupRepo());
      const PROJECT_ID = 'proj-manifest-fallback';
      insertProject({
        id: PROJECT_ID,
        name: 'Manifest Fallback Project',
        project_dir: repoDir,
        context_url: null,
        github_repo: null,
        task_source: 'notion',
      });
      // No milestones row for 'M-test' — only the manifest entry resolves it.

      const result = await loadGroomContext('M-test', {
        repoRoot: repoDir,
        manifest: MANIFEST,
        projectId: PROJECT_ID,
        notionClient: fakeNotion(),
      });

      expect(result.board.map((r) => r.id).sort()).toEqual(
        [CODE_ROW.id, TOOL_ROW.id, DONE_ROW.id].sort(),
      );
    });

    it('prefers the row board over a conflicting manifest board', async () => {
      ({ repoDir } = setupRepo());
      const PROJECT_ID = 'proj-row-wins';
      insertProject({
        id: PROJECT_ID,
        name: 'Row Wins Project',
        project_dir: repoDir,
        context_url: null,
        github_repo: null,
        task_source: 'notion',
      });
      insertMilestone({
        id: 'mil-row-wins',
        project_id: PROJECT_ID,
        name: 'Row Wins Milestone',
        source_id: 'row-board',
        canonical_short_id: 'M-conflict',
        display_order: 1,
      });
      const manifest: GroomManifest = {
        ...MANIFEST,
        milestones: {
          'M-conflict': { board: 'manifest-board' },
        },
      };

      const result = await loadGroomContext('M-conflict', {
        repoRoot: repoDir,
        manifest,
        projectId: PROJECT_ID,
        notionClient: notionWithBoards({
          'row-board': [CODE_ROW],
          'manifest-board': [TOOL_ROW],
        }),
      });

      expect(result.board.map((r) => r.id)).toEqual([CODE_ROW.id]);
    });

    it('names both the row and the manifest when neither resolves', async () => {
      ({ repoDir } = setupRepo());
      const PROJECT_ID = 'proj-neither-resolves';
      insertProject({
        id: PROJECT_ID,
        name: 'Neither Resolves Project',
        project_dir: repoDir,
        context_url: null,
        github_repo: null,
        task_source: 'notion',
      });

      await expect(
        loadGroomContext('M-nowhere', {
          repoRoot: repoDir,
          manifest: { ...MANIFEST, milestones: {} },
          projectId: PROJECT_ID,
          notionClient: notionWithBoards({}),
        }),
      ).rejects.toThrow(/milestones-table row/);
      await expect(
        loadGroomContext('M-nowhere', {
          repoRoot: repoDir,
          manifest: { ...MANIFEST, milestones: {} },
          projectId: PROJECT_ID,
          notionClient: notionWithBoards({}),
        }),
      ).rejects.toThrow(/grooming manifest/);
    });

    it('derives neighbours project-scoped, ignoring another project with the same milestone short id', async () => {
      ({ repoDir } = setupRepo());
      const PROJECT_A = 'proj-scope-a';
      const PROJECT_B = 'proj-scope-b';
      insertProject({
        id: PROJECT_A,
        name: 'Scope Project A',
        project_dir: repoDir,
        context_url: null,
        github_repo: null,
        task_source: 'notion',
      });
      insertProject({
        id: PROJECT_B,
        name: 'Scope Project B',
        project_dir: repoDir,
        context_url: null,
        github_repo: null,
        task_source: 'notion',
      });
      insertMilestone({
        id: 'mil-a-prior',
        project_id: PROJECT_A,
        name: 'A Prior',
        source_id: 'board-a-prev',
        canonical_short_id: 'M-prior-a',
        display_order: 1,
      });
      insertMilestone({
        id: 'mil-a-shared',
        project_id: PROJECT_A,
        name: 'A Shared',
        source_id: 'board-a-target',
        canonical_short_id: 'M-shared',
        display_order: 2,
      });
      insertMilestone({
        id: 'mil-b-prior',
        project_id: PROJECT_B,
        name: 'B Prior',
        source_id: 'board-b-prev',
        canonical_short_id: 'M-prior-b',
        display_order: 1,
      });
      insertMilestone({
        id: 'mil-b-shared',
        project_id: PROJECT_B,
        name: 'B Shared',
        source_id: 'board-b-target',
        canonical_short_id: 'M-shared',
        display_order: 2,
      });

      const result = await loadGroomContext('M-shared', {
        repoRoot: repoDir,
        manifest: { ...MANIFEST, milestones: {} },
        projectId: PROJECT_A,
        notionClient: notionWithBoards({
          'board-a-target': [CODE_ROW],
          'board-a-prev': [NEIGHBOUR_ROW],
          'board-b-target': [TOOL_ROW],
          'board-b-prev': [DONE_ROW],
        }),
      });

      expect(result.neighbourBoards.map((r) => r.id)).toEqual([
        NEIGHBOUR_ROW.id,
      ]);
    });

    it('pins the neighbour count to 1 even with several preceding milestones', async () => {
      ({ repoDir } = setupRepo());
      const PROJECT_ID = 'proj-neighbour-limit';
      insertProject({
        id: PROJECT_ID,
        name: 'Neighbour Limit Project',
        project_dir: repoDir,
        context_url: null,
        github_repo: null,
        task_source: 'notion',
      });
      insertMilestone({
        id: 'mil-limit-1',
        project_id: PROJECT_ID,
        name: 'Limit M1',
        source_id: 'board-1',
        canonical_short_id: 'M-limit-1',
        display_order: 1,
      });
      insertMilestone({
        id: 'mil-limit-2',
        project_id: PROJECT_ID,
        name: 'Limit M2',
        source_id: 'board-2',
        canonical_short_id: 'M-limit-2',
        display_order: 2,
      });
      insertMilestone({
        id: 'mil-limit-3',
        project_id: PROJECT_ID,
        name: 'Limit M3',
        source_id: 'board-3',
        canonical_short_id: 'M-limit-3',
        display_order: 3,
      });
      insertMilestone({
        id: 'mil-limit-target',
        project_id: PROJECT_ID,
        name: 'Limit Target',
        source_id: 'board-4',
        canonical_short_id: 'M-limit-target',
        display_order: 4,
      });

      const result = await loadGroomContext('M-limit-target', {
        repoRoot: repoDir,
        manifest: { ...MANIFEST, milestones: {} },
        projectId: PROJECT_ID,
        notionClient: notionWithBoards({
          'board-4': [CODE_ROW],
          'board-3': [NEIGHBOUR_ROW],
          'board-2': [TOOL_ROW],
          'board-1': [DONE_ROW],
        }),
      });

      expect(result.neighbourBoards.map((r) => r.id)).toEqual([
        NEIGHBOUR_ROW.id,
      ]);
    });
  });

  describe('non-Notion task source', () => {
    const PROJECT_ID = 'proj-groom-yaml-source';

    beforeEach(() => {
      db.prepare('DELETE FROM projects').run();
    });

    it('refuses with GroomTaskSourceUnsupportedError instead of reaching Notion for a YAML-backed project', async () => {
      ({ repoDir } = setupRepo());
      insertProject({
        id: PROJECT_ID,
        name: 'YAML-backed Project',
        project_dir: repoDir,
        context_url: null,
        github_repo: null,
        task_source: 'yaml',
      });

      // No notionClient is supplied — if the loader ever reached the
      // NotionClient branch it would throw trying to construct a real
      // client (no Notion API key configured in the test env), not the
      // task-source error this test asserts on.
      await expect(
        loadGroomContext('M-test', {
          repoRoot: repoDir,
          manifest: MANIFEST,
          projectId: PROJECT_ID,
        }),
      ).rejects.toThrow(GroomTaskSourceUnsupportedError);
      await expect(
        loadGroomContext('M-test', {
          repoRoot: repoDir,
          manifest: MANIFEST,
          projectId: PROJECT_ID,
        }),
      ).rejects.toThrow(/task source "yaml"/);
    });

    it('still loads normally for a Notion-backed project (unchanged behavior)', async () => {
      ({ repoDir } = setupRepo());
      insertProject({
        id: PROJECT_ID,
        name: 'Notion-backed Project',
        project_dir: repoDir,
        context_url: null,
        github_repo: null,
        task_source: 'notion',
      });

      const result = await loadGroomContext('M-test', {
        repoRoot: repoDir,
        manifest: MANIFEST,
        projectId: PROJECT_ID,
        notionClient: fakeNotion(),
      });

      expect(result.targetTasks.map((t) => t.id).sort()).toEqual(
        [CODE_ROW.id, TOOL_ROW.id].sort(),
      );
    });
  });

  describe('architecture dual-read', () => {
    const PROJECT_ID = 'proj-groom-dual-read';

    beforeEach(() => {
      db.prepare('DELETE FROM arch_unit_event').run();
      db.prepare('DELETE FROM arch_unit').run();
      db.prepare('DELETE FROM projects').run();
    });

    function setupProject(archStoreAdopted: boolean) {
      insertProject({
        id: PROJECT_ID,
        name: 'Groom Dual Read Project',
        project_dir: '/tmp/groom-dual-read-project',
        context_url: null,
        github_repo: null,
        task_source: 'notion',
      });
      if (archStoreAdopted) {
        updateProject(PROJECT_ID, { arch_store_adopted: 1 });
      }
    }

    it('resolves architecture from the arch_unit store (not the manifest context pages) once archStoreAdopted is set', async () => {
      ({ repoDir } = setupRepo());
      setupProject(true);
      createUnit({
        project: PROJECT_ID,
        title: 'Always-binding invariant',
        kind: 'invariant',
        topic: 'general',
        regions: [],
        body: 'body',
        at: '2026-01-01T00:00:00Z',
      });
      createUnit({
        project: PROJECT_ID,
        title: 'Notion-client subsystem unit',
        kind: 'subsystem',
        topic: 'notion',
        regions: ['packages/backend/src/notion'],
        body: 'body',
        at: '2026-01-01T00:00:00Z',
      });
      createUnit({
        project: PROJECT_ID,
        title: 'Unrelated subsystem unit',
        kind: 'subsystem',
        topic: 'unrelated',
        regions: ['packages/backend/src/unrelated'],
        body: 'body',
        at: '2026-01-01T00:00:00Z',
      });

      const result = await loadGroomContext('M-test', {
        repoRoot: repoDir,
        manifest: MANIFEST_MIGRATED,
        notionClient: fakeNotion(),
        projectId: PROJECT_ID,
      });

      expect(result.archSource).toBe('store');
      // The migratedToStore entry (Technical Architecture) is excluded now
      // that the project has adopted the store — its content is delivered
      // instead via archUnits below. The never-migrated entry (Project
      // Context) is still fetched from Notion in full, unaffected by the flag.
      expect(result.contextPages).toEqual([
        {
          id: 'ctx-page-2',
          title: 'Project Context',
          markdown: '# Project Context\n\nNever migrated.',
        },
      ]);

      const codeTask = result.targetTasks.find((t) => t.id === CODE_ROW.id);
      expect(codeTask?.archSource).toBe('store');
      expect(codeTask?.archUnits.map((u) => u.title).sort()).toEqual(
        ['Always-binding invariant', 'Notion-client subsystem unit'].sort(),
      );
      expect(
        codeTask?.archUnits.every(
          (u) => typeof u.body === 'string' && u.body.length > 0,
        ),
      ).toBe(true);

      const toolTask = result.targetTasks.find((t) => t.id === TOOL_ROW.id);
      // Region-intersecting units select by the task's own regions — active
      // invariants are still included regardless of region match.
      expect(toolTask?.archUnits.map((u) => u.title)).toEqual([
        'Always-binding invariant',
      ]);
    });

    it('applies the migratedToStore guard per context_pages entry: excluded only when both flagged and adopted', async () => {
      ({ repoDir } = setupRepo());

      setupProject(true);
      const adopted = await loadGroomContext('M-test', {
        repoRoot: repoDir,
        manifest: MANIFEST_MIGRATED,
        notionClient: fakeNotion(),
        projectId: PROJECT_ID,
      });
      // (a) the migratedToStore entry is excluded once archStoreAdopted=true...
      expect(adopted.contextPages.map((p) => p.id)).not.toContain('ctx-page-1');
      // ...(c) but a non-migratedToStore entry is still fetched in full.
      expect(adopted.contextPages).toEqual([
        {
          id: 'ctx-page-2',
          title: 'Project Context',
          markdown: '# Project Context\n\nNever migrated.',
        },
      ]);

      db.prepare('DELETE FROM projects').run();
      setupProject(false);
      const notAdopted = await loadGroomContext('M-test', {
        repoRoot: repoDir,
        manifest: MANIFEST_MIGRATED,
        notionClient: fakeNotion(),
        projectId: PROJECT_ID,
      });
      // (b) the same migratedToStore entry is fetched in full when the
      // project has not adopted the store.
      expect(notAdopted.contextPages).toEqual([
        {
          id: 'ctx-page-1',
          title: 'Technical Architecture',
          markdown: '# Technical Architecture\n\nSome context.',
        },
        {
          id: 'ctx-page-2',
          title: 'Project Context',
          markdown: '# Project Context\n\nNever migrated.',
        },
      ]);
    });

    it("keeps grooming's pre-migration Notion behaviour unchanged when archStoreAdopted is not set", async () => {
      ({ repoDir } = setupRepo());
      setupProject(false);
      createUnit({
        project: PROJECT_ID,
        title: 'Should never surface — project has not adopted the store',
        kind: 'invariant',
        topic: 'general',
        regions: [],
        body: 'body',
        at: '2026-01-01T00:00:00Z',
      });

      const result = await loadGroomContext('M-test', {
        repoRoot: repoDir,
        manifest: MANIFEST_MIGRATED,
        notionClient: fakeNotion(),
        projectId: PROJECT_ID,
      });

      expect(result.archSource).toBe('notion');
      // The migratedToStore flag only takes effect once archStoreAdopted is
      // set — with the project not yet adopted, every context page (migrated
      // flag or not) is still fetched from Notion in full.
      expect(result.contextPages).toEqual([
        {
          id: 'ctx-page-1',
          title: 'Technical Architecture',
          markdown: '# Technical Architecture\n\nSome context.',
        },
        {
          id: 'ctx-page-2',
          title: 'Project Context',
          markdown: '# Project Context\n\nNever migrated.',
        },
      ]);

      const codeTask = result.targetTasks.find((t) => t.id === CODE_ROW.id);
      expect(codeTask?.archSource).toBe('notion');
      expect(codeTask?.archUnits).toEqual([
        { id: 'ctx-page-1', title: 'Technical Architecture' },
        { id: 'ctx-page-2', title: 'Project Context' },
      ]);
    });

    it('computes bindingConstraints from the independent constraint catalog regardless of archStoreAdopted, alongside the dual-read archUnits', async () => {
      ({ repoDir } = setupRepo());
      setupProject(true);
      createUnit({
        project: PROJECT_ID,
        title: 'Notion-client subsystem unit',
        kind: 'subsystem',
        topic: 'notion',
        regions: ['packages/backend/src/notion'],
        body: 'body',
        at: '2026-01-01T00:00:00Z',
      });

      const result = await loadGroomContext('M-test', {
        repoRoot: repoDir,
        manifest: MANIFEST,
        notionClient: fakeNotion(),
        projectId: PROJECT_ID,
      });

      const codeTask = result.targetTasks.find((t) => t.id === CODE_ROW.id);
      // The catalog is a separate structure from the arch_unit store — both
      // are consulted, and the catalog's region-intersection is unaffected
      // by the dual-read source.
      expect(codeTask?.bindingConstraints).toEqual(
        bindingConstraintIdsForRegions({
          packages: codeTask!.regions.packages,
          files: codeTask!.regions.files,
        }),
      );
      expect(codeTask?.bindingConstraints).toContain('notion-single-writer');
      expect(codeTask?.archSource).toBe('store');
      expect(codeTask?.archUnits.map((u) => u.title)).toEqual([
        'Notion-client subsystem unit',
      ]);
    });

    it("never surfaces another project's arch_unit rows, including its active invariants", async () => {
      ({ repoDir } = setupRepo());
      setupProject(true);
      createUnit({
        project: PROJECT_ID,
        title: 'This project invariant',
        kind: 'invariant',
        topic: 'general',
        regions: [],
        body: 'body',
        at: '2026-01-01T00:00:00Z',
      });
      createUnit({
        project: 'some-other-project',
        title: 'Other project invariant',
        kind: 'invariant',
        topic: 'general',
        regions: [],
        body: 'body',
        at: '2026-01-01T00:00:00Z',
      });

      const result = await loadGroomContext('M-test', {
        repoRoot: repoDir,
        manifest: MANIFEST,
        notionClient: fakeNotion(),
        projectId: PROJECT_ID,
      });

      const codeTask = result.targetTasks.find((t) => t.id === CODE_ROW.id);
      expect(codeTask?.archUnits.map((u) => u.title)).toEqual([
        'This project invariant',
      ]);
    });
  });
});

describe('isSizeCheckSeedOverThreshold', () => {
  it('nominates a split when files exceeds the file threshold, even with locEstimate below the LoC threshold', () => {
    expect(
      isSizeCheckSeedOverThreshold({
        files: SIZE_TYPE_CHECK.fileSplitThreshold + 1,
        locEstimate: SIZE_TYPE_CHECK.locSplitThreshold - 1,
      }),
    ).toBe(true);
  });

  it('nominates a split when locEstimate exceeds the LoC threshold, even with files below the file threshold', () => {
    expect(
      isSizeCheckSeedOverThreshold({
        files: SIZE_TYPE_CHECK.fileSplitThreshold - 1,
        locEstimate: SIZE_TYPE_CHECK.locSplitThreshold + 1,
      }),
    ).toBe(true);
  });

  it('does not nominate a split when both files and locEstimate are below their thresholds', () => {
    expect(
      isSizeCheckSeedOverThreshold({
        files: SIZE_TYPE_CHECK.fileSplitThreshold - 1,
        locEstimate: SIZE_TYPE_CHECK.locSplitThreshold - 1,
      }),
    ).toBe(false);
  });

  it('does not nominate a split when locEstimate is omitted and files is below the file threshold', () => {
    expect(
      isSizeCheckSeedOverThreshold({
        files: SIZE_TYPE_CHECK.fileSplitThreshold - 1,
      }),
    ).toBe(false);
  });
});

describe('computeSeamSeed', () => {
  it('proposes schema for a migrations/ path', () => {
    const seeds = computeSeamSeed({
      packages: [],
      files: ['packages/backend/migrations/010_add_thing.sql'],
      planned: [],
    });
    expect(seeds).toContainEqual({
      kind: 'schema',
      what: 'packages/backend/migrations/010_add_thing.sql',
    });
  });

  it('proposes new-module for a declared-but-nonexistent (planned) path', () => {
    const seeds = computeSeamSeed({
      packages: [],
      files: [],
      planned: [
        { path: 'packages/backend/src/foo/newModule.ts', package: null },
      ],
    });
    expect(seeds).toContainEqual({
      kind: 'new-module',
      what: 'packages/backend/src/foo/newModule.ts',
    });
  });

  it('proposes wiring for a touched registry or runner file', () => {
    const seeds = computeSeamSeed({
      packages: [],
      files: [
        'packages/backend/src/foo/toolRegistry.ts',
        'packages/backend/src/foo/sessionRunner.ts',
      ],
      planned: [],
    });
    expect(seeds).toContainEqual({
      kind: 'wiring',
      what: 'packages/backend/src/foo/toolRegistry.ts',
    });
    expect(seeds).toContainEqual({
      kind: 'wiring',
      what: 'packages/backend/src/foo/sessionRunner.ts',
    });
  });

  it('returns no seeds for a plain untouched file', () => {
    expect(
      computeSeamSeed({
        packages: [],
        files: ['packages/backend/src/foo/plain.ts'],
        planned: [],
      }),
    ).toEqual([]);
  });
});

describe('extractPathToken — repo-root-level files', () => {
  it.each(['README.md', '.gitignore', 'package.json'])(
    'resolves a bare %s entry with no marker or description',
    (name) => {
      expect(extractPathToken(name)).toBe(name);
    },
  );

  it.each(['README.md', '.gitignore', 'package.json'])(
    'resolves a bare %s entry with an update marker and trailing prose',
    (name) => {
      expect(extractPathToken(`${name} (update) — the rewrite`)).toBe(name);
    },
  );

  it.each(['README.md', '.gitignore', 'package.json'])(
    'resolves a bare %s entry with a *(new)* marker',
    (name) => {
      expect(extractPathToken(`${name} *(new)*`)).toBe(name);
    },
  );

  it('continues to resolve the backticked form unchanged', () => {
    expect(extractPathToken('`README.md` (update) — the rewrite')).toBe(
      'README.md',
    );
  });

  it('resolves a nested backticked path unchanged', () => {
    expect(
      extractPathToken('`packages/backend/src/groom/groomLoad.ts` (update)'),
    ).toBe('packages/backend/src/groom/groomLoad.ts');
  });

  it('returns no token for a hedged, non-path entry', () => {
    expect(extractPathToken('confirm the exact path at grooming')).toBeNull();
  });

  it('does not mistake a leading-dot dotfile for a relative-path prefix', () => {
    expect(extractPathToken('.gitignore (update) — ignore build output')).toBe(
      '.gitignore',
    );
  });

  it('does not match a trailing sentence period as a bare-file extension', () => {
    expect(extractPathToken('see the task description.')).toBeNull();
  });
});

describe('filesPathsEntryExistsInRepo — repo-root-level files', () => {
  const trackedFiles = new Set([
    'README.md',
    '.gitignore',
    'package.json',
    'packages/backend/src/groom/groomLoad.ts',
  ]);

  it.each(['README.md', '.gitignore', 'package.json'])(
    'resolves a genuinely tracked bare %s entry',
    (name) => {
      expect(
        filesPathsEntryExistsInRepo(
          `${name} (update) — the rewrite`,
          trackedFiles,
        ),
      ).toBe(true);
    },
  );

  it('still fails to resolve an entry genuinely absent from the tracked set', () => {
    expect(filesPathsEntryExistsInRepo('NOPE.md (update)', trackedFiles)).toBe(
      false,
    );
  });

  it('still fails to resolve a hedged entry', () => {
    expect(
      filesPathsEntryExistsInRepo(
        'confirm the exact path at grooming',
        trackedFiles,
      ),
    ).toBe(false);
  });
});

describe('parseFilesPathsRawItems — (new) marker', () => {
  it('marks a bare (new) entry as new', () => {
    const [item] = parseFilesPathsRawItems('- src/a/b/new_module.py (new)');
    expect(item.isNew).toBe(true);
  });

  it('marks a (new — reason) entry (em-dash) as new', () => {
    const [item] = parseFilesPathsRawItems(
      '- src/a/b/new_module.py (new — new dispatch module)',
    );
    expect(item.isNew).toBe(true);
  });

  it('marks a (new - reason) entry (hyphen) as new', () => {
    const [item] = parseFilesPathsRawItems(
      '- src/a/b/new_module.py (new - new dispatch module)',
    );
    expect(item.isNew).toBe(true);
  });
});
