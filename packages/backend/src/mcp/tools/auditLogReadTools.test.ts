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
