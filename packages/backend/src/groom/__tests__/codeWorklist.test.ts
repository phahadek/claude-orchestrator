import { describe, it, expect } from 'vitest';
import {
  buildCodeWorklist,
  resolveTaskRegions,
  WorklistTask,
} from '../codeWorklist';

const TRACKED_FILES = [
  'packages/backend/src/notion/NotionClient.ts',
  'packages/backend/src/notion/NotionClient.test.ts',
  'packages/backend/src/tasks/NotionTaskBackend.ts',
  'packages/frontend/src/components/TaskCard.tsx',
];

describe('buildCodeWorklist', () => {
  it('dedupes per-package paths across a fixture task set', () => {
    const tasks: WorklistTask[] = [
      {
        id: 'task-1',
        title: 'Fix Notion client caching',
        filesSection:
          '- `packages/backend/src/notion/NotionClient.ts`\n- `packages/backend/src/notion/NotionClient.ts`',
        rawMarkdown: '',
      },
      {
        id: 'task-2',
        title: 'Add task backend test coverage',
        filesSection:
          '- `packages/backend/src/notion/NotionClient.test.ts`\n- `packages/backend/src/tasks/NotionTaskBackend.ts`',
        rawMarkdown: '',
      },
      {
        id: 'task-3',
        title: 'Tweak the task card',
        filesSection: '- `packages/frontend/src/components/TaskCard.tsx`',
        rawMarkdown: '',
      },
    ];

    const worklist = buildCodeWorklist(tasks, {
      sourceRoot: 'packages',
      packages: [
        'backend/src/notion',
        'backend/src/tasks',
        'frontend/src/components',
      ],
      areaAliases: {},
      trackedFiles: TRACKED_FILES,
    });

    expect(worklist.get('packages/backend/src/notion')).toEqual([
      'packages/backend/src/notion/NotionClient.test.ts',
      'packages/backend/src/notion/NotionClient.ts',
    ]);
    expect(worklist.get('packages/backend/src/tasks')).toEqual([
      'packages/backend/src/tasks/NotionTaskBackend.ts',
    ]);
    expect(worklist.get('packages/frontend/src/components')).toEqual([
      'packages/frontend/src/components/TaskCard.tsx',
    ]);
  });

  it('drops prose that merely looks path-shaped (not a tracked file)', () => {
    const tasks: WorklistTask[] = [
      {
        id: 'task-1',
        title: 'Add try/except handling',
        filesSection: 'Wrap the call in a try/except block.',
        rawMarkdown: '',
      },
    ];

    const worklist = buildCodeWorklist(tasks, {
      sourceRoot: '',
      packages: [],
      areaAliases: {},
      trackedFiles: TRACKED_FILES,
    });

    expect(worklist.size).toBe(0);
  });

  it('resolves area aliases to a package with no literal path in the body', () => {
    const tasks: WorklistTask[] = [
      {
        id: 'task-1',
        title: 'Improve the task card UX',
        filesSection: 'No files listed, but this touches the task card area.',
        rawMarkdown: '',
      },
    ];

    const worklist = buildCodeWorklist(tasks, {
      sourceRoot: '',
      packages: [],
      areaAliases: { 'task card': 'packages/frontend/src/components' },
      trackedFiles: TRACKED_FILES,
    });

    expect(worklist.has('packages/frontend/src/components')).toBe(true);
  });

  it('falls back to the full raw body when no Files section is present', () => {
    const tasks: WorklistTask[] = [
      {
        id: 'task-1',
        title: 'Untitled task',
        filesSection: '',
        rawMarkdown:
          'See `packages/backend/src/tasks/NotionTaskBackend.ts` for details.',
      },
    ];

    const worklist = buildCodeWorklist(tasks, {
      sourceRoot: 'packages',
      packages: ['backend/src/tasks'],
      areaAliases: {},
      trackedFiles: TRACKED_FILES,
    });

    expect(worklist.get('packages/backend/src/tasks')).toEqual([
      'packages/backend/src/tasks/NotionTaskBackend.ts',
    ]);
  });
});

describe('resolveTaskRegions', () => {
  it('resolves a single task declared Files list to its own package + file count', () => {
    const task: WorklistTask = {
      id: 'task-1',
      title: 'Fix Notion client caching',
      filesSection:
        '- `packages/backend/src/notion/NotionClient.ts`\n- `packages/backend/src/notion/NotionClient.test.ts`',
      rawMarkdown: '',
    };

    const regions = resolveTaskRegions(task, {
      sourceRoot: 'packages',
      packages: ['backend/src/notion'],
      areaAliases: {},
      trackedFiles: TRACKED_FILES,
    });

    expect(regions.files).toEqual([
      'packages/backend/src/notion/NotionClient.test.ts',
      'packages/backend/src/notion/NotionClient.ts',
    ]);
    expect(regions.packages).toEqual(['packages/backend/src/notion']);
  });

  it('yields an empty file list without error when nothing resolves', () => {
    const task: WorklistTask = {
      id: 'task-1',
      title: 'Add try/except handling',
      filesSection: 'Wrap the call in a try/except block.',
      rawMarkdown: '',
    };

    const regions = resolveTaskRegions(task, {
      sourceRoot: '',
      packages: [],
      areaAliases: {},
      trackedFiles: TRACKED_FILES,
    });

    expect(regions.files).toEqual([]);
    expect(regions.packages).toEqual([]);
    expect(regions.planned).toEqual([]);
  });

  it('surfaces a declared-but-nonexistent Files-section path as planned, resolved to its nearest existing ancestor', () => {
    const task: WorklistTask = {
      id: 'task-1',
      title: 'Add a global search / jump palette',
      filesSection:
        '- `packages/search/globalSearchIndex.ts` *(new)*\n- `packages/backend/src/notion/NotionClient.ts`',
      rawMarkdown: '',
    };

    const regions = resolveTaskRegions(task, {
      sourceRoot: 'packages',
      packages: ['backend/src/notion'],
      areaAliases: {},
      trackedFiles: TRACKED_FILES,
    });

    // The existing tracked file still resolves normally.
    expect(regions.packages).toEqual(['packages/backend/src/notion']);
    expect(regions.files).toEqual([
      'packages/backend/src/notion/NotionClient.ts',
    ]);
    // The nonexistent path surfaces as planned, resolved to its nearest tracked ancestor.
    expect(regions.planned).toEqual([
      {
        path: 'packages/search/globalSearchIndex.ts',
        package: 'packages',
      },
    ]);
  });

  it('still drops a path-shaped prose token when there is no Files section (noise-guard unchanged)', () => {
    const task: WorklistTask = {
      id: 'task-1',
      title: 'Add a global search / jump palette',
      filesSection: '',
      rawMarkdown:
        'This will live under `packages/search/globalSearchIndex.ts` eventually.',
    };

    const regions = resolveTaskRegions(task, {
      sourceRoot: 'packages',
      packages: ['backend/src/notion'],
      areaAliases: {},
      trackedFiles: TRACKED_FILES,
    });

    expect(regions.planned).toEqual([]);
  });
});
