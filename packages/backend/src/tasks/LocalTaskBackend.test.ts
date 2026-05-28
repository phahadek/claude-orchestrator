import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import yaml from 'js-yaml';

vi.mock('../db/queries', () => ({
  upsertTaskCache: vi.fn(),
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

    const backend = new LocalTaskBackend(tmpDir);
    const result = await backend.fetchReadyTasks('ms-1');

    const taskA = result.find((r) => r.task.id === 'yaml:task-a')!;
    expect(taskA).toBeDefined();
    expect(taskA.task.dependsOn).toEqual(['yaml:task-b']);
  });

  it('returns tasks with no depends_on as empty array (no prefix applied)', async () => {
    writeTempTasksYaml(tmpDir, [
      { id: 'task-x', name: 'Task X', status: 'Ready' },
    ]);

    const backend = new LocalTaskBackend(tmpDir);
    const result = await backend.fetchReadyTasks('ms-1');

    expect(result[0].task.dependsOn).toEqual([]);
  });

  it('writes board cache with prefixed-everywhere shape (both id and dependsOn)', async () => {
    writeTempTasksYaml(tmpDir, [
      { id: 'task-a', name: 'Task A', status: 'Ready', depends_on: ['task-b'] },
      { id: 'task-b', name: 'Task B', status: 'Ready' },
    ]);

    const backend = new LocalTaskBackend(tmpDir);
    await backend.fetchReadyTasks('ms-1');

    const boardCacheCall = vi
      .mocked(upsertTaskCache)
      .mock.calls.find(([key]) => key === 'board:ms-1');
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

    const backend = new LocalTaskBackend(tmpDir);
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
