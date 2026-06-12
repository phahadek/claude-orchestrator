/**
 * Verifies that JsonlReader.parseFile redacts secret patterns from event content
 * before they are stored in SQLite.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});
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
