import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadGroomContext,
  GroomManifest,
  NotionReadClient,
  NotionTaskLike,
} from '../groomLoad';
import { toExternalId } from '../../tasks/taskId';
import { bindingConstraintIdsForRegions } from '../constraintCatalog';

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
});
