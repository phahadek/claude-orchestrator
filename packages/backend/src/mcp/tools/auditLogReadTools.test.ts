/**
 * `auditLog.query` — the Tier-B project-scoped audit-log read tool, gated
 * behind a durable `read:audit-log:<projectId>` grant.
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
import { registerAuditLogReadTools } from './auditLogReadTools';
import { insertSession, addGrantedCapability } from '../../db/queries';
import { recordEvent, AUDIT_LOG_ROW_CAP } from '../../audit/AuditLog';
import { auditLogReadCapability } from '../../session/orchestrator-config';

beforeEach(() => {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM audit_log').run();
});

async function connectedClient(sessionId: string) {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerAuditLogReadTools(server, { sessionId });
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

describe('auditLog.query', () => {
  it('returns project-scoped audit_log rows once the exact capability is granted', async () => {
    insertSession({
      session_id: 'requester-1',
      task_id: null,
      task_url: null,
      project_context_url: null,
      status: 'running',
      started_at: Date.now(),
    });
    recordEvent({
      event_type: 'gate_verify_dispatched',
      actor_type: 'session',
      actor_id: 'some-session',
      project_id: 'proj-1',
      task_id: 'notion:abc',
      payload: { note: 'dispatched' },
    });
    recordEvent({
      event_type: 'gate_verify_dispatched',
      actor_type: 'session',
      actor_id: 'other-session',
      project_id: 'proj-other',
      task_id: 'notion:xyz',
      payload: { note: 'different project' },
    });
    addGrantedCapability('requester-1', auditLogReadCapability('proj-1'));

    const { client, close } = await connectedClient('requester-1');
    try {
      const result = await client.callTool({
        name: 'auditLog.query',
        arguments: { projectId: 'proj-1' },
      });
      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ type: string; text?: string }>)[0]
        ?.text;
      const body = JSON.parse(text ?? '{}') as { entries: unknown[] };
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0]).toMatchObject({ projectId: 'proj-1' });
    } finally {
      await close();
    }
  });

  it('narrows by taskId / eventType / since / until filters', async () => {
    insertSession({
      session_id: 'requester-2',
      task_id: null,
      task_url: null,
      project_context_url: null,
      status: 'running',
      started_at: Date.now(),
    });
    recordEvent({
      event_type: 'task_body_updated',
      actor_type: 'session',
      actor_id: 'sess-a',
      project_id: 'proj-2',
      task_id: 'notion:task-1',
      payload: {},
    });
    recordEvent({
      event_type: 'task_deps_updated',
      actor_type: 'session',
      actor_id: 'sess-a',
      project_id: 'proj-2',
      task_id: 'notion:task-2',
      payload: {},
    });
    addGrantedCapability('requester-2', auditLogReadCapability('proj-2'));

    const { client, close } = await connectedClient('requester-2');
    try {
      const result = await client.callTool({
        name: 'auditLog.query',
        arguments: { projectId: 'proj-2', taskId: 'notion:task-1' },
      });
      const text = (result.content as Array<{ type: string; text?: string }>)[0]
        ?.text;
      const body = JSON.parse(text ?? '{}') as { entries: unknown[] };
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0]).toMatchObject({ taskId: 'notion:task-1' });
    } finally {
      await close();
    }
  });

  it('distinguishes zero matching rows, unattributed matching rows, and an unrecognized eventType', async () => {
    insertSession({
      session_id: 'requester-5',
      task_id: null,
      task_url: null,
      project_context_url: null,
      status: 'running',
      started_at: Date.now(),
    });
    // Recorded without a project_id — happened, but not attributed to any project.
    recordEvent({
      event_type: 'process_boot',
      actor_type: 'system',
      payload: {},
    });
    // A recognized event type, but only for a different project — never for proj-5.
    recordEvent({
      event_type: 'task_body_updated',
      actor_type: 'session',
      actor_id: 'other-session',
      project_id: 'proj-other',
      task_id: 'notion:elsewhere',
      payload: {},
    });
    addGrantedCapability('requester-5', auditLogReadCapability('proj-5'));

    const { client, close } = await connectedClient('requester-5');
    try {
      // Case 1: this did not happen — zero rows anywhere, recognized event type.
      const neverHappened = await client.callTool({
        name: 'auditLog.query',
        arguments: { projectId: 'proj-5', eventType: 'task_body_updated' },
      });
      const neverHappenedBody = JSON.parse(
        (neverHappened.content as Array<{ type: string; text?: string }>)[0]
          ?.text ?? '{}',
      ) as {
        entries: unknown[];
        unattributedCount: number;
        eventTypeRecognized: boolean | null;
      };
      expect(neverHappenedBody.entries).toHaveLength(0);
      expect(neverHappenedBody.unattributedCount).toBe(0);
      expect(neverHappenedBody.eventTypeRecognized).toBe(true);

      // Case 2: happened, but unattributed — entries empty, unattributedCount > 0.
      const unattributed = await client.callTool({
        name: 'auditLog.query',
        arguments: { projectId: 'proj-5', eventType: 'process_boot' },
      });
      const unattributedBody = JSON.parse(
        (unattributed.content as Array<{ type: string; text?: string }>)[0]
          ?.text ?? '{}',
      ) as { entries: unknown[]; unattributedCount: number };
      expect(unattributedBody.entries).toHaveLength(0);
      expect(unattributedBody.unattributedCount).toBe(1);

      // Case 3: the event name itself is unrecognized — matches no row anywhere.
      const unrecognized = await client.callTool({
        name: 'auditLog.query',
        arguments: { projectId: 'proj-5', eventType: 'totally_made_up_event' },
      });
      const unrecognizedBody = JSON.parse(
        (unrecognized.content as Array<{ type: string; text?: string }>)[0]
          ?.text ?? '{}',
      ) as { eventTypeRecognized: boolean | null };
      expect(unrecognizedBody.eventTypeRecognized).toBe(false);
    } finally {
      await close();
    }
  });

  it('returns a tool-level error when the capability is not granted', async () => {
    insertSession({
      session_id: 'requester-3',
      task_id: null,
      task_url: null,
      project_context_url: null,
      status: 'running',
      started_at: Date.now(),
    });

    const { client, close } = await connectedClient('requester-3');
    try {
      const result = await client.callTool({
        name: 'auditLog.query',
        arguments: { projectId: 'proj-3' },
      });
      expect(result.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it('caps entries at AUDIT_LOG_ROW_CAP and reports matchedCount so truncation is detectable', async () => {
    insertSession({
      session_id: 'requester-6',
      task_id: null,
      task_url: null,
      project_context_url: null,
      status: 'running',
      started_at: Date.now(),
    });
    const totalRows = AUDIT_LOG_ROW_CAP + 50;
    for (let i = 0; i < totalRows; i++) {
      recordEvent({
        event_type: 'task_body_updated',
        actor_type: 'session',
        actor_id: 'sess-a',
        project_id: 'proj-6',
        task_id: `notion:task-${i}`,
        payload: { i },
      });
    }
    addGrantedCapability('requester-6', auditLogReadCapability('proj-6'));

    const { client, close } = await connectedClient('requester-6');
    try {
      const result = await client.callTool({
        name: 'auditLog.query',
        arguments: { projectId: 'proj-6' },
      });
      const text = (result.content as Array<{ type: string; text?: string }>)[0]
        ?.text;
      const body = JSON.parse(text ?? '{}') as {
        entries: Array<{ payload: { i: number } }>;
        matchedCount: number;
      };
      expect(body.entries).toHaveLength(AUDIT_LOG_ROW_CAP);
      expect(body.matchedCount).toBe(totalRows);
      // Most recent rows, in ascending order — the last row inserted is last in the slice.
      expect(body.entries[body.entries.length - 1].payload.i).toBe(
        totalRows - 1,
      );
      expect(body.entries[0].payload.i).toBe(totalRows - AUDIT_LOG_ROW_CAP);
    } finally {
      await close();
    }
  });

  describe('pattern / groupBy', () => {
    async function setup(sessionId: string, projectId: string) {
      insertSession({
        session_id: sessionId,
        task_id: null,
        task_url: null,
        project_context_url: null,
        status: 'running',
        started_at: Date.now(),
      });
      addGrantedCapability(sessionId, auditLogReadCapability(projectId));
      return connectedClient(sessionId);
    }
    const parse = (result: unknown) =>
      JSON.parse(
        (result as { content: Array<{ text?: string }> }).content[0]?.text ??
          '{}',
      ) as Record<string, any>;

    function seed(projectId: string) {
      for (const [type, marker] of [
        ['type_a', 'needle-1'],
        ['type_a', 'hay'],
        ['type_b', 'needle-2'],
      ]) {
        recordEvent({
          event_type: type,
          actor_type: 'system',
          project_id: projectId,
          payload: { marker },
        });
      }
    }

    it('filters by payload pattern with a since bound; matchedCount agrees', async () => {
      seed('proj-p1');
      const { client, close } = await setup('req-p1', 'proj-p1');
      try {
        const body = parse(
          await client.callTool({
            name: 'auditLog.query',
            arguments: { projectId: 'proj-p1', pattern: 'needle', since: 0 },
          }),
        );
        expect(body.entries).toHaveLength(2);
        expect(body.matchedCount).toBe(2);
      } finally {
        await close();
      }
    });

    it('rejects pattern without since or until', async () => {
      const { client, close } = await setup('req-p2', 'proj-p2');
      try {
        const result = await client.callTool({
          name: 'auditLog.query',
          arguments: { projectId: 'proj-p2', pattern: 'needle' },
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toMatch(/since.*until/);
      } finally {
        await close();
      }
    });

    it('groupBy eventType returns uncapped per-type counts', async () => {
      seed('proj-p3');
      for (let i = 0; i < AUDIT_LOG_ROW_CAP + 5; i++) {
        recordEvent({
          event_type: 'type_c',
          actor_type: 'system',
          project_id: 'proj-p3',
          payload: {},
        });
      }
      const { client, close } = await setup('req-p3', 'proj-p3');
      try {
        const body = parse(
          await client.callTool({
            name: 'auditLog.query',
            arguments: { projectId: 'proj-p3', groupBy: 'eventType' },
          }),
        );
        const byType = Object.fromEntries(
          (body.groups as Array<Record<string, any>>).map((g) => [
            g.eventType,
            g,
          ]),
        );
        expect(Object.keys(byType).sort()).toEqual([
          'type_a',
          'type_b',
          'type_c',
        ]);
        expect(byType.type_a.count).toBe(2);
        expect(byType.type_c.count).toBe(AUDIT_LOG_ROW_CAP + 5);
        expect(byType.type_c.firstTs).toBeLessThanOrEqual(byType.type_c.lastTs);
        expect(body.matchedCount).toBe(AUDIT_LOG_ROW_CAP + 8);
      } finally {
        await close();
      }
    });

    it('default call without pattern/groupBy still returns rows', async () => {
      seed('proj-p4');
      const { client, close } = await setup('req-p4', 'proj-p4');
      try {
        const body = parse(
          await client.callTool({
            name: 'auditLog.query',
            arguments: { projectId: 'proj-p4' },
          }),
        );
        expect(body.entries).toHaveLength(3);
        expect(body.matchedCount).toBe(3);
        expect(body.groups).toBeUndefined();
      } finally {
        await close();
      }
    });

    it('refuses pattern and groupBy queries without the grant', async () => {
      insertSession({
        session_id: 'req-p5',
        task_id: null,
        task_url: null,
        project_context_url: null,
        status: 'running',
        started_at: Date.now(),
      });
      const { client, close } = await connectedClient('req-p5');
      try {
        const a = await client.callTool({
          name: 'auditLog.query',
          arguments: { projectId: 'proj-p5', pattern: 'x', since: 0 },
        });
        const b = await client.callTool({
          name: 'auditLog.query',
          arguments: { projectId: 'proj-p5', groupBy: 'eventType' },
        });
        expect(a.isError).toBe(true);
        expect(b.isError).toBe(true);
        expect(JSON.stringify(a.content)).toMatch(/capability not granted/);
      } finally {
        await close();
      }
    });
  });

  it('rejects a limit above the row cap rather than silently clamping it', async () => {
    insertSession({
      session_id: 'requester-7',
      task_id: null,
      task_url: null,
      project_context_url: null,
      status: 'running',
      started_at: Date.now(),
    });
    addGrantedCapability('requester-7', auditLogReadCapability('proj-7'));

    const { client, close } = await connectedClient('requester-7');
    try {
      const result = await client.callTool({
        name: 'auditLog.query',
        arguments: { projectId: 'proj-7', limit: AUDIT_LOG_ROW_CAP + 1 },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text?: string }>)[0]
        ?.text;
      expect(text).toMatch(/too big|invalid/i);
    } finally {
      await close();
    }
  });

  it('a grant for one project id does not authorize querying a different project', async () => {
    insertSession({
      session_id: 'requester-4',
      task_id: null,
      task_url: null,
      project_context_url: null,
      status: 'running',
      started_at: Date.now(),
    });
    addGrantedCapability('requester-4', auditLogReadCapability('proj-4'));

    const { client, close } = await connectedClient('requester-4');
    try {
      const result = await client.callTool({
        name: 'auditLog.query',
        arguments: { projectId: 'proj-other' },
      });
      expect(result.isError).toBe(true);
    } finally {
      await close();
    }
  });
});
