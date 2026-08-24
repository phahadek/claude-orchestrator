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
    body?: string;
    context?: string;
    acceptance_criteria?: string;
    files_affected?: string[];
    notes?: string;
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

function readTaskBody(dir: string, taskId: string): string | undefined {
  const raw = fs.readFileSync(path.join(dir, 'tasks.yaml'), 'utf-8');
  const parsed = yaml.load(raw) as {
    milestones: Array<{ tasks: Array<{ id: string; body?: string }> }>;
  };
  const task = parsed.milestones
    .flatMap((m) => m.tasks)
    .find((t) => t.id === taskId);
  return task?.body;
}

const SAMPLE_SECTIONS = {
  summary: 'Do the thing.',
  dependencies: [],
  context: [],
  automatedCriteria: ['tsc passes'],
  manualCriteria: [],
};

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

    expect(id).toBe('yaml:proj-1-foo-bar');
    const file = readTasksYaml(tmpDir);
    expect(file.milestones[0].tasks[0].id).toBe('proj-1-foo-bar');
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

    expect(first).toBe('yaml:proj-1-foo-bar');
    expect(second).toBe('yaml:proj-1-foo-bar-2');
  });

  it('prefixes minted ids with projectId so two projects with the same title never collide in task_cache', async () => {
    const dirA = fs.mkdtempSync(
      path.join(os.tmpdir(), 'local-backend-test-a-'),
    );
    const dirB = fs.mkdtempSync(
      path.join(os.tmpdir(), 'local-backend-test-b-'),
    );
    writeTempTasksYaml(dirA, []);
    writeTempTasksYaml(dirB, []);
    const backendA = new LocalTaskBackend(dirA, 'proj-a');
    const backendB = new LocalTaskBackend(dirB, 'proj-b');

    const idA = await backendA.createTask!({
      databaseId: 'ms-1',
      title: 'Fix Login Bug',
    });
    const idB = await backendB.createTask!({
      databaseId: 'ms-1',
      title: 'Fix Login Bug',
    });

    expect(idA).toBe('yaml:proj-a-fix-login-bug');
    expect(idB).toBe('yaml:proj-b-fix-login-bug');
    expect(idA).not.toBe(idB);
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

describe('LocalTaskBackend.updateBody', () => {
  it('renders sections and writes body; fetchTaskPage reflects it afterward', async () => {
    writeTempTasksYaml(tmpDir, [
      { id: 'task-a', name: 'Task A', status: 'Ready' },
    ]);
    const backend = new LocalTaskBackend(tmpDir, 'proj-1');

    await backend.updateBody('yaml:task-a', SAMPLE_SECTIONS);

    const written = readTaskBody(tmpDir, 'task-a');
    expect(written).toContain('## Summary');
    expect(written).toContain('Do the thing.');

    const page = await backend.fetchTaskPage('yaml:task-a');
    expect(page).toBe(written);
  });
});

describe('LocalTaskBackend.patchBodySection', () => {
  it('append/replace/remove against an existing body', async () => {
    writeTempTasksYaml(tmpDir, [
      {
        id: 'task-a',
        name: 'Task A',
        status: 'Ready',
        body: '## Summary\nOriginal summary.\n\n## Notes\nSome notes.',
      },
    ]);
    const backend = new LocalTaskBackend(tmpDir, 'proj-1');

    await backend.patchBodySection('yaml:task-a', 'Notes', {
      operation: 'replace',
      find: 'Some notes.',
      replaceWith: 'Updated notes.',
    });
    expect(readTaskBody(tmpDir, 'task-a')).toContain('Updated notes.');

    await backend.patchBodySection('yaml:task-a', 'Notes', {
      operation: 'remove',
    });
    expect(readTaskBody(tmpDir, 'task-a')).not.toContain('Updated notes.');
    expect(readTaskBody(tmpDir, 'task-a')).not.toContain('## Notes');

    await backend.patchBodySection('yaml:task-a', 'Open Questions', {
      operation: 'append',
      content: '- Does this work?',
    });
    const finalBody = readTaskBody(tmpDir, 'task-a');
    expect(finalBody).toContain('## Open Questions');
    expect(finalBody).toContain('- Does this work?');
  });

  it('splices against the fielded-assembly markdown for a legacy task with no body field, and populates body', async () => {
    writeTempTasksYaml(tmpDir, [
      {
        id: 'task-a',
        name: 'Task A',
        status: 'Ready',
        context: 'Legacy context.',
        notes: 'Legacy notes.',
      },
    ]);
    const backend = new LocalTaskBackend(tmpDir, 'proj-1');

    await backend.patchBodySection('yaml:task-a', 'Open Questions', {
      operation: 'append',
      content: '- Anything unclear?',
    });

    const written = readTaskBody(tmpDir, 'task-a');
    expect(written).toBeDefined();
    expect(written).toContain('Legacy context.');
    expect(written).toContain('Legacy notes.');
    expect(written).toContain('## Open Questions');
    expect(written).toContain('- Anything unclear?');
  });

  it('replace against missing find-text throws explicitly', async () => {
    writeTempTasksYaml(tmpDir, [
      {
        id: 'task-a',
        name: 'Task A',
        status: 'Ready',
        body: '## Notes\nSome notes.',
      },
    ]);
    const backend = new LocalTaskBackend(tmpDir, 'proj-1');

    await expect(
      backend.patchBodySection('yaml:task-a', 'Notes', {
        operation: 'replace',
        find: 'nonexistent text',
        replaceWith: 'new text',
      }),
    ).rejects.toThrow();
  });

  it('remove on an absent section is a no-op', async () => {
    writeTempTasksYaml(tmpDir, [
      {
        id: 'task-a',
        name: 'Task A',
        status: 'Ready',
        body: '## Notes\nSome notes.',
      },
    ]);
    const backend = new LocalTaskBackend(tmpDir, 'proj-1');

    await backend.patchBodySection('yaml:task-a', 'Nonexistent Section', {
      operation: 'remove',
    });

    expect(readTaskBody(tmpDir, 'task-a')).toBe('## Notes\nSome notes.');
  });
});

describe('LocalTaskBackend.appendImplementationNote / updateNotes — body reconciliation', () => {
  it('appendImplementationNote on a task with a body appends into the Implementation notes section, not legacy notes', async () => {
    writeTempTasksYaml(tmpDir, [
      {
        id: 'task-a',
        name: 'Task A',
        status: 'Ready',
        body: '## Summary\nDo the thing.\n\n## Implementation notes\nFirst note.',
        notes: 'Legacy notes untouched.',
      },
    ]);
    const backend = new LocalTaskBackend(tmpDir, 'proj-1');

    await backend.appendImplementationNote('yaml:task-a', 'Second note.');

    const body = readTaskBody(tmpDir, 'task-a');
    expect(body).toContain('First note.');
    expect(body).toContain('Second note.');

    const raw = yaml.load(
      fs.readFileSync(path.join(tmpDir, 'tasks.yaml'), 'utf-8'),
    );
    const task = raw.milestones[0].tasks[0];
    expect(task.notes).toBe('Legacy notes untouched.');
  });

  it('appendImplementationNote on a legacy task with no body keeps writing the notes field, unchanged from current behavior', async () => {
    writeTempTasksYaml(tmpDir, [
      { id: 'task-a', name: 'Task A', status: 'Ready', notes: 'Existing.' },
    ]);
    const backend = new LocalTaskBackend(tmpDir, 'proj-1');

    await backend.appendImplementationNote('yaml:task-a', 'Appended.');

    const raw = yaml.load(
      fs.readFileSync(path.join(tmpDir, 'tasks.yaml'), 'utf-8'),
    );
    const task = raw.milestones[0].tasks[0];
    expect(task.notes).toBe('Existing.\nAppended.');
    expect(task.body).toBeUndefined();
  });

  it('updateNotes on a task with a body replaces the Implementation notes section content, not legacy notes', async () => {
    writeTempTasksYaml(tmpDir, [
      {
        id: 'task-a',
        name: 'Task A',
        status: 'Ready',
        body: '## Summary\nDo the thing.\n\n## Implementation notes\nOld note.',
        notes: 'Legacy notes untouched.',
      },
    ]);
    const backend = new LocalTaskBackend(tmpDir, 'proj-1');

    await backend.updateNotes('yaml:task-a', 'Brand new note.');

    const body = readTaskBody(tmpDir, 'task-a');
    expect(body).not.toContain('Old note.');
    expect(body).toContain('Brand new note.');

    const raw = yaml.load(
      fs.readFileSync(path.join(tmpDir, 'tasks.yaml'), 'utf-8'),
    );
    const task = raw.milestones[0].tasks[0];
    expect(task.notes).toBe('Legacy notes untouched.');
  });

  it('updateNotes on a legacy task with no body keeps writing the notes field, unchanged from current behavior', async () => {
    writeTempTasksYaml(tmpDir, [
      { id: 'task-a', name: 'Task A', status: 'Ready', notes: 'Old.' },
    ]);
    const backend = new LocalTaskBackend(tmpDir, 'proj-1');

    await backend.updateNotes('yaml:task-a', 'New.');

    const raw = yaml.load(
      fs.readFileSync(path.join(tmpDir, 'tasks.yaml'), 'utf-8'),
    );
    const task = raw.milestones[0].tasks[0];
    expect(task.notes).toBe('New.');
    expect(task.body).toBeUndefined();
  });
});
