/**
 * Verifies that JsonlReader.parseFile redacts secret patterns from event content
 * before they are stored in SQLite.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

vi.mock('../db/db.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      task_id TEXT,
      task_url TEXT,
      project_context_url TEXT,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      pr_url TEXT,
      worktree_path TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      project_id TEXT,
      session_type TEXT NOT NULL DEFAULT 'standard',
      favorited INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      tags TEXT,
      metadata TEXT,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      task_name TEXT
    );
    CREATE TABLE IF NOT EXISTS session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      message_id TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
    );
    CREATE TABLE IF NOT EXISTS permission_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      proposed_action TEXT,
      decision TEXT NOT NULL,
      rule_matched TEXT,
      decided_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS permission_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_index INTEGER NOT NULL,
      pattern TEXT NOT NULL,
      match_type TEXT NOT NULL,
      decision TEXT NOT NULL,
      label TEXT,
      enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS permission_denials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_use_id TEXT NOT NULL,
      tool_input TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_cache (
      task_id TEXT PRIMARY KEY,
      fetched_at INTEGER NOT NULL,
      raw_json TEXT NOT NULL
    );
  `);
  return { db };
});

import { vi } from 'vitest';
import { JsonlReader } from '../session/JsonlReader.js';
import { db } from '../db/db.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonlreader-scrub-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeJsonl(filename: string, lines: unknown[]): string {
  const filePath = path.join(tmpDir, filename);
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n'));
  return filePath;
}

function getEventRows(sessionId: string) {
  return db
    .prepare('SELECT * FROM session_events WHERE session_id = ?')
    .all(sessionId) as Array<{ event_type: string; payload: string }>;
}

describe('JsonlReader.parseFile — secret scrubbing', () => {
  it('redacts sk-ant-* in tool_use argument content', () => {
    const filePath = writeJsonl('scrub-test.jsonl', [
      {
        type: 'tool_use',
        content: {
          id: 'tu_1',
          name: 'Bash',
          input: { command: 'echo sk-ant-api03-secretkeyvalue12345' },
        },
      },
    ]);

    const reader = new JsonlReader(tmpDir);
    const { events } = reader.parseFile(filePath);

    expect(events).toHaveLength(1);
    const content = events[0].content as {
      input: { command: string };
    };
    expect(content.input.command).toBe('echo [REDACTED]');
  });

  it('redacts ghp_* in a tool_result payload', () => {
    const filePath = writeJsonl('scrub-ghp.jsonl', [
      {
        type: 'tool_result',
        content: { output: 'token=ghp_abcdefghijklmnopqrst' },
      },
    ]);

    const reader = new JsonlReader(tmpDir);
    const { events } = reader.parseFile(filePath);

    expect(events).toHaveLength(1);
    const content = events[0].content as { output: string };
    expect(content.output).toBe('token=[REDACTED]');
  });

  it('writes scrubbed payloads to SQLite on importAll', async () => {
    const sessionId = 'scrub-import-01';
    writeJsonl(`${sessionId}.jsonl`, [
      {
        type: 'tool_use',
        content: {
          id: 'tu_2',
          name: 'Bash',
          input: {
            command: 'curl -H "Authorization: Bearer ntn_notiontoken12345"',
          },
        },
      },
    ]);

    const reader = new JsonlReader(tmpDir);
    await reader.importAll();

    const events = getEventRows(sessionId);
    expect(events).toHaveLength(1);
    expect(events[0].payload).not.toContain('ntn_notiontoken12345');
    expect(events[0].payload).toContain('[REDACTED]');
  });
});
