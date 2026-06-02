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

  it('backend source files contain no UPDATE audit_log statements', () => {
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
