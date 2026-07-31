/**
 * `session.getRecord` — the MCP-tool successor to the retired
 * `read-session-record.mjs` client: performs the identical grant check the
 * retired REST route performed and returns the same { session, events,
 * auditLog } shape.
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
import { registerSessionRecordReadTool } from './sessionRecordReadTool';
import { insertSession, insertEvent, addGrantedCapability } from '../../db/queries';
import { recordEvent } from '../../audit/AuditLog';
import { sessionRecordReadCapability } from '../../session/orchestrator-config';

beforeEach(() => {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM session_events').run();
  db.prepare('DELETE FROM audit_log').run();
});

async function connectedClient(sessionId: string) {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerSessionRecordReadTool(server, { sessionId });
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

describe('session.getRecord', () => {
  it("returns the target session's session_events and audit_log once the exact capability is granted", async () => {
    insertSession({
      session_id: 'requester-1',
      task_id: null,
      task_url: null,
      project_context_url: null,
      status: 'running',
      started_at: Date.now(),
    });
    insertSession({
      session_id: 'target-1',
      task_id: null,
      task_url: null,
      project_context_url: null,
      status: 'done',
      started_at: Date.now(),
    });
    insertEvent({
      session_id: 'target-1',
      event_type: 'assistant',
      payload: JSON.stringify({ type: 'assistant', text: 'hi' }),
      timestamp: Date.now(),
    });
    recordEvent({
      event_type: 'gate_verify_dispatched',
      actor_type: 'session',
      actor_id: 'target-1',
      project_id: 'proj-1',
      task_id: 'notion:abc',
      payload: { note: 'dispatched' },
    });
    addGrantedCapability('requester-1', sessionRecordReadCapability('target-1'));

    const { client, close } = await connectedClient('requester-1');
    try {
      const result = await client.callTool({
        name: 'session.getRecord',
        arguments: { targetSessionId: 'target-1' },
      });
      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ type: string; text?: string }>)[0]
        ?.text;
      const body = JSON.parse(text ?? '{}') as Record<string, unknown>;
      expect(body.events).toHaveLength(1);
      expect((body.auditLog as unknown[])[0]).toMatchObject({
        eventType: 'gate_verify_dispatched',
      });
    } finally {
      await close();
    }
  });

  it('returns a tool-level error when the capability is not granted', async () => {
    insertSession({
      session_id: 'requester-2',
      task_id: null,
      task_url: null,
      project_context_url: null,
      status: 'running',
      started_at: Date.now(),
    });
    insertSession({
      session_id: 'target-2',
      task_id: null,
      task_url: null,
      project_context_url: null,
      status: 'done',
      started_at: Date.now(),
    });

    const { client, close } = await connectedClient('requester-2');
    try {
      const result = await client.callTool({
        name: 'session.getRecord',
        arguments: { targetSessionId: 'target-2' },
      });
      expect(result.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it("a grant for one target session id does not authorize reading a different session", async () => {
    insertSession({
      session_id: 'requester-3',
      task_id: null,
      task_url: null,
      project_context_url: null,
      status: 'running',
      started_at: Date.now(),
    });
    insertSession({
      session_id: 'target-3',
      task_id: null,
      task_url: null,
      project_context_url: null,
      status: 'done',
      started_at: Date.now(),
    });
    insertSession({
      session_id: 'other-target',
      task_id: null,
      task_url: null,
      project_context_url: null,
      status: 'done',
      started_at: Date.now(),
    });
    addGrantedCapability('requester-3', sessionRecordReadCapability('target-3'));

    const { client, close } = await connectedClient('requester-3');
    try {
      const result = await client.callTool({
        name: 'session.getRecord',
        arguments: { targetSessionId: 'other-target' },
      });
      expect(result.isError).toBe(true);
    } finally {
      await close();
    }
  });
});
