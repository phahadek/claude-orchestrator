import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// ── In-memory DB setup ────────────────────────────────────────────────────────
vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { recordEvent } from '../audit/AuditLog';

describe('audit_log migration', () => {
  it('creates the audit_log table with all required columns', async () => {
    const { db } = await import('../db/db.js');
    const row = (db as import('better-sqlite3').Database)
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'`,
      )
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('audit_log');
  });
});

describe('recordEvent()', () => {
  it('inserts a row with all fields populated', async () => {
    const { db } = await import('../db/db.js');

    recordEvent({
      event_type: 'session_launched',
      actor_type: 'ai',
      actor_id: 'session-abc',
      project_id: 'proj-1',
      task_id: 'task-1',
      payload: { session_type: 'standard' },
    });

    const row = (db as import('better-sqlite3').Database)
      .prepare(
        `SELECT * FROM audit_log WHERE event_type='session_launched' LIMIT 1`,
      )
      .get() as Record<string, unknown> | undefined;

    expect(row).toBeDefined();
    expect(row!.event_type).toBe('session_launched');
    expect(row!.actor_type).toBe('ai');
    expect(row!.actor_id).toBe('session-abc');
    expect(row!.project_id).toBe('proj-1');
    expect(row!.task_id).toBe('task-1');
    expect(typeof row!.ts).toBe('number');
    expect(JSON.parse(row!.payload as string)).toMatchObject({
      session_type: 'standard',
    });
  });

  it('produces a session_launched row with actor_type=ai when a session is launched', async () => {
    const { db } = await import('../db/db.js');

    const sessionId = 'session-launched-test';
    recordEvent({
      event_type: 'session_launched',
      actor_type: 'ai',
      actor_id: sessionId,
      project_id: 'proj-x',
      task_id: 'task-x',
      payload: { session_type: 'standard', task_url: 'https://notion.so/task' },
    });

    const row = (db as import('better-sqlite3').Database)
      .prepare(
        `SELECT * FROM audit_log WHERE event_type='session_launched' AND actor_id=? LIMIT 1`,
      )
      .get(sessionId) as Record<string, unknown> | undefined;

    expect(row).toBeDefined();
    expect(row!.event_type).toBe('session_launched');
    expect(row!.actor_type).toBe('ai');
  });
});

describe('recordEvent() project_id derivation', () => {
  it('populates project_id from actor_id when the actor is a known session and none was supplied', async () => {
    const { db } = await import('../db/db.js');
    db.prepare(
      `INSERT INTO sessions (session_id, task_id, task_url, project_context_url, status, started_at, project_id)
       VALUES ('sess-derive-actor', NULL, NULL, NULL, 'running', ?, 'proj-derive-actor')`,
    ).run(Date.now());

    recordEvent({
      event_type: 'session_marked_done_while_running',
      actor_type: 'system',
      actor_id: 'sess-derive-actor',
      payload: {},
    });

    const row = db
      .prepare(
        `SELECT project_id FROM audit_log WHERE event_type='session_marked_done_while_running' AND actor_id='sess-derive-actor'`,
      )
      .get() as { project_id: string | null } | undefined;
    expect(row?.project_id).toBe('proj-derive-actor');
  });

  it('populates project_id from task_id when the actor does not resolve but the task does', async () => {
    const { db } = await import('../db/db.js');
    db.prepare(
      `INSERT INTO task_repo_assignments (task_id, project_id, repo, assigned_by, assigned_at)
       VALUES ('task-derive', 'proj-derive-task', 'org/repo', 'system', ?)`,
    ).run(Date.now());

    recordEvent({
      event_type: 'pipeline_stage_entered',
      actor_type: 'system',
      task_id: 'task-derive',
      payload: {},
    });

    const row = db
      .prepare(
        `SELECT project_id FROM audit_log WHERE event_type='pipeline_stage_entered' AND task_id='task-derive'`,
      )
      .get() as { project_id: string | null } | undefined;
    expect(row?.project_id).toBe('proj-derive-task');
  });

  it('populates project_id from sessions.task_id when task_repo_assignments has no row (single-repo project)', async () => {
    const { db } = await import('../db/db.js');
    db.prepare(
      `INSERT INTO sessions (session_id, task_id, task_url, project_context_url, status, started_at, project_id)
       VALUES ('sess-single-repo', 'task-single-repo', NULL, NULL, 'running', ?, 'proj-single-repo')`,
    ).run(Date.now());

    recordEvent({
      event_type: 'pipeline_stage_entered',
      actor_type: 'system',
      task_id: 'task-single-repo',
      payload: {},
    });

    const row = db
      .prepare(
        `SELECT project_id FROM audit_log WHERE event_type='pipeline_stage_entered' AND task_id='task-single-repo'`,
      )
      .get() as { project_id: string | null } | undefined;
    expect(row?.project_id).toBe('proj-single-repo');
  });

  it('leaves project_id NULL and does not throw when neither actor nor task resolves', async () => {
    const { db } = await import('../db/db.js');

    expect(() =>
      recordEvent({
        event_type: 'process_boot',
        actor_type: 'system',
        payload: {},
      }),
    ).not.toThrow();

    const row = db
      .prepare(
        `SELECT project_id FROM audit_log WHERE event_type='process_boot'`,
      )
      .get() as { project_id: string | null } | undefined;
    expect(row?.project_id).toBeNull();
  });
});

describe('audit_log source-level DELETE/UPDATE guard', () => {
  it('backend source files contain no DELETE FROM audit_log statements', () => {
    const backendSrc = path.join(__dirname, '..', '..', 'src');
    const findings: string[] = [];

    function scanDir(dir: string): void {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (
          entry.isFile() &&
          entry.name.endsWith('.ts') &&
          !entry.name.endsWith('.test.ts')
        ) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          if (/DELETE\s+FROM\s+audit_log/i.test(content)) {
            findings.push(fullPath);
          }
        }
      }
    }

    scanDir(backendSrc);
    expect(findings).toHaveLength(0);
  });

  it('backend source files contain no UPDATE audit_log statements outside the schema migration', () => {
    const backendSrc = path.join(__dirname, '..', '..', 'src');
    const findings: string[] = [];
    // db/schema.ts is allowed a single, narrowly-scoped UPDATE audit_log
    // statement: the dashless→dashed task_id backfill migration (see its
    // surrounding comment). That migration only normalizes task_id's string
    // format for pre-existing rows — it never touches audit content
    // (actor/action/ts) — so it doesn't violate the append-only guarantee
    // this guard otherwise enforces for runtime application code.
    const allowedPath = path.join(backendSrc, 'db', 'schema.ts');

    function scanDir(dir: string): void {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (
          entry.isFile() &&
          entry.name.endsWith('.ts') &&
          !entry.name.endsWith('.test.ts') &&
          fullPath !== allowedPath
        ) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          if (/UPDATE\s+audit_log/i.test(content)) {
            findings.push(fullPath);
          }
        }
      }
    }

    scanDir(backendSrc);
    expect(findings).toHaveLength(0);
  });
});
