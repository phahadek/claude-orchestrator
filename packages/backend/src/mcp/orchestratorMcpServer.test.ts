import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import http from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  createOrchestratorMcpRouter,
  buildOrchestratorMcpServerEntry,
} from './orchestratorMcpServer';
import {
  mintStageCredential,
  _resetStageCredentialsForTesting,
} from '../auth/SessionStageAuth';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createOrchestratorMcpRouter());
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
