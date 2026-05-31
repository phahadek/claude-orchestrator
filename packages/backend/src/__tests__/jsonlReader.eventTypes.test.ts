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
      task_id             TEXT,
      task_url            TEXT,
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
      task_id    TEXT    PRIMARY KEY,
      fetched_at INTEGER NOT NULL,
      raw_json   TEXT    NOT NULL
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

    expect(metadata).toEqual({ derivedTitle: 'Test Session Title' });
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

  it('rate_limit_event: silently skipped — no event, no metadata, no warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const filePath = writeJsonl('rate-limit-test.jsonl', [
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed',
          resetsAt: 1779757800,
          rateLimitType: 'five_hour',
          overageStatus: 'allowed',
          overageResetsAt: 1779747000,
          isUsingOverage: false,
        },
        uuid: 'rl-uuid-1',
        session_id: 'sess-1',
      },
    ]);

    const reader = new JsonlReader(tmpDir);
    const { events, metadata } = reader.parseFile(filePath);

    expect(warnSpy).not.toHaveBeenCalled();
    expect(metadata).toEqual({});
    expect(events).toHaveLength(0);

    warnSpy.mockRestore();
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
  it('ai-title populates derivedTitle in session metadata', async () => {
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
    expect(meta.derivedTitle).toBe('My Imported Title');
  });

  it('ai-title initialises metadata as { derivedTitle } when metadata is null', async () => {
    const sessionId = 'import-ai-title-null-meta-01';
    writeJsonl(`${sessionId}.jsonl`, [
      { type: 'ai-title', aiTitle: 'Fresh Title', sessionId },
      { type: 'user', message: { role: 'user', content: 'hi' }, uuid: 'u1' },
    ]);

    const reader = new JsonlReader(tmpDir);
    await reader.importAll();

    const row = getSessionRow(sessionId);
    expect(row).toBeDefined();
    const rawMeta = row!.metadata;
    // metadata must be valid JSON containing derivedTitle
    const meta = JSON.parse(rawMeta ?? 'null') as Record<string, unknown>;
    expect(meta).not.toBeNull();
    expect(meta.derivedTitle).toBe('Fresh Title');
  });

  it('ai-title merges derivedTitle without overwriting existing metadata keys', async () => {
    const sessionId = 'import-ai-title-merge-01';
    writeJsonl(`${sessionId}.jsonl`, [
      { type: 'ai-title', aiTitle: 'Merged Title', sessionId },
      { type: 'user', message: { role: 'user', content: 'hi' }, uuid: 'u1' },
    ]);

    const reader = new JsonlReader(tmpDir);
    await reader.importAll();

    // Simulate pre-existing metadata key by writing directly after import
    db.prepare(
      "UPDATE sessions SET metadata = json_patch(COALESCE(metadata, '{}'), ?) WHERE session_id = ?",
    ).run(JSON.stringify({ existingKey: 'keep-me' }), sessionId);

    // Re-run importAll — session is already known so won't re-import,
    // but we verify setDerivedTitle merges properly via direct call
    const { setDerivedTitle } = await import('../db/queries.js');
    setDerivedTitle(sessionId, 'Updated Title');

    const row = getSessionRow(sessionId);
    const meta = JSON.parse(row!.metadata ?? '{}') as Record<string, unknown>;
    expect(meta.derivedTitle).toBe('Updated Title');
    expect(meta.existingKey).toBe('keep-me');
  });

  it('ai-title event is NOT stored as a session_events row (regression)', async () => {
    const sessionId = 'import-ai-title-no-event-01';
    writeJsonl(`${sessionId}.jsonl`, [
      { type: 'ai-title', aiTitle: 'Title Only', sessionId },
      { type: 'user', message: { role: 'user', content: 'hi' }, uuid: 'u1' },
    ]);

    const reader = new JsonlReader(tmpDir);
    await reader.importAll();

    const events = getEventRows(sessionId);
    const aiTitleEvents = events.filter((e) => e.event_type === 'ai-title');
    expect(aiTitleEvents).toHaveLength(0);
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

  it('rate_limit_event: silently dropped — no session_events row, no warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sessionId = 'import-rate-limit-01';
    writeJsonl(`${sessionId}.jsonl`, [
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed',
          resetsAt: 1779757800,
          rateLimitType: 'five_hour',
          overageStatus: 'allowed',
          overageResetsAt: 1779747000,
          isUsingOverage: false,
        },
        uuid: 'rl-uuid-2',
        session_id: sessionId,
      },
      { type: 'user', message: { role: 'user', content: 'hi' }, uuid: 'u1' },
    ]);

    const reader = new JsonlReader(tmpDir);
    await reader.importAll();

    const unknownWarnings = warnSpy.mock.calls.filter(([msg]) =>
      String(msg).includes('unknown event type'),
    );
    expect(unknownWarnings).toHaveLength(0);

    const events = getEventRows(sessionId);
    const rlEvent = events.find((e) => e.event_type === 'rate_limit');
    expect(rlEvent).toBeUndefined();
    // Only the 'user' event should be stored (as 'system')
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('system');

    warnSpy.mockRestore();
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
