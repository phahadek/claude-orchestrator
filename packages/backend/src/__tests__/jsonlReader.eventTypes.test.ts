import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

vi.mock('../db/db.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id          TEXT    PRIMARY KEY,
      notion_task_id      TEXT,
      notion_task_url     TEXT,
      project_context_url TEXT,
      status              TEXT    NOT NULL,
      started_at          INTEGER NOT NULL,
      ended_at            INTEGER,
      pr_url              TEXT,
      worktree_path       TEXT,
      archived            INTEGER NOT NULL DEFAULT 0,
      project_id          TEXT,
      session_type        TEXT    NOT NULL DEFAULT 'standard',
      favorited           INTEGER NOT NULL DEFAULT 0,
      note                TEXT,
      tags                TEXT,
      metadata            TEXT,
      total_input_tokens  INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      model               TEXT,
      task_name           TEXT
    );
    CREATE TABLE IF NOT EXISTS session_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   TEXT    NOT NULL,
      event_type   TEXT    NOT NULL,
      payload      TEXT    NOT NULL,
      timestamp    INTEGER NOT NULL,
      message_id   TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
    );
    CREATE TABLE IF NOT EXISTS permission_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      TEXT    NOT NULL,
      tool_name       TEXT    NOT NULL,
      proposed_action TEXT,
      decision        TEXT    NOT NULL,
      rule_matched    TEXT,
      decided_at      INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS permission_rules (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      order_index INTEGER NOT NULL,
      pattern     TEXT    NOT NULL,
      match_type  TEXT    NOT NULL,
      decision    TEXT    NOT NULL,
      label       TEXT,
      enabled     INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS permission_denials (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT    NOT NULL,
      tool_name   TEXT    NOT NULL,
      tool_use_id TEXT    NOT NULL,
      tool_input  TEXT    NOT NULL,
      timestamp   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_cache (
      notion_task_id TEXT    PRIMARY KEY,
      fetched_at     INTEGER NOT NULL,
      raw_json       TEXT    NOT NULL
    );
  `);
  return { db };
});

import { JsonlReader } from '../session/JsonlReader.js';
import { db } from '../db/db.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonlreader-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeJsonl(filename: string, lines: unknown[]): string {
  const filePath = path.join(tmpDir, filename);
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n'));
  return filePath;
}

function getSessionRow(sessionId: string) {
  return db
    .prepare('SELECT * FROM sessions WHERE session_id = ?')
    .get(sessionId) as { metadata: string | null } | undefined;
}

function getEventRows(sessionId: string) {
  return db
    .prepare('SELECT * FROM session_events WHERE session_id = ?')
    .all(sessionId) as Array<{ event_type: string; payload: string }>;
}

describe('JsonlReader — parseFile new event types', () => {
  it('ai-title: extracts aiTitle into metadata and produces no session event', () => {
    const filePath = writeJsonl('ai-title-test.jsonl', [
      { type: 'ai-title', aiTitle: 'Test Session Title', sessionId: 'abc' },
      {
        type: 'user',
        message: { role: 'user', content: 'hello' },
        uuid: 'u1',
      },
    ]);

    const reader = new JsonlReader(tmpDir);
    const { events, metadata } = reader.parseFile(filePath);

    expect(metadata).toEqual({ aiTitle: 'Test Session Title' });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('system'); // 'user' maps to 'system'
  });

  it('queue-operation: silently skipped — no event, no metadata', () => {
    const filePath = writeJsonl('queue-op-test.jsonl', [
      {
        type: 'queue-operation',
        operation: 'enqueue',
        content: 'do something',
      },
      {
        type: 'queue-operation',
        operation: 'dequeue',
      },
    ]);

    const reader = new JsonlReader(tmpDir);
    const { events, metadata } = reader.parseFile(filePath);

    expect(events).toHaveLength(0);
    expect(metadata).toEqual({});
  });

  it('last-prompt: silently skipped — no event, no metadata', () => {
    const filePath = writeJsonl('last-prompt-test.jsonl', [
      {
        type: 'last-prompt',
        lastPrompt: 'Do the thing',
        leafUuid: 'abc123',
      },
    ]);

    const reader = new JsonlReader(tmpDir);
    const { events, metadata } = reader.parseFile(filePath);

    expect(events).toHaveLength(0);
    expect(metadata).toEqual({});
  });

  it('attachment: silently skipped — no event, no metadata', () => {
    const filePath = writeJsonl('attachment-test.jsonl', [
      {
        type: 'attachment',
        attachment: { type: 'deferred_tools_delta', addedNames: ['Foo'] },
        uuid: 'u2',
      },
    ]);

    const reader = new JsonlReader(tmpDir);
    const { events, metadata } = reader.parseFile(filePath);

    expect(events).toHaveLength(0);
    expect(metadata).toEqual({});
  });

  it('unknown type: emits warning with truncated payload', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const longPayload = 'x'.repeat(600);
    const filePath = writeJsonl('unknown-test.jsonl', [
      { type: 'totally-unknown', data: longPayload },
    ]);

    const reader = new JsonlReader(tmpDir);
    reader.parseFile(filePath);

    expect(warnSpy).toHaveBeenCalledOnce();
    const [msg] = warnSpy.mock.calls[0];
    expect(msg).toContain('totally-unknown');
    // Payload truncated to ~500 chars
    const payloadPart = msg.split('— skipping: ')[1];
    expect(payloadPart.length).toBeLessThanOrEqual(500);

    warnSpy.mockRestore();
  });
});

describe('JsonlReader — importAll with new event types', () => {
  it('ai-title persisted as metadata on the session row', async () => {
    const sessionId = 'import-ai-title-01';
    writeJsonl(`${sessionId}.jsonl`, [
      { type: 'ai-title', aiTitle: 'My Imported Title', sessionId },
      { type: 'user', message: { role: 'user', content: 'hi' }, uuid: 'u1' },
    ]);

    const reader = new JsonlReader(tmpDir);
    await reader.importAll();

    const row = getSessionRow(sessionId);
    expect(row).toBeDefined();
    const meta = JSON.parse(row!.metadata ?? '{}') as Record<string, unknown>;
    expect(meta.aiTitle).toBe('My Imported Title');
  });

  it('queue-operation/last-prompt/attachment events not stored as session events', async () => {
    const sessionId = 'import-skip-types-01';
    writeJsonl(`${sessionId}.jsonl`, [
      { type: 'queue-operation', operation: 'enqueue', content: 'task' },
      { type: 'last-prompt', lastPrompt: 'do it', leafUuid: 'leaf1' },
      { type: 'attachment', attachment: { type: 'deferred_tools_delta' } },
      { type: 'user', message: { role: 'user', content: 'go' }, uuid: 'u1' },
    ]);

    const reader = new JsonlReader(tmpDir);
    await reader.importAll();

    const events = getEventRows(sessionId);
    // Only the 'user' event should be stored (as 'system')
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('system');
  });

  it('no unknown event type warnings for the four new types', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sessionId = 'import-no-warn-01';
    writeJsonl(`${sessionId}.jsonl`, [
      { type: 'ai-title', aiTitle: 'Title' },
      { type: 'queue-operation', operation: 'enqueue', content: 'x' },
      { type: 'last-prompt', lastPrompt: 'y' },
      { type: 'attachment', attachment: {} },
    ]);

    const reader = new JsonlReader(tmpDir);
    await reader.importAll();

    const unknownWarnings = warnSpy.mock.calls.filter(([msg]) =>
      String(msg).includes('unknown event type'),
    );
    expect(unknownWarnings).toHaveLength(0);

    warnSpy.mockRestore();
  });

  it('schema migration: metadata column exists in sessions table', () => {
    const tableInfo = db
      .prepare("PRAGMA table_info('sessions')")
      .all() as Array<{ name: string }>;
    const hasMetadata = tableInfo.some((col) => col.name === 'metadata');
    expect(hasMetadata).toBe(true);
  });
});
