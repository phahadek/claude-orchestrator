import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/db', async () => {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      event_type TEXT NOT NULL, payload TEXT NOT NULL, timestamp INTEGER NOT NULL
    );
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
      event_type TEXT NOT NULL, actor_type TEXT NOT NULL, actor_id TEXT,
      project_id TEXT, task_id TEXT, payload TEXT NOT NULL DEFAULT '{}'
    );
  `);
  return { db };
});
vi.mock('../../db/queries', () => ({}));
vi.mock('../../config/settings', () => ({ typedGetSetting: () => 120 }));
vi.mock('../../audit/AuditLog', () => ({ recordEvent: vi.fn() }));
vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { db } from '../../db/db';
import { deriveNoWakeStreak } from '../turnEndWakeCheck';

function audit(ts: number, type: string, payload = '{}') {
  db.prepare(
    `INSERT INTO audit_log (ts, event_type, actor_type, actor_id, payload)
     VALUES (?, ?, 'system', 's', ?)`,
  ).run(ts, type, payload);
}
function sessionEvent(ts: number, type: string, payload: object) {
  db.prepare(
    `INSERT INTO session_events (session_id, event_type, payload, timestamp)
     VALUES ('s', ?, ?, ?)`,
  ).run(type, JSON.stringify(payload), ts);
}

beforeEach(() => {
  db.exec('DELETE FROM session_events; DELETE FROM audit_log;');
});

describe('deriveNoWakeStreak (real schema)', () => {
  it('is 0 with no rows, 1 after a directive, 3 once surfaced', () => {
    expect(deriveNoWakeStreak('s')).toBe(0);
    audit(100, 'turn_end_no_wake');
    expect(deriveNoWakeStreak('s')).toBe(1);
    audit(
      200,
      'task_orphan_surfaced',
      '{"reason":"turn_end_no_wake_repeated"}',
    );
    expect(deriveNoWakeStreak('s')).toBe(3);
  });

  it('a tool_use in an assistant message after surfacing resets the streak', () => {
    audit(100, 'turn_end_no_wake');
    audit(
      200,
      'task_orphan_surfaced',
      '{"reason":"turn_end_no_wake_repeated"}',
    );
    sessionEvent(300, 'text', {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', id: 'x' }] },
    });
    expect(deriveNoWakeStreak('s')).toBe(0);
  });

  it('a flat system tool_use event also resets; user text mentioning it does not', () => {
    audit(100, 'turn_end_no_wake');
    sessionEvent(150, 'user_message', { text: 'a "type":"tool_use" mention' });
    expect(deriveNoWakeStreak('s')).toBe(1);
    sessionEvent(160, 'system', { type: 'tool_use', name: 'Read' });
    expect(deriveNoWakeStreak('s')).toBe(0);
  });
});
