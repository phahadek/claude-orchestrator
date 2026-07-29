import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import http from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import {
  createOrchestratorMcpRouter,
  buildOrchestratorMcpServerEntry,
  buildMcpServer,
} from './orchestratorMcpServer';
import {
  mintStageCredential,
  _resetStageCredentialsForTesting,
} from '../auth/SessionStageAuth';
import { SessionManager } from '../session/SessionManager';
import { insertSession } from '../db/queries';
import { PLANNING_INTENT_KINDS } from '../planning/planningIntentKinds';
import { createUnit } from '../architecture/ArchUnitStore';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createOrchestratorMcpRouter(new SessionManager()));
  return app;
}

describe('orchestratorMcpServer — auth gate', () => {
  beforeEach(() => {
    _resetStageCredentialsForTesting();
  });

  it('rejects a request with no credential', async () => {
    const res = await supertest(buildApp())
      .post('/api/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(res.status).toBe(401);
  });

  it('rejects a request with a wrong credential', async () => {
    const res = await supertest(buildApp())
      .post('/api/mcp')
      .set('Authorization', 'Bearer not-a-real-token')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(res.status).toBe(401);
  });

  it('GET and DELETE are not allowed (stateless transport)', async () => {
    const token = mintStageCredential('session-mcp-1');
    const app = buildApp();
    const getRes = await supertest(app)
      .get('/api/mcp')
      .set('Authorization', `Bearer ${token}`);
    expect(getRes.status).toBe(405);
    const delRes = await supertest(app)
      .delete('/api/mcp')
      .set('Authorization', `Bearer ${token}`);
    expect(delRes.status).toBe(405);
  });
});

describe('orchestratorMcpServer — end-to-end MCP handshake', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    _resetStageCredentialsForTesting();
    const app = buildApp();
    server = http.createServer(app);
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

  it('connects with a valid session credential and lists the health tool', async () => {
    const token = mintStageCredential('session-mcp-2');
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/api/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
    );
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.some((t) => t.name === 'health')).toBe(true);
    await client.close();
  });

  it('rejects connection with a wrong credential end to end', async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/api/mcp`),
      { requestInit: { headers: { Authorization: 'Bearer wrong-token' } } },
    );
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await expect(client.connect(transport)).rejects.toThrow();
  });
});

async function toolNamesFor(sessionId: string): Promise<string[]> {
  const server = buildMcpServer(sessionId, new SessionManager());
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools.map((t) => t.name).sort();
}

describe('buildMcpServer — tool surface per session type', () => {
  it('a groom session exposes exactly health plus PLANNING_INTENT_KINDS.groom', async () => {
    insertSession({
      session_id: 'mcp-groom-1',
      task_id: null,
      task_url: null,
      project_context_url: null,
      project_id: 'proj-1',
      status: 'running',
      started_at: Date.now(),
      session_type: 'groom',
    });
    const names = await toolNamesFor('mcp-groom-1');
    expect(names).toEqual(
      [
        'health',
        ...PLANNING_INTENT_KINDS.groom,
        'groom.precheck',
        'architecture.getUnit',
        'architecture.queryUnits',
      ].sort(),
    );
  });

  it('a design session exposes decision.pickOne and task.updateBody, not journal.setState', async () => {
    insertSession({
      session_id: 'mcp-design-1',
      task_id: null,
      task_url: null,
      project_context_url: null,
      project_id: 'proj-1',
      status: 'running',
      started_at: Date.now(),
      session_type: 'design',
    });
    const names = await toolNamesFor('mcp-design-1');
    expect(names).toEqual(
      [
        'health',
        ...PLANNING_INTENT_KINDS.design,
        'completeness.disposition',
        'completeness.traceCoverage',
        'architecture.getUnit',
        'architecture.queryUnits',
      ].sort(),
    );
    expect(names).toContain('decision.pickOne');
    expect(names).toContain('task.updateBody');
    expect(names).not.toContain('journal.setState');
  });

  it('an ops session exposes session.requestCapability and gate.verify', async () => {
    insertSession({
      session_id: 'mcp-ops-1',
      task_id: null,
      task_url: null,
      project_context_url: null,
      project_id: 'proj-1',
      status: 'running',
      started_at: Date.now(),
      session_type: 'ops',
    });
    const names = await toolNamesFor('mcp-ops-1');
    expect(names).toContain('session.requestCapability');
    expect(names).toContain('gate.verify');
    expect(names).toContain('architecture.getUnit');
    expect(names).toContain('architecture.queryUnits');
    expect(names).not.toContain('review.disposition');
    expect(names).not.toContain('flaky.confirm');
  });

  it('a standard session still exposes review.disposition and flaky.confirm, not the architecture read tools', async () => {
    insertSession({
      session_id: 'mcp-standard-1',
      task_id: null,
      task_url: null,
      project_context_url: null,
      project_id: 'proj-1',
      status: 'running',
      started_at: Date.now(),
      session_type: 'standard',
    });
    const names = await toolNamesFor('mcp-standard-1');
    expect(names).toContain('review.disposition');
    expect(names).toContain('flaky.confirm');
    expect(names).not.toContain('architecture.getUnit');
    expect(names).not.toContain('architecture.queryUnits');
    expect(names).not.toContain('gate.verify');
  });
});

describe('architecture.getUnit / architecture.queryUnits', () => {
  it('a groom session can fetch a unit body and query by topic', async () => {
    insertSession({
      session_id: 'mcp-groom-arch-1',
      task_id: null,
      task_url: null,
      project_context_url: null,
      project_id: 'proj-1',
      status: 'running',
      started_at: Date.now(),
      session_type: 'groom',
    });
    const unit = createUnit({
      title: 'Test Invariant',
      kind: 'invariant',
      topic: 'system-architecture',
      regions: ['packages/backend'],
      body: 'The full body content of this architecture unit.',
      at: new Date(0).toISOString(),
    });

    const server = buildMcpServer('mcp-groom-arch-1', new SessionManager());
    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const getResult = await client.callTool({
      name: 'architecture.getUnit',
      arguments: { id: unit.id },
    });
    const getContent = (
      getResult.content as { type: string; text: string }[]
    )[0];
    expect(JSON.parse(getContent.text)).toMatchObject({
      id: unit.id,
      body: 'The full body content of this architecture unit.',
    });

    const queryResult = await client.callTool({
      name: 'architecture.queryUnits',
      arguments: { topic: 'system-architecture' },
    });
    const queryContent = (
      queryResult.content as { type: string; text: string }[]
    )[0];
    const queried = JSON.parse(queryContent.text) as { id: string }[];
    expect(queried.some((u) => u.id === unit.id)).toBe(true);

    await client.close();
    await server.close();
  });
});

describe('buildOrchestratorMcpServerEntry', () => {
  it('builds an http-type entry with the bearer token in headers', () => {
    const entry = buildOrchestratorMcpServerEntry(3000, 'my-token');
    expect(entry).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:3000/api/mcp',
      headers: { Authorization: 'Bearer my-token' },
    });
  });
});
