import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ResolvedTask } from '../notion/types';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../db/queries.js', () => ({
  upsertTaskCache: vi.fn(),
  hasActiveSessionForTask: vi.fn().mockReturnValue(false),
  getPausedPrReasonForTask: vi.fn().mockReturnValue(null),
}));

vi.mock('../db/db.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         INTEGER NOT NULL,
      event_type TEXT    NOT NULL,
      actor_type TEXT    NOT NULL,
      actor_id   TEXT,
      project_id TEXT,
      task_id    TEXT,
      payload    TEXT    NOT NULL
    );
  `);
  return { db };
});

const { mockRuntimeSettings, mockGetMilestone } = vi.hoisted(() => ({
  mockRuntimeSettings: { corporate_mode_enabled: false },
  mockGetMilestone: vi.fn(),
}));

vi.mock('../config.js', () => ({
  runtimeSettings: mockRuntimeSettings,
  getAllProjects: vi.fn(),
}));

vi.mock('../projects/ProjectService.js', () => ({
  ProjectService: {
    getMilestone: mockGetMilestone,
  },
}));

// ── Imports after mocks ────────────────────────────────────────────────────────

import { NotionTaskBackend } from '../tasks/NotionTaskBackend.js';
import { resolveStartingPoint } from '../session/branchModel.js';
import { recordEvent } from '../audit/AuditLog.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeNotionTask(overrides: Partial<ResolvedTask['task']> = {}): ResolvedTask {
  return {
    task: {
      id: 'task-1',
      title: 'Fix login bug',
      status: '🗂️ Ready',
      type: '💻 Code',
      dependsOn: [],
      notionUrl: 'https://notion.so/task-1',
      ...overrides,
    },
    blocked: false,
    blockers: [],
    nonCode: false,
    wave: 1,
    source: 'notion',
  };
}

// ── Provider selection gate ────────────────────────────────────────────────────

describe('NotionTaskBackend.fetchNonMilestoneReadyTasks', () => {
  it('returns [] when sourceConfig is null (no source configured)', async () => {
    const client = {
      fetchReadyTasks: vi.fn(),
      attachPR: vi.fn(),
      updateStatus: vi.fn(),
      fetchTaskPage: vi.fn(),
    };
    const backend = new NotionTaskBackend(client as never);
    const result = await backend.fetchNonMilestoneReadyTasks(null);
    expect(result).toEqual([]);
    expect(client.fetchReadyTasks).not.toHaveBeenCalled();
  });

  it('returns [] when sourceConfig has no notionDatabaseId', async () => {
    const client = {
      fetchReadyTasks: vi.fn(),
      attachPR: vi.fn(),
      updateStatus: vi.fn(),
      fetchTaskPage: vi.fn(),
    };
    const backend = new NotionTaskBackend(client as never);
    const result = await backend.fetchNonMilestoneReadyTasks({});
    expect(result).toEqual([]);
    expect(client.fetchReadyTasks).not.toHaveBeenCalled();
  });

  it('fetches only from the configured database when notionDatabaseId is set', async () => {
    const tasks = [makeNotionTask()];
    const client = {
      fetchReadyTasks: vi.fn().mockResolvedValue(tasks),
      attachPR: vi.fn(),
      updateStatus: vi.fn(),
      fetchTaskPage: vi.fn(),
    };
    const backend = new NotionTaskBackend(client as never);
    const result = await backend.fetchNonMilestoneReadyTasks({
      notionDatabaseId: 'nm-db-id-123',
    });
    expect(client.fetchReadyTasks).toHaveBeenCalledWith('nm-db-id-123', true);
    expect(result).toHaveLength(1);
    expect(result[0].task.id).toMatch(/^notion:/);
  });

  it('caches results under non_milestone:<projectId> when projectId provided', async () => {
    const { upsertTaskCache } = await import('../db/queries.js');
    const tasks = [makeNotionTask()];
    const client = {
      fetchReadyTasks: vi.fn().mockResolvedValue(tasks),
      attachPR: vi.fn(),
      updateStatus: vi.fn(),
      fetchTaskPage: vi.fn(),
    };
    const backend = new NotionTaskBackend(client as never);
    await backend.fetchNonMilestoneReadyTasks(
      { notionDatabaseId: 'nm-db-id-123' },
      'proj-1',
    );
    expect(upsertTaskCache).toHaveBeenCalledWith(
      'non_milestone:proj-1',
      expect.any(String),
    );
  });
});

// ── Branching workflow ─────────────────────────────────────────────────────────

describe('non-milestone task branching', () => {
  beforeEach(() => {
    mockRuntimeSettings.corporate_mode_enabled = false;
    mockGetMilestone.mockReset();
  });

  it('uses flat branching (dev) for non-milestone tasks regardless of project mode', () => {
    // Non-milestone tasks: milestoneId = null
    const resultTwoTier = resolveStartingPoint(
      { milestoneBranching: 'two_tier' },
      null,
    );
    expect(resultTwoTier.startingPoint).toBe('dev');
    expect(resultTwoTier.milestoneSlug).toBeNull();
  });

  it('uses flat branching (dev) for non-milestone tasks even with corporate mode on', () => {
    mockRuntimeSettings.corporate_mode_enabled = true;
    const result = resolveStartingPoint({ milestoneBranching: null }, null);
    expect(result.startingPoint).toBe('dev');
  });

  it('uses two-tier branching for milestone tasks when two_tier is configured', () => {
    mockGetMilestone.mockReturnValue({ id: 'ms-1', name: 'M6 Readiness' });
    const result = resolveStartingPoint(
      { milestoneBranching: 'two_tier' },
      'ms-1',
    );
    expect(result.startingPoint).toBe('feature/m6-readiness');
  });
});

// ── Audit log task_kind ────────────────────────────────────────────────────────

describe('audit log task_kind', () => {
  it('records task_kind: non_milestone in session_launched events for non-milestone tasks', async () => {
    const { db } = await import('../db/db.js');

    recordEvent({
      event_type: 'session_launched',
      actor_type: 'ai',
      actor_id: 'session-nm-1',
      project_id: 'proj-1',
      task_id: 'notion:task-abc',
      payload: {
        session_type: 'standard',
        task_url: 'https://notion.so/task-abc',
        task_kind: 'non_milestone',
      },
    });

    const row = (db as import('better-sqlite3').Database)
      .prepare(
        `SELECT payload FROM audit_log WHERE actor_id='session-nm-1' LIMIT 1`,
      )
      .get() as { payload: string } | undefined;

    expect(row).toBeDefined();
    const payload = JSON.parse(row!.payload) as Record<string, unknown>;
    expect(payload.task_kind).toBe('non_milestone');
  });

  it('records task_kind: milestone in session_launched events for milestone tasks', async () => {
    const { db } = await import('../db/db.js');

    recordEvent({
      event_type: 'session_launched',
      actor_type: 'ai',
      actor_id: 'session-ms-1',
      project_id: 'proj-1',
      task_id: 'notion:task-xyz',
      payload: {
        session_type: 'standard',
        task_url: 'https://notion.so/task-xyz',
        task_kind: 'milestone',
      },
    });

    const row = (db as import('better-sqlite3').Database)
      .prepare(
        `SELECT payload FROM audit_log WHERE actor_id='session-ms-1' LIMIT 1`,
      )
      .get() as { payload: string } | undefined;

    expect(row).toBeDefined();
    const payload = JSON.parse(row!.payload) as Record<string, unknown>;
    expect(payload.task_kind).toBe('milestone');
  });
});

// ── Schema migration ──────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';

describe('schema migration — non_milestone_source_config column', () => {
  const schemaSource = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'schema.ts'),
    'utf-8',
  );

  it('adds projects.non_milestone_source_config column', () => {
    expect(schemaSource).toMatch(
      /ALTER TABLE projects ADD COLUMN non_milestone_source_config TEXT/,
    );
  });
});
