import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';

vi.mock('../../src/db/db.js', async () => {
  const Database = (await import('better-sqlite3')).default;
  const memDb = new Database(':memory:');
  memDb.pragma('foreign_keys = ON');
  const { applyTestSchema } = await import('../helpers/testDbSchema');
  applyTestSchema(memDb);
  return { db: memDb };
});

vi.mock('../../src/notion/NotionClient', () => {
  // Stub NotionClient so the Notion backend doesn't hit the network.
  return {
    NotionClient: class {
      async fetchReadyTasks(boardId: string) {
        return [
          {
            task: {
              id: `notion-task-for-${boardId}`,
              title: 'Notion Ready Task',
              status: '🗂️ Ready',
              type: '💻 Code',
              dependsOn: [],
              notionUrl: `https://notion.so/notion-task-for-${boardId}`,
            },
            blocked: false,
            blockers: [],
            nonCode: false,
            wave: 1,
          },
        ];
      }
      async updateStatus() { /* no-op */ }
      async attachPR() { /* no-op */ }
      async fetchTaskPage() { return { rawMarkdown: '' }; }
    },
    parseSection: () => '',
  };
});

import { ProjectService } from '../../src/projects/ProjectService.js';
import { db } from '../../src/db/db.js';
import { getTaskBackend, _resetTaskBackendCacheForTests } from '../../src/tasks/TaskBackend';

let yamlDir: string;

beforeEach(() => {
  db.prepare('DELETE FROM milestones').run();
  db.prepare('DELETE FROM projects').run();
  _resetTaskBackendCacheForTests();

  yamlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-src-test-'));
  fs.writeFileSync(
    path.join(yamlDir, 'tasks.yaml'),
    yaml.dump({
      project: { id: 'p-yaml', name: 'YAML' },
      milestones: [
        {
          id: 'm-yaml',
          name: 'YAML Milestone',
          tasks: [
            {
              id: 'yaml-ready', name: 'YAML Ready Task', status: 'Ready',
              type: 'Code', depends_on: [], pr_url: null,
            },
            {
              id: 'yaml-done', name: 'YAML Done Task', status: 'Done',
              type: 'Code', depends_on: [], pr_url: null,
            },
          ],
        },
      ],
    }),
  );

  ProjectService.create({ id: 'p-notion', name: 'Notion P', projectDir: '/tmp/n', taskSource: 'notion' });
  ProjectService.createMilestone({ id: 'm-notion', projectId: 'p-notion', name: 'Notion Milestone', sourceId: 'notion-db-source' });

  ProjectService.create({ id: 'p-yaml', name: 'YAML P', projectDir: yamlDir, taskSource: 'yaml' });
  ProjectService.createMilestone({ id: 'm-yaml', projectId: 'p-yaml', name: 'YAML Milestone' });
});

afterEach(() => {
  fs.rmSync(yamlDir, { recursive: true, force: true });
});

describe('Mixed-source projects: fetchReadyTasks routes to the right backend', () => {
  it('fetch_tasks for the Notion project hits NotionTaskBackend (and uses milestone.source_id)', async () => {
    const tasks = await getTaskBackend('p-notion').fetchReadyTasks('m-notion');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].task.id).toBe('notion-task-for-notion-db-source');
  });

  it('fetch_tasks for the YAML project hits LocalTaskBackend and reads from <projectDir>/tasks.yaml', async () => {
    const tasks = await getTaskBackend('p-yaml').fetchReadyTasks('m-yaml');
    const ids = tasks.map((t) => t.task.id);
    expect(ids).toContain('yaml-ready');
    expect(ids).toContain('yaml-done');
  });

  it('the two backends do not bleed into each other', async () => {
    const [n, y] = await Promise.all([
      getTaskBackend('p-notion').fetchReadyTasks('m-notion'),
      getTaskBackend('p-yaml').fetchReadyTasks('m-yaml'),
    ]);
    expect(n.map((t) => t.task.id)).toEqual(['notion-task-for-notion-db-source']);
    expect(y.map((t) => t.task.id).sort()).toEqual(['yaml-done', 'yaml-ready']);
  });
});
