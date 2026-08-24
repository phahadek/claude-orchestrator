import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import yaml from 'js-yaml';

vi.mock('../db/queries', () => ({
  getGrantedCapabilities: vi.fn(() => []),
  upsertTaskCache: vi.fn(),
}));

vi.mock('../projects/ProjectService', () => ({
  ProjectService: {
    listMilestones: vi.fn(() => [
      {
        id: 'db-ms-1',
        projectId: 'proj-1',
        name: 'Milestone 1',
        sourceId: 'ms-1',
        displayOrder: 0,
        createdAt: 0,
        updatedAt: 0,
      },
    ]),
  },
}));

import { LocalTaskBackend } from './LocalTaskBackend';
import { upsertTaskCache } from '../db/queries';

function writeTempTasksYaml(
  dir: string,
  tasks: Array<{
    id: string;
    name: string;
    status: string;
    depends_on?: string[];
    reviewer?: string[];
  }>,
): void {
  const content = yaml.dump({
    milestones: [
      {
        id: 'ms-1',
        name: 'Milestone 1',
        tasks,
      },
    ],
  });
  fs.writeFileSync(path.join(dir, 'tasks.yaml'), content, 'utf-8');
}

let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-backend-test-'));
});

describe('LocalTaskBackend.fetchReadyTasks — dependsOn prefixing', () => {
  it('prefixes every dependsOn entry with yaml: alongside the task id', async () => {
    writeTempTasksYaml(tmpDir, [
      { id: 'task-a', name: 'Task A', status: 'Ready', depends_on: ['task-b'] },
      { id: 'task-b', name: 'Task B', status: 'Ready' },
    ]);

    const backend = new LocalTaskBackend(tmpDir, 'proj-1');
    const result = await backend.fetchReadyTasks('ms-1');

    const taskA = result.find((r) => r.task.id === 'yaml:task-a')!;
    expect(taskA).toBeDefined();
    expect(taskA.task.dependsOn).toEqual(['yaml:task-b']);
  });

  it('returns tasks with no depends_on as empty array (no prefix applied)', async () => {
    writeTempTasksYaml(tmpDir, [
      { id: 'task-x', name: 'Task X', status: 'Ready' },
    ]);

    const backend = new LocalTaskBackend(tmpDir, 'proj-1');
    const result = await backend.fetchReadyTasks('ms-1');

    expect(result[0].task.dependsOn).toEqual([]);
  });

  it('writes board cache with prefixed-everywhere shape (both id and dependsOn)', async () => {
    writeTempTasksYaml(tmpDir, [
      { id: 'task-a', name: 'Task A', status: 'Ready', depends_on: ['task-b'] },
      { id: 'task-b', name: 'Task B', status: 'Ready' },
    ]);

    const backend = new LocalTaskBackend(tmpDir, 'proj-1');
    await backend.fetchReadyTasks('ms-1');

    const boardCacheCall = vi
      .mocked(upsertTaskCache)
      .mock.calls.find(([key]) => key === 'board:db-ms-1');
    expect(boardCacheCall).toBeDefined();
    const cached = JSON.parse(boardCacheCall![1] as string) as Array<{
      id: string;
      dependsOn: string[];
    }>;
    const cachedA = cached.find((t) => t.id === 'yaml:task-a')!;
    expect(cachedA).toBeDefined();
    expect(cachedA.dependsOn).toEqual(['yaml:task-b']);
  });

  it('writes per-task cache with prefixed-everywhere shape', async () => {
    writeTempTasksYaml(tmpDir, [
      { id: 'task-a', name: 'Task A', status: 'Ready', depends_on: ['task-b'] },
      { id: 'task-b', name: 'Task B', status: 'Ready' },
    ]);

    const backend = new LocalTaskBackend(tmpDir, 'proj-1');
    await backend.fetchReadyTasks('ms-1');

    const perTaskCall = vi
      .mocked(upsertTaskCache)
      .mock.calls.find(([key]) => key === 'yaml:task-a');
    expect(perTaskCall).toBeDefined();
    const cached = JSON.parse(perTaskCall![1] as string) as {
      id: string;
      dependsOn: string[];
    };
    expect(cached.id).toBe('yaml:task-a');
    expect(cached.dependsOn).toEqual(['yaml:task-b']);
  });
});

describe('LocalTaskBackend.fetchReadyTasks — reviewer field round-trip', () => {
  it('round-trips reviewer: [alice, bob] into the per-task cache JSON', async () => {
    writeTempTasksYaml(tmpDir, [
      {
        id: 'task-a',
        name: 'Task A',
        status: 'Ready',
        reviewer: ['alice', 'bob'],
      },
    ]);

    const backend = new LocalTaskBackend(tmpDir, 'proj-1');
    await backend.fetchReadyTasks('ms-1');

    const perTaskCall = vi
      .mocked(upsertTaskCache)
      .mock.calls.find(([key]) => key === 'yaml:task-a');
    expect(perTaskCall).toBeDefined();
    const cached = JSON.parse(perTaskCall![1] as string) as {
      reviewer?: string[];
    };
    expect(cached.reviewer).toEqual(['alice', 'bob']);
  });

  it('omits reviewer when not specified in tasks.yaml', async () => {
    writeTempTasksYaml(tmpDir, [
      { id: 'task-x', name: 'Task X', status: 'Ready' },
    ]);

    const backend = new LocalTaskBackend(tmpDir, 'proj-1');
    const result = await backend.fetchReadyTasks('ms-1');

    expect(result[0].task.reviewer).toBeUndefined();
  });
});

function readTasksYaml(dir: string): {
  milestones: Array<{ id: string; name: string; tasks: any[] }>;
} {
  const raw = fs.readFileSync(path.join(dir, 'tasks.yaml'), 'utf-8');
  return yaml.load(raw) as any;
}

describe('LocalTaskBackend.setDependsOn', () => {
  it('overwrites depends_on, stripping the yaml: prefix', async () => {
    writeTempTasksYaml(tmpDir, [
      { id: 'task-a', name: 'Task A', status: 'Ready' },
      { id: 'task-b', name: 'Task B', status: 'Ready' },
    ]);
    const backend = new LocalTaskBackend(tmpDir, 'proj-1');

    await backend.setDependsOn!('yaml:task-a', ['yaml:task-b']);

    const file = readTasksYaml(tmpDir);
    const taskA = file.milestones[0].tasks.find((t) => t.id === 'task-a');
    expect(taskA.depends_on).toEqual(['task-b']);
  });

  it('throws for a missing task', async () => {
    writeTempTasksYaml(tmpDir, [
      { id: 'task-a', name: 'Task A', status: 'Ready' },
    ]);
    const backend = new LocalTaskBackend(tmpDir, 'proj-1');

    await expect(backend.setDependsOn!('yaml:missing', [])).rejects.toThrow(
      'task not found',
    );
  });
});

describe('LocalTaskBackend.setType', () => {
  it('reverse-maps display type to the internal yaml value', async () => {
    writeTempTasksYaml(tmpDir, [
      { id: 'task-a', name: 'Task A', status: 'Ready' },
    ]);
    const backend = new LocalTaskBackend(tmpDir, 'proj-1');

    await backend.setType!('yaml:task-a', '🧪 Testing');

    const file = readTasksYaml(tmpDir);
    expect(file.milestones[0].tasks[0].type).toBe('Testing');
  });

  it('throws for a missing task', async () => {
    writeTempTasksYaml(tmpDir, []);
    const backend = new LocalTaskBackend(tmpDir, 'proj-1');

    await expect(backend.setType!('yaml:missing', '💻 Code')).rejects.toThrow(
      'task not found',
    );
  });
});

describe('LocalTaskBackend.setProperties', () => {
  it('applies priority and title from a partial patch', async () => {
    writeTempTasksYaml(tmpDir, [
      { id: 'task-a', name: 'Task A', status: 'Ready' },
    ]);
    const backend = new LocalTaskBackend(tmpDir, 'proj-1');

    await backend.setProperties!('yaml:task-a', {
      priority: '🔴 High',
      title: 'Renamed Task',
    });

    const file = readTasksYaml(tmpDir);
    const task = file.milestones[0].tasks[0];
    expect(task.priority).toBe('High');
    expect(task.name).toBe('Renamed Task');
  });

  it('throws for a missing task', async () => {
    writeTempTasksYaml(tmpDir, []);
    const backend = new LocalTaskBackend(tmpDir, 'proj-1');

    await expect(
      backend.setProperties!('yaml:missing', { title: 'X' }),
    ).rejects.toThrow('task not found');
  });
});

describe('LocalTaskBackend.archive', () => {
  it('removes the task node from its milestone tasks array', async () => {
    writeTempTasksYaml(tmpDir, [
      { id: 'task-a', name: 'Task A', status: 'Ready' },
      { id: 'task-b', name: 'Task B', status: 'Ready' },
    ]);
    const backend = new LocalTaskBackend(tmpDir, 'proj-1');

    await backend.archive!('yaml:task-a');

    const file = readTasksYaml(tmpDir);
    expect(file.milestones[0].tasks.map((t) => t.id)).toEqual(['task-b']);
  });

  it('throws for a missing task', async () => {
    writeTempTasksYaml(tmpDir, []);
    const backend = new LocalTaskBackend(tmpDir, 'proj-1');

    await expect(backend.archive!('yaml:missing')).rejects.toThrow(
      'task not found',
    );
  });
});

describe('LocalTaskBackend.createTask', () => {
  it('mints an id by slugifying the title', async () => {
    writeTempTasksYaml(tmpDir, []);
    const backend = new LocalTaskBackend(tmpDir, 'proj-1');

    const id = await backend.createTask!({
      databaseId: 'ms-1',
      title: 'Foo Bar',
    });

    expect(id).toBe('yaml:foo-bar');
    const file = readTasksYaml(tmpDir);
    expect(file.milestones[0].tasks[0].id).toBe('foo-bar');
  });

  it('de-duplicates on id collision within the same milestone', async () => {
    writeTempTasksYaml(tmpDir, []);
    const backend = new LocalTaskBackend(tmpDir, 'proj-1');

    const first = await backend.createTask!({
      databaseId: 'ms-1',
      title: 'Foo Bar',
    });
    const second = await backend.createTask!({
      databaseId: 'ms-1',
      title: 'Foo Bar',
    });

    expect(first).toBe('yaml:foo-bar');
    expect(second).toBe('yaml:foo-bar-2');
  });

  it('always creates at Backlog status regardless of input', async () => {
    writeTempTasksYaml(tmpDir, []);
    const backend = new LocalTaskBackend(tmpDir, 'proj-1');

    await backend.createTask!({
      databaseId: 'ms-1',
      title: 'Some Task',
    });

    const file = readTasksYaml(tmpDir);
    expect(file.milestones[0].tasks[0].status).toBe('Backlog');
  });

  it('throws for an unknown milestone', async () => {
    writeTempTasksYaml(tmpDir, []);
    const backend = new LocalTaskBackend(tmpDir, 'proj-1');

    await expect(
      backend.createTask!({ databaseId: 'missing-ms', title: 'X' }),
    ).rejects.toThrow('milestone not found');
  });
});
