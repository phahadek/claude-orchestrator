import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';

// In-memory SQLite so the queries module can prepare statements without a real db file.
vi.mock('../../src/db/db.js', async () => {
  const { setupTestDb } = await import('../helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { LocalTaskBackend } from '../../src/tasks/LocalTaskBackend';
import { getTaskCache } from '../../src/db/queries';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'local-task-backend-test-'));
}

function writeTasksFile(dir: string, content: object): void {
  fs.writeFileSync(path.join(dir, 'tasks.yaml'), yaml.dump(content));
}

function readTasksFile(dir: string): object {
  const raw = fs.readFileSync(path.join(dir, 'tasks.yaml'), 'utf-8');
  return yaml.load(raw) as object;
}

const milestoneFixture = {
  project: { id: 'p1', name: 'P1' },
  milestones: [
    {
      id: 'm1',
      name: 'M1',
      tasks: [
        {
          id: 'task-ready-1',
          name: 'Ready Task 1',
          status: 'Ready',
          priority: 'High',
          type: 'Code',
          depends_on: [],
          pr_url: null,
          context: 'Implement something',
          acceptance_criteria: '- [ ] Done',
          files_affected: ['src/foo.ts'],
          notes: '',
        },
        {
          id: 'task-ready-2',
          name: 'Ready Task 2',
          status: 'Ready',
          priority: 'Medium',
          type: 'Code',
          depends_on: [],
          pr_url: null,
        },
        {
          id: 'task-in-progress',
          name: 'In Progress Task',
          status: 'In Progress',
          priority: 'High',
          type: 'Code',
          depends_on: [],
          pr_url: null,
        },
        {
          id: 'task-done',
          name: 'Done Task',
          status: 'Done',
          priority: 'Low',
          type: 'Code',
          depends_on: [],
          pr_url: null,
        },
      ],
    },
    {
      id: 'm2',
      name: 'M2',
      tasks: [
        {
          id: 'task-other-milestone',
          name: 'Other Milestone Task',
          status: 'Ready',
          priority: 'Low',
          type: 'Code',
          depends_on: [],
          pr_url: null,
        },
      ],
    },
  ],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('LocalTaskBackend (milestone schema)', () => {
  let tmpDir: string;
  let backend: LocalTaskBackend;

  beforeEach(() => {
    tmpDir = makeTempDir();
    writeTasksFile(tmpDir, milestoneFixture);
    backend = new LocalTaskBackend(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('fetchReadyTasks(milestoneId)', () => {
    it('returns every task within the requested milestone regardless of status', async () => {
      const resolved = await backend.fetchReadyTasks('m1');
      const ids = resolved.map((r) => r.task.id);

      expect(ids).toContain('yaml:task-ready-1');
      expect(ids).toContain('yaml:task-ready-2');
      expect(ids).toContain('yaml:task-in-progress');
      expect(ids).toContain('yaml:task-done');
      expect(ids).not.toContain('yaml:task-other-milestone');
    });

    it('does not bleed tasks across milestones', async () => {
      const m2 = await backend.fetchReadyTasks('m2');
      expect(m2.map((r) => r.task.id)).toEqual(['yaml:task-other-milestone']);
    });

    it('throws when milestoneId is unknown', async () => {
      await expect(backend.fetchReadyTasks('does-not-exist')).rejects.toThrow(
        /milestone not found/,
      );
    });

    it('writes a board:<milestoneId> row and one row per task to task_cache', async () => {
      await backend.fetchReadyTasks('m1');

      const board = getTaskCache('board:m1');
      expect(board).toBeDefined();

      for (const id of [
        'yaml:task-ready-1',
        'yaml:task-ready-2',
        'yaml:task-in-progress',
        'yaml:task-done',
      ]) {
        const row = getTaskCache(id);
        expect(row, `missing per-task cache row for ${id}`).toBeDefined();
      }
    });
  });

  describe('attachPR()', () => {
    it('writes pr_url and preserves milestone structure', async () => {
      await backend.attachPR(
        'yaml:task-ready-1',
        'https://github.com/owner/repo/pull/42',
      );

      const file = readTasksFile(tmpDir) as {
        milestones: {
          id: string;
          tasks: Array<{ id: string; pr_url?: string | null; name?: string }>;
        }[];
      };
      expect(file.milestones).toHaveLength(2);
      expect(file.milestones[0].id).toBe('m1');
      const task = file.milestones[0].tasks.find(
        (t) => t.id === 'task-ready-1',
      );
      expect(task?.pr_url).toBe('https://github.com/owner/repo/pull/42');
      // Surrounding tasks remain
      expect(file.milestones[0].tasks.map((t) => t.id)).toEqual([
        'task-ready-1',
        'task-ready-2',
        'task-in-progress',
        'task-done',
      ]);
      expect(file.milestones[1].tasks.map((t) => t.id)).toEqual([
        'task-other-milestone',
      ]);
    });

    it('throws when task id is not found in any milestone', async () => {
      await expect(
        backend.attachPR(
          'yaml:nonexistent-task',
          'https://github.com/owner/repo/pull/1',
        ),
      ).rejects.toThrow(/task not found/);
    });
  });

  describe('updateStatus()', () => {
    it('writes the new status and preserves the rest of the file', async () => {
      await backend.updateStatus('yaml:task-ready-1', '🔄 In Progress');

      const file = readTasksFile(tmpDir) as {
        milestones: {
          id: string;
          tasks: Array<{ id: string; status: string; name?: string }>;
        }[];
      };
      const task = file.milestones[0].tasks.find(
        (t) => t.id === 'task-ready-1',
      );
      expect(task?.status).toBe('In Progress');
      // Other tasks within same milestone unchanged
      const inProg = file.milestones[0].tasks.find(
        (t) => t.id === 'task-in-progress',
      );
      expect(inProg?.status).toBe('In Progress');
      // Other milestone untouched
      expect(file.milestones[1].tasks[0].status).toBe('Ready');
    });

    it('finds tasks across milestones', async () => {
      await backend.updateStatus('yaml:task-other-milestone', '✅ Done');
      const file = readTasksFile(tmpDir) as {
        milestones: {
          id: string;
          tasks: Array<{ id: string; status: string }>;
        }[];
      };
      expect(file.milestones[1].tasks[0].status).toBe('Done');
    });

    it('throws when task id is not found', async () => {
      await expect(
        backend.updateStatus('yaml:nonexistent-task', '🔄 In Progress'),
      ).rejects.toThrow(/task not found/);
    });
  });

  describe('fetchTaskPage()', () => {
    it('returns markdown for a task in any milestone', async () => {
      const body = await backend.fetchTaskPage('yaml:task-ready-1');
      expect(body).toContain('Ready Task 1');
      expect(body).toContain('Implement something');
      expect(body).toContain('- [ ] Done');
      expect(body).toContain('src/foo.ts');
    });

    it('throws when task id is not found', async () => {
      await expect(backend.fetchTaskPage('yaml:nope')).rejects.toThrow(
        /task not found/,
      );
    });
  });

  describe('migration: flat → milestone schema', () => {
    it('auto-migrates a flat tasks.yaml on first read', async () => {
      const flatDir = makeTempDir();
      try {
        const flatFixture = {
          board_id: 'default',
          tasks: [
            {
              id: 't1',
              name: 'T1',
              status: 'Ready',
              type: 'Code',
              depends_on: [],
              pr_url: null,
            },
            {
              id: 't2',
              name: 'T2',
              status: 'Done',
              type: 'Code',
              depends_on: [],
              pr_url: null,
            },
          ],
        };
        writeTasksFile(flatDir, flatFixture);

        const flatBackend = new LocalTaskBackend(flatDir);
        const ready = await flatBackend.fetchReadyTasks('m1');
        expect(ready.map((r) => r.task.id).sort()).toEqual([
          'yaml:t1',
          'yaml:t2',
        ]);

        // Disk file is now in milestone schema
        const onDisk = readTasksFile(flatDir) as Record<string, unknown>;
        expect(onDisk.milestones).toBeDefined();
        expect(onDisk.tasks).toBeUndefined();
        expect((onDisk.milestones as Array<{ id: string }>)[0].id).toBe('m1');
      } finally {
        fs.rmSync(flatDir, { recursive: true, force: true });
      }
    });

    it('uses board_id as the migrated milestone id when non-default', async () => {
      const flatDir = makeTempDir();
      try {
        writeTasksFile(flatDir, {
          board_id: 'sprint-3',
          tasks: [
            {
              id: 't1',
              name: 'T1',
              status: 'Ready',
              type: 'Code',
              depends_on: [],
              pr_url: null,
            },
          ],
        });
        const flatBackend = new LocalTaskBackend(flatDir);
        const ready = await flatBackend.fetchReadyTasks('sprint-3');
        expect(ready).toHaveLength(1);
      } finally {
        fs.rmSync(flatDir, { recursive: true, force: true });
      }
    });

    it('is a no-op when reading a file already in the milestone schema (idempotent)', async () => {
      const beforeMtime = fs.statSync(path.join(tmpDir, 'tasks.yaml')).mtimeMs;
      // Wait so any rewrite would produce a newer mtime
      await new Promise((r) => setTimeout(r, 20));
      await backend.fetchReadyTasks('m1');
      const afterMtime = fs.statSync(path.join(tmpDir, 'tasks.yaml')).mtimeMs;
      expect(afterMtime).toBe(beforeMtime);
    });

    it('throws a clear error when tasks.yaml is missing', async () => {
      const emptyDir = makeTempDir();
      try {
        const b = new LocalTaskBackend(emptyDir);
        await expect(b.fetchReadyTasks('m1')).rejects.toThrow(
          /tasks.yaml not found/,
        );
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });
  });

  it('has type === "local"', () => {
    expect(backend.type).toBe('local');
  });
});
