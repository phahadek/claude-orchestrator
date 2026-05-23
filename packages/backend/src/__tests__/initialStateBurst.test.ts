/**
 * Integration test: WS reconnect burst tags replayed session_status messages.
 *
 * Verifies that on a fresh WS connect, every session_status replayed from
 * SQLite carries `replay: true` — the flag the frontend uses to suppress
 * notification firing after a backend restart.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
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

function makeSession(id: string, status: Session['status'] = 'done'): Session {
  return {
    session_id: id,
    notion_task_id: null,
    notion_task_url: `https://notion.so/${id}`,
    project_context_url: null,
    project_id: 'proj-1',
    status,
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

describe('sendInitialStateBurst', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('tags every replayed session_status with replay: true for done sessions', () => {
    const sessions = ['a', 'b', 'c', 'd', 'e'].map((id) =>
      makeSession(id, 'done'),
    );
    vi.mocked(queries.getActiveSessions).mockReturnValue(sessions);

    const sent: ServerMessage[] = [];
    sendInitialStateBurst((msg) => sent.push(msg));

    const statusMessages = sent.filter((m) => m.type === 'session_status');
    expect(statusMessages).toHaveLength(5);
    for (const msg of statusMessages) {
      expect(msg).toMatchObject({
        type: 'session_status',
        status: 'done',
        replay: true,
      });
    }
  });

  it('also tags session_status for non-terminal sessions', () => {
    const sessions = [
      makeSession('a', 'running'),
      makeSession('b', 'needs_permission'),
      makeSession('c', 'starting'),
    ];
    vi.mocked(queries.getActiveSessions).mockReturnValue(sessions);

    const sent: ServerMessage[] = [];
    sendInitialStateBurst((msg) => sent.push(msg));

    const statusMessages = sent.filter(
      (m) => m.type === 'session_status',
    ) as Extract<ServerMessage, { type: 'session_status' }>[];
    expect(statusMessages.map((m) => m.replay)).toEqual([true, true, true]);
  });

  it('does not add replay:true to other message types in the burst', () => {
    vi.mocked(queries.getActiveSessions).mockReturnValue([
      makeSession('a', 'done'),
    ]);

    const sent: ServerMessage[] = [];
    sendInitialStateBurst((msg) => sent.push(msg));

    const started = sent.find((m) => m.type === 'session_started');
    expect(started).toBeDefined();
    expect((started as Record<string, unknown>).replay).toBeUndefined();
  });
});
