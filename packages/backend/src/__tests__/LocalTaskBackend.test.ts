import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { LocalTaskBackend } from '../tasks/LocalTaskBackend';

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

const fixtureFile = {
  board_id: 'test-board',
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
      context: '',
      acceptance_criteria: '',
      files_affected: [],
      notes: '',
    },
    {
      id: 'task-in-progress',
      name: 'In Progress Task',
      status: 'In Progress',
      priority: 'High',
      type: 'Code',
      depends_on: [],
      pr_url: null,
      context: '',
      acceptance_criteria: '',
      files_affected: [],
      notes: '',
    },
    {
      id: 'task-done',
      name: 'Done Task',
      status: 'Done',
      priority: 'Low',
      type: 'Code',
      depends_on: [],
      pr_url: null,
      context: '',
      acceptance_criteria: '',
      files_affected: [],
      notes: '',
    },
  ],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('LocalTaskBackend', () => {
  let tmpDir: string;
  let backend: LocalTaskBackend;

  beforeEach(() => {
    tmpDir = makeTempDir();
    writeTasksFile(tmpDir, fixtureFile);
    backend = new LocalTaskBackend(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── fetchReadyTasks() ─────────────────────────────────────────────────────

  describe('fetchReadyTasks()', () => {
    it('returns only tasks with status: Ready', async () => {
      const resolved = await backend.fetchReadyTasks('test-board');
      const ids = resolved.map((r) => r.task.id);

      expect(ids).toContain('task-ready-1');
      expect(ids).toContain('task-ready-2');
      expect(ids).not.toContain('task-in-progress');
      expect(ids).not.toContain('task-done');
    });

    it('returns ResolvedTask objects with blocked and wave fields', async () => {
      const resolved = await backend.fetchReadyTasks('test-board');
      for (const r of resolved) {
        expect(typeof r.blocked).toBe('boolean');
        expect(typeof r.wave).toBe('number');
        expect(Array.isArray(r.blockers)).toBe(true);
      }
    });
  });

  // ── attachPR() ────────────────────────────────────────────────────────────

  describe('attachPR()', () => {
    it('writes pr_url to the YAML file', async () => {
      await backend.attachPR('task-ready-1', 'https://github.com/owner/repo/pull/42');

      const file = readTasksFile(tmpDir) as { tasks: Array<{ id: string; pr_url: string | null }> };
      const task = file.tasks.find((t) => t.id === 'task-ready-1');
      expect(task?.pr_url).toBe('https://github.com/owner/repo/pull/42');
    });

    it('preserves all other fields when writing pr_url', async () => {
      await backend.attachPR('task-ready-1', 'https://github.com/owner/repo/pull/42');

      const file = readTasksFile(tmpDir) as { tasks: Array<Record<string, unknown>> };
      const task = file.tasks.find((t) => t.id === 'task-ready-1');
      expect(task?.name).toBe('Ready Task 1');
      expect(task?.status).toBe('Ready');
      expect(task?.priority).toBe('High');
      expect(task?.context).toBe('Implement something');
    });

    it('throws when task id is not found', async () => {
      await expect(
        backend.attachPR('nonexistent-task', 'https://github.com/owner/repo/pull/1'),
      ).rejects.toThrow(/task not found/);
    });
  });

  // ── updateStatus() ────────────────────────────────────────────────────────

  describe('updateStatus()', () => {
    it('writes the new status to the YAML file', async () => {
      await backend.updateStatus('task-ready-1', '🔄 In Progress');

      const file = readTasksFile(tmpDir) as { tasks: Array<{ id: string; status: string }> };
      const task = file.tasks.find((t) => t.id === 'task-ready-1');
      expect(task?.status).toBe('In Progress');
    });

    it('preserves all other fields when updating status', async () => {
      await backend.updateStatus('task-ready-1', '👀 In Review');

      const file = readTasksFile(tmpDir) as { tasks: Array<Record<string, unknown>> };
      const task = file.tasks.find((t) => t.id === 'task-ready-1');
      expect(task?.name).toBe('Ready Task 1');
      expect(task?.priority).toBe('High');
      expect(task?.context).toBe('Implement something');
      expect(task?.acceptance_criteria).toBe('- [ ] Done');
    });

    it('accepts display-format status with emoji prefix', async () => {
      await backend.updateStatus('task-ready-2', '✅ Done');

      const file = readTasksFile(tmpDir) as { tasks: Array<{ id: string; status: string }> };
      const task = file.tasks.find((t) => t.id === 'task-ready-2');
      expect(task?.status).toBe('Done');
    });

    it('throws when task id is not found', async () => {
      await expect(
        backend.updateStatus('nonexistent-task', '🔄 In Progress'),
      ).rejects.toThrow(/task not found/);
    });
  });

  // ── fetchTaskPage() ───────────────────────────────────────────────────────

  describe('fetchTaskPage()', () => {
    it('returns a markdown string with task context and acceptance criteria', async () => {
      const body = await backend.fetchTaskPage('task-ready-1');

      expect(typeof body).toBe('string');
      expect(body).toContain('Ready Task 1');
      expect(body).toContain('Implement something');
      expect(body).toContain('- [ ] Done');
      expect(body).toContain('src/foo.ts');
    });

    it('throws when task id is not found', async () => {
      await expect(backend.fetchTaskPage('nonexistent-task')).rejects.toThrow(/task not found/);
    });
  });

  // ── type ──────────────────────────────────────────────────────────────────

  it('has type === "local"', () => {
    expect(backend.type).toBe('local');
  });
});
