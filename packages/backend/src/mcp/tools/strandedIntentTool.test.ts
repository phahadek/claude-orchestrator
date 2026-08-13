/**
 * intent.dispositionStranded — an ops session's authenticated-MCP verb for
 * clearing a staged intent left behind by a *different* session that has
 * since terminated. Opposite authorization shape from intent.withdraw
 * (own-session-only): authorized because the owning session is terminal,
 * never because it matches the caller.
 *
 * AC covered here: dispositions an intent whose owning session is terminal
 * and is not the caller; refuses one whose owning session is still live;
 * rejects an unauthenticated call and one whose bearer doesn't match this
 * session's own.
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

import { db } from '../../db/db';
import { createOrchestratorMcpRouter } from '../orchestratorMcpServer';
import {
  mintStageCredential,
  _resetStageCredentialsForTesting,
} from '../../auth/SessionStageAuth';
import { SessionManager } from '../../session/SessionManager';
import {
  insertSession,
  updateSessionStatus,
  getStagedIntent,
} from '../../db/queries';
import { stageIntent } from '../../routes/stagedIntents';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createOrchestratorMcpRouter(new SessionManager()));
  return app;
}

function seedSession(
  sessionId: string,
  status: 'running' | 'done' = 'running',
) {
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
  if (status !== 'running') updateSessionStatus(sessionId, status);
}

function seedStrandedIntent(dead = 'dead-sess', live = 'ops-sess') {
  seedSession(dead, 'done');
  seedSession(live, 'running');
  return stageIntent(
    'task.setProperties',
    { taskId: 'task-1', patch: { priority: 'High' } },
    'proj-1',
    null,
    dead,
  );
}

let server: http.Server;
let baseUrl: string;

beforeEach(async () => {
  _resetStageCredentialsForTesting();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
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
    name: 'intent.dispositionStranded',
    arguments: args as Record<string, unknown>,
  });
  await client.close();
  return result;
}

describe('intent.dispositionStranded MCP tool', () => {
  it('dispositions an intent whose owning session is terminal and is not the caller', async () => {
    const intent = seedStrandedIntent();
    const token = mintStageCredential('ops-sess');

    const result = await callAsClient(token, {
      intentId: intent.id,
      reason: 'owning session died mid-turn, clearing the wedged intent',
    });

    expect(result.isError).toBeFalsy();
    expect(getStagedIntent(intent.id)?.state).toBe('superseded');
  });

  it('refuses an intent whose owning session is still live', async () => {
    seedSession('live-sess', 'running');
    seedSession('ops-sess', 'running');
    const intent = stageIntent(
      'task.setProperties',
      { taskId: 'task-1', patch: { priority: 'High' } },
      'proj-1',
      null,
      'live-sess',
    );
    const token = mintStageCredential('ops-sess');

    const result = await callAsClient(token, {
      intentId: intent.id,
      reason: 'not actually stranded',
    });

    expect(result.isError).toBe(true);
    expect(getStagedIntent(intent.id)?.state).toBe('staged');
  });

  it('rejects an unauthenticated call', async () => {
    const intent = seedStrandedIntent();
    const app = buildApp();

    const res = await supertest(app)
      .post('/api/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'intent.dispositionStranded',
          arguments: { intentId: intent.id, reason: 'reason' },
        },
      });

    expect(res.status).toBe(401);
    expect(getStagedIntent(intent.id)?.state).toBe('staged');
  });

  it("rejects a call whose bearer doesn't match this session's own", async () => {
    const intent = seedStrandedIntent();
    mintStageCredential('ops-sess');
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
          name: 'intent.dispositionStranded',
          arguments: { intentId: intent.id, reason: 'reason' },
        },
      });

    expect(res.status).toBe(401);
    expect(getStagedIntent(intent.id)?.state).toBe('staged');
  });
});
