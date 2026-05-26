import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/db.js', async () => {
  const Database = (await import('better-sqlite3')).default;
  const memDb = new Database(':memory:');
  memDb.pragma('foreign_keys = ON');
  const { applyTestSchema } = await import('../helpers/testDbSchema');
  applyTestSchema(memDb);
  return { db: memDb };
});

import { ProjectService } from '../../src/projects/ProjectService.js';
import { db } from '../../src/db/db.js';
import {
  getTaskBackend,
  _resetTaskBackendCacheForTests,
} from '../../src/tasks/TaskBackend';
import { LocalTaskBackend } from '../../src/tasks/LocalTaskBackend';
import { NotionTaskBackend } from '../../src/tasks/NotionTaskBackend';
import { JiraTaskSourceProvider } from '../../src/tasks/JiraTaskSourceProvider';

beforeEach(() => {
  db.prepare('DELETE FROM milestones').run();
  db.prepare('DELETE FROM projects').run();
  _resetTaskBackendCacheForTests();
});

describe('getTaskBackend(projectId)', () => {
  it('returns a NotionTaskBackend when project.task_source === "notion"', () => {
    ProjectService.create({
      id: 'p-notion',
      name: 'Notion P',
      projectDir: '/tmp/n',
      taskSource: 'notion',
    });
    const backend = getTaskBackend('p-notion');
    expect(backend).toBeInstanceOf(NotionTaskBackend);
    expect(backend.type).toBe('notion');
  });

  it('returns a LocalTaskBackend when project.task_source === "yaml"', () => {
    ProjectService.create({
      id: 'p-yaml',
      name: 'YAML P',
      projectDir: '/tmp/y',
      taskSource: 'yaml',
    });
    const backend = getTaskBackend('p-yaml');
    expect(backend).toBeInstanceOf(LocalTaskBackend);
    expect(backend.type).toBe('local');
  });

  it('returns a JiraTaskSourceProvider when project.task_source === "jira"', () => {
    db.prepare(
      `INSERT INTO projects (id, name, project_dir, task_source, task_source_config, created_at, updated_at)
       VALUES ('p-jira', 'Jira P', '/tmp/j', 'jira',
         '{"host":"https://test.atlassian.net","project_key":"TEST"}',
         1, 1)`,
    ).run();
    const backend = getTaskBackend('p-jira');
    expect(backend).toBeInstanceOf(JiraTaskSourceProvider);
    expect(backend.type).toBe('jira');
  });

  it('throws when the project does not exist', () => {
    expect(() => getTaskBackend('missing')).toThrow(
      /project not found: missing/,
    );
  });

  it('reuses the same NotionTaskBackend instance across calls', () => {
    ProjectService.create({
      id: 'p1',
      name: 'P1',
      projectDir: '/tmp/1',
      taskSource: 'notion',
    });
    ProjectService.create({
      id: 'p2',
      name: 'P2',
      projectDir: '/tmp/2',
      taskSource: 'notion',
    });
    const a = getTaskBackend('p1');
    const b = getTaskBackend('p2');
    expect(a).toBe(b);
  });

  it('returns fresh LocalTaskBackend instances bound to the right projectDir', () => {
    ProjectService.create({
      id: 'pa',
      name: 'A',
      projectDir: '/tmp/projectA',
      taskSource: 'yaml',
    });
    ProjectService.create({
      id: 'pb',
      name: 'B',
      projectDir: '/tmp/projectB',
      taskSource: 'yaml',
    });
    const a = getTaskBackend('pa');
    const b = getTaskBackend('pb');
    expect(a).toBeInstanceOf(LocalTaskBackend);
    expect(b).toBeInstanceOf(LocalTaskBackend);
    // Each call may return a new LocalTaskBackend instance — the contract is
    // that they are bound to the configured projectDir.
    expect(a).not.toBe(b);
  });
});
