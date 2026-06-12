/**
 * Verifies that sendInitialStateBurst scrubs secret patterns from session_event
 * payloads before sending them to a newly connected WebSocket client.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeEventRow } from '../../test/helpers/eventFixtures';
import type { Session } from '../db/types';
import type { ServerMessage } from '../ws/types';

vi.mock('../db/queries', () => ({
  getActiveSessions: vi.fn(),
  getEventsBySession: vi.fn(() => []),
  getDenialsBySession: vi.fn(() => []),
  getPRByNotionTaskId: vi.fn(() => undefined),
}));

vi.mock('../utils/eventFilters', () => ({
  isSystemOnlyUserEvent: vi.fn(() => false),
}));

import { sendInitialStateBurst } from '../ws/initialStateBurst';
import * as queries from '../db/queries';

function makeSession(id: string): Session {
  return {
    session_id: id,
    task_id: null,
    task_url: `https://notion.so/${id}`,
    project_context_url: null,
    project_id: 'proj-1',
    status: 'done',
    started_at: 1_000_000,
    ended_at: 2_000_000,
    pr_url: null,
    worktree_path: null,
    archived: 0,
    favorited: 0,
    session_type: 'standard',
    note: null,
    tags: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    model: null,
    task_name: `task-${id}`,
  };
}

describe('sendInitialStateBurst — secret scrubbing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('redacts sk-ant-* in session_event content during initial burst', () => {
    vi.mocked(queries.getActiveSessions).mockReturnValue([makeSession('s1')]);
    vi.mocked(queries.getEventsBySession).mockReturnValue([
      {
        id: 1,
        session_id: 's1',
        ...makeEventRow('tool_use').live,
        payload: JSON.stringify({
          name: 'Bash',
          input: { command: 'echo sk-ant-api03-supersecret12345' },
        }),
        timestamp: 1_000_000,
        message_id: null,
      },
    ]);

    const sent: ServerMessage[] = [];
    sendInitialStateBurst((msg) => sent.push(msg));

    const events = sent.filter((m) => m.type === 'session_event');
    expect(events).toHaveLength(1);
    const ev = events[0] as Extract<ServerMessage, { type: 'session_event' }>;
    expect(ev.content).not.toContain('sk-ant-api03-supersecret12345');
    expect(ev.content).toContain('[REDACTED]');
  });

  it('leaves non-secret payloads unchanged', () => {
    vi.mocked(queries.getActiveSessions).mockReturnValue([makeSession('s2')]);
    vi.mocked(queries.getEventsBySession).mockReturnValue([
      {
        id: 2,
        session_id: 's2',
        ...makeEventRow('text').live,
        payload: 'hello world',
        timestamp: 1_000_000,
        message_id: null,
      },
    ]);

    const sent: ServerMessage[] = [];
    sendInitialStateBurst((msg) => sent.push(msg));

    const events = sent.filter((m) => m.type === 'session_event');
    expect(events).toHaveLength(1);
    const ev = events[0] as Extract<ServerMessage, { type: 'session_event' }>;
    expect(ev.content).toBe('hello world');
  });
});
