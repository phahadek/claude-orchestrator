/**
 * gate.reclassify — the authenticated-MCP replacement for
 * gate-state-client.mjs's device-authed `reclassify` command. An ops
 * session's environment never carries ORCHESTRATOR_DEVICE_TOKEN (see
 * CliSessionRunner), so this verb is the only route it can actually reach.
 *
 * AC covered here: performs the same state change as gate-state-client.mjs
 * reclassify (real reclassifyGateItem write, verified via a real gate item
 * row); rejects an unauthenticated call and one whose bearer doesn't match
 * this session's own.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'http';
import supertest from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import { createOrchestratorMcpRouter } from '../orchestratorMcpServer';
import {
  mintStageCredential,
  _resetStageCredentialsForTesting,
} from '../../auth/SessionStageAuth';
import { SessionManager } from '../../session/SessionManager';
import { insertSession } from '../../db/queries';
import { insertItem } from '../../gate/gateStore';
import { getGateItem } from '../../gate/gateService';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createOrchestratorMcpRouter(new SessionManager()));
  return app;
}

function makeGateItem() {
  return insertItem({
    project: 'proj-1',
    milestone: 'M12',
    text: 'Verify the deploy script writes the new env var',
    classification: 'needs-triage',
    sources: [],
    updatedAt: new Date(0).toISOString(),
  });
}

function seedOpsSession(sessionId = 'ops-sess-1') {
  insertSession({
    session_id: sessionId,
    task_id: null,
    task_url: null,
    project_context_url: null,
    project_id: 'proj-1',
    status: 'running',
    started_at: Date.now(),
    session_type: 'ops',
  });
}

let server: http.Server;
let baseUrl: string;

beforeEach(async () => {
  _resetStageCredentialsForTesting();
  db.prepare('DELETE FROM gate_item_event').run();
  db.prepare('DELETE FROM gate_item_source').run();
  db.prepare('DELETE FROM gate_item').run();
  db.prepare('DELETE FROM sessions').run();
  server = http.createServer(buildApp());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected server to bind to a port');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function callAsClient(token: string, args: unknown) {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/api/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  );
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(transport);
  const result = await client.callTool({
    name: 'gate.reclassify',
    arguments: args as Record<string, unknown>,
  });
  await client.close();
  return result;
}

describe('gate.reclassify MCP tool', () => {
  it('performs the same state change as gate-state-client.mjs reclassify', async () => {
    seedOpsSession();
    const item = makeGateItem();
    const token = mintStageCredential('ops-sess-1');

    const result = await callAsClient(token, {
      gateItemId: item.id,
      classification: 'Read-Only',
    });

    expect(result.isError).toBeFalsy();
    expect(getGateItem(item.id)?.classification).toBe('Read-Only');
  });

  it('rejects an unauthenticated call', async () => {
    const item = makeGateItem();
    const app = buildApp();

    const res = await supertest(app)
      .post('/api/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'gate.reclassify',
          arguments: { gateItemId: item.id, classification: 'Read-Only' },
        },
      });

    expect(res.status).toBe(401);
    expect(getGateItem(item.id)?.classification).toBe('needs-triage');
  });

  it("rejects a call whose bearer doesn't match this session's own", async () => {
    seedOpsSession();
    const item = makeGateItem();
    mintStageCredential('ops-sess-1');
    const app = buildApp();

    const res = await supertest(app)
      .post('/api/mcp')
      .set('Authorization', 'Bearer not-the-real-token')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'gate.reclassify',
          arguments: { gateItemId: item.id, classification: 'Read-Only' },
        },
      });

    expect(res.status).toBe(401);
    expect(getGateItem(item.id)?.classification).toBe('needs-triage');
  });
});
