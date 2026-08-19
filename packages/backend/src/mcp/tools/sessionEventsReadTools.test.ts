/**
 * `sessionEvents.query` — the Tier-B project-scoped, aggregate-first
 * session_events read tool, gated behind a durable
 * `read:session-events:<projectId>` grant.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerSessionEventsReadTools } from './sessionEventsReadTools';
import {
  insertSession,
  insertEvent,
  addGrantedCapability,
} from '../../db/queries';
import { sessionEventsReadCapability } from '../../session/orchestrator-config';

beforeEach(() => {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM session_events').run();
});

async function connectedClient(sessionId: string) {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerSessionEventsReadTools(server, { sessionId });
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function insertProjectSession(sessionId: string, projectId: string): void {
  insertSession({
    session_id: sessionId,
    task_id: null,
    task_url: null,
    project_context_url: null,
    project_id: projectId,
    status: 'running',
    started_at: Date.now(),
  });
}

describe('sessionEvents.query', () => {
  it('returns a tool-level error when the capability is not granted', async () => {
    insertSession({
      session_id: 'requester-1',
      task_id: null,
      task_url: null,
      project_context_url: null,
      status: 'running',
      started_at: Date.now(),
    });

    const { client, close } = await connectedClient('requester-1');
    try {
      const result = await client.callTool({
        name: 'sessionEvents.query',
        arguments: { projectId: 'proj-1' },
      });
      expect(result.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it('returns aggregate counts/timestamps grouped by session_id by default, across every session in the project', async () => {
    insertSession({
      session_id: 'requester-2',
      task_id: null,
      task_url: null,
      project_context_url: null,
      status: 'running',
      started_at: Date.now(),
    });
    insertProjectSession('worker-a', 'proj-2');
    insertProjectSession('worker-b', 'proj-2');
    insertProjectSession('worker-other-project', 'proj-other');

    insertEvent({
      session_id: 'worker-a',
      event_type: 'text',
      payload: JSON.stringify({
        text: 'session_marked_done_while_running at pr_merge_watcher',
      }),
      timestamp: 1000,
    });
    insertEvent({
      session_id: 'worker-a',
      event_type: 'system',
      payload: JSON.stringify({ text: 'unrelated' }),
      timestamp: 2000,
    });
    insertEvent({
      session_id: 'worker-b',
      event_type: 'text',
      payload: JSON.stringify({ text: 'unrelated' }),
      timestamp: 3000,
    });
    insertEvent({
      session_id: 'worker-other-project',
      event_type: 'text',
      payload: JSON.stringify({ text: 'session_marked_done_while_running' }),
      timestamp: 4000,
    });

    addGrantedCapability('requester-2', sessionEventsReadCapability('proj-2'));

    const { client, close } = await connectedClient('requester-2');
    try {
      const result = await client.callTool({
        name: 'sessionEvents.query',
        arguments: { projectId: 'proj-2' },
      });
      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ type: string; text?: string }>)[0]
        ?.text;
      const body = JSON.parse(text ?? '{}') as {
        sessions: Array<{
          session_id: string;
          count: number;
          first_timestamp: number;
          last_timestamp: number;
        }>;
      };
      // No raw payload bodies in the default response.
      expect(text).not.toContain('session_marked_done_while_running');
      const bySession = new Map(body.sessions.map((s) => [s.session_id, s]));
      expect(bySession.get('worker-a')).toMatchObject({
        count: 2,
        first_timestamp: 1000,
        last_timestamp: 2000,
      });
      expect(bySession.get('worker-b')).toMatchObject({ count: 1 });
      // proj-other's session never appears — this is project-scoped.
      expect(bySession.has('worker-other-project')).toBe(false);
    } finally {
      await close();
    }
  });

  it('narrows by a payload substring pattern', async () => {
    insertSession({
      session_id: 'requester-3',
      task_id: null,
      task_url: null,
      project_context_url: null,
      status: 'running',
      started_at: Date.now(),
    });
    insertProjectSession('worker-c', 'proj-3');

    insertEvent({
      session_id: 'worker-c',
      event_type: 'text',
      payload: JSON.stringify({ text: 'session_marked_done_while_running' }),
      timestamp: 1000,
    });
    insertEvent({
      session_id: 'worker-c',
      event_type: 'text',
      payload: JSON.stringify({ text: 'nothing interesting' }),
      timestamp: 2000,
    });

    addGrantedCapability('requester-3', sessionEventsReadCapability('proj-3'));

    const { client, close } = await connectedClient('requester-3');
    try {
      const result = await client.callTool({
        name: 'sessionEvents.query',
        arguments: {
          projectId: 'proj-3',
          pattern: 'session_marked_done_while_running',
          // pattern alone can never be served from an index (leading-
          // wildcard LIKE) — see UnboundedPatternQueryError — so it must be
          // paired with a since/until bound.
          since: 0,
        },
      });
      const text = (result.content as Array<{ type: string; text?: string }>)[0]
        ?.text;
      const body = JSON.parse(text ?? '{}') as {
        sessions: Array<{ session_id: string; count: number }>;
      };
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0]).toMatchObject({
        session_id: 'worker-c',
        count: 1,
      });
    } finally {
      await close();
    }
  });

  it('returns a tool-level error for a pattern filter with no since/until bound', async () => {
    insertSession({
      session_id: 'requester-3b',
      task_id: null,
      task_url: null,
      project_context_url: null,
      status: 'running',
      started_at: Date.now(),
    });
    insertProjectSession('worker-c2', 'proj-3b');
    addGrantedCapability(
      'requester-3b',
      sessionEventsReadCapability('proj-3b'),
    );

    const { client, close } = await connectedClient('requester-3b');
    try {
      const result = await client.callTool({
        name: 'sessionEvents.query',
        arguments: { projectId: 'proj-3b', pattern: 'anything' },
      });
      expect(result.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it('filters a [since, until] window against timestamp as epoch-ms integers — an ISO-string comparison would miss the boundary rows', async () => {
    insertSession({
      session_id: 'requester-4',
      task_id: null,
      task_url: null,
      project_context_url: null,
      status: 'running',
      started_at: Date.now(),
    });
    insertProjectSession('worker-d', 'proj-4');

    // Fixture boundary: since/until as epoch ms around 2026-08-01T00:00:00Z
    // (1785888000000) — an ISO-string comparison ('2026-08-01T00:00:00.000Z')
    // against an INTEGER column matches zero rows (SQLite string-vs-integer
    // comparison never equates), so this would report 0 events at every
    // boundary instead of the two that fall inside the window.
    const windowStart = 1785888000000;
    const windowEnd = 1785888000000 + 5000;
    insertEvent({
      session_id: 'worker-d',
      event_type: 'text',
      payload: JSON.stringify({ text: 'before window' }),
      timestamp: windowStart - 1,
    });
    insertEvent({
      session_id: 'worker-d',
      event_type: 'text',
      payload: JSON.stringify({ text: 'at window start' }),
      timestamp: windowStart,
    });
    insertEvent({
      session_id: 'worker-d',
      event_type: 'text',
      payload: JSON.stringify({ text: 'at window end' }),
      timestamp: windowEnd,
    });
    insertEvent({
      session_id: 'worker-d',
      event_type: 'text',
      payload: JSON.stringify({ text: 'after window' }),
      timestamp: windowEnd + 1,
    });

    addGrantedCapability('requester-4', sessionEventsReadCapability('proj-4'));

    const { client, close } = await connectedClient('requester-4');
    try {
      const result = await client.callTool({
        name: 'sessionEvents.query',
        arguments: {
          projectId: 'proj-4',
          since: windowStart,
          until: windowEnd,
        },
      });
      const text = (result.content as Array<{ type: string; text?: string }>)[0]
        ?.text;
      const body = JSON.parse(text ?? '{}') as {
        sessions: Array<{ session_id: string; count: number }>;
      };
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0]).toMatchObject({
        session_id: 'worker-d',
        count: 2,
      });
    } finally {
      await close();
    }
  });

  it('returns raw payload bodies, capped, only under the explicit includePayloads opt-in', async () => {
    insertSession({
      session_id: 'requester-5',
      task_id: null,
      task_url: null,
      project_context_url: null,
      status: 'running',
      started_at: Date.now(),
    });
    insertProjectSession('worker-e', 'proj-5');

    for (let i = 0; i < 5; i++) {
      insertEvent({
        session_id: 'worker-e',
        event_type: 'text',
        payload: JSON.stringify({ text: `event ${i}` }),
        timestamp: 1000 + i,
      });
    }

    addGrantedCapability('requester-5', sessionEventsReadCapability('proj-5'));

    const { client, close } = await connectedClient('requester-5');
    try {
      const capped = await client.callTool({
        name: 'sessionEvents.query',
        arguments: { projectId: 'proj-5', includePayloads: true, limit: 2 },
      });
      const cappedText = (
        capped.content as Array<{ type: string; text?: string }>
      )[0]?.text;
      const cappedBody = JSON.parse(cappedText ?? '{}') as {
        rows: Array<{ payload: string }>;
      };
      expect(cappedBody.rows).toHaveLength(2);
      expect(cappedBody.rows[0].payload).toContain('event');
    } finally {
      await close();
    }
  });

  it('a grant for one project id does not authorize querying a different project', async () => {
    insertSession({
      session_id: 'requester-6',
      task_id: null,
      task_url: null,
      project_context_url: null,
      status: 'running',
      started_at: Date.now(),
    });
    addGrantedCapability('requester-6', sessionEventsReadCapability('proj-6'));

    const { client, close } = await connectedClient('requester-6');
    try {
      const result = await client.callTool({
        name: 'sessionEvents.query',
        arguments: { projectId: 'proj-other' },
      });
      expect(result.isError).toBe(true);
    } finally {
      await close();
    }
  });
});
