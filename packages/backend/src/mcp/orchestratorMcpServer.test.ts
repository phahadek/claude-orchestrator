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

vi.mock('../projects/ProjectService', () => ({
  ProjectService: {
    getById: (id: string) =>
      id === 'proj-1'
        ? {
            id: 'proj-1',
            milestones: [{ id: 'ms-13', name: 'M13', canonicalShortId: 'M13' }],
          }
        : undefined,
  },
}));

// Every taskId referenced in the taskId-guard tests below is a fixture, not
// a real board task — stub the backend so a taskId that survives the guard
// resolves at stage time (see validateAndNormalizeTaskReferences) rather
// than failing for an unrelated reason.
vi.mock('../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn(() => ({
    type: 'notion',
    fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nok'),
    fetchTaskSummary: vi
      .fn()
      .mockResolvedValue({
        title: 'Some other task',
        type: '💻 Code',
        status: '🔲 Backlog',
      }),
  })),
}));

import {
  createOrchestratorMcpRouter,
  buildOrchestratorMcpServerEntry,
  buildMcpServer,
} from './orchestratorMcpServer';
import {
  mintStageCredential,
  revokeStageCredential,
  _resetStageCredentialsForTesting,
} from '../auth/SessionStageAuth';
import { SessionManager } from '../session/SessionManager';
import { insertSession, insertGateItem, getStagedIntent } from '../db/queries';
import { getTaskBackend } from '../tasks/TaskBackend';
import { PLANNING_INTENT_KINDS } from '../planning/planningIntentKinds';
import { createUnit } from '../architecture/ArchUnitStore';
import * as AuditLog from '../audit/AuditLog';
import {
  queryAuditLogByProject,
  getLatestEventByType,
} from '../audit/AuditLog';

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

  it('responds with Connection: close so the client cannot reuse a pooled socket', async () => {
    const token = mintStageCredential('session-mcp-conn-close');
    const res = await supertest(buildApp())
      .post('/api/mcp')
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(res.status).toBe(200);
    expect(res.headers['connection']).toBe('close');
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
        'task.getById',
        'pullRequest.getByTaskId',
        'gateSeed.getState',
        'session.getRecord',
        'auditLog.query',
        'sessionEvents.query',
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
        'task.getById',
        'pullRequest.getByTaskId',
        'gateSeed.getState',
        'session.getRecord',
        'auditLog.query',
        'sessionEvents.query',
      ].sort(),
    );
    expect(names).toContain('decision.pickOne');
    expect(names).toContain('task.updateBody');
    expect(names).not.toContain('journal.setState');
  });

  it('an ops session exposes exactly health plus PLANNING_INTENT_KINDS.ops (including gate.verify, a genuine staged-intent kind) plus its always-on reads', async () => {
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
    expect(PLANNING_INTENT_KINDS.ops).toContain('gate.verify');
    expect(names).toEqual(
      [
        'health',
        ...PLANNING_INTENT_KINDS.ops,
        'architecture.getUnit',
        'architecture.queryUnits',
        'task.getById',
        'pullRequest.getByTaskId',
        'gateSeed.getState',
        'session.getRecord',
        'auditLog.query',
        'sessionEvents.query',
      ].sort(),
    );
    expect(names).toContain('session.requestCapability');
    expect(names).toContain('gate.verify');
    expect(names).not.toContain('review.disposition');
    expect(names).not.toContain('flaky.confirm');
  });

  it('a standard session still exposes review.disposition and flaky.confirm, not the architecture read tools, but does get the Tier-A read tools', async () => {
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
    expect(names).not.toContain('task.getById');
    expect(names).not.toContain('gate.verify');
    expect(names).toContain('pullRequest.getByTaskId');
    expect(names).toContain('gateSeed.getState');
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

describe('taskId argument guard', () => {
  const BOUND_TASK_ID = 'notion:3b022f91-52f3-810e-846b-ded6111a6bb3';

  it('rejects a malformed taskId before it reaches the provider, naming the session bound task id', async () => {
    insertSession({
      session_id: 'mcp-taskid-guard-1',
      task_id: BOUND_TASK_ID,
      task_url: null,
      project_context_url: null,
      project_id: 'proj-1',
      status: 'running',
      started_at: Date.now(),
      session_type: 'groom',
    });

    const server = buildMcpServer('mcp-taskid-guard-1', new SessionManager());
    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    // One hex digit short of a valid 32-char Notion UUID — the exact
    // transcription slip this guard exists to catch.
    const result = await client.callTool({
      name: 'task.setStatus',
      arguments: {
        payload: {
          taskId: '3b022f9152f3810e846bded6111a6bb',
          status: 'Ready',
        },
      },
    });
    expect(result.isError).toBe(true);
    const content = (result.content as { type: string; text: string }[])[0];
    expect(content.text).toContain(BOUND_TASK_ID);

    await client.close();
    await server.close();
  });

  it('does not reject or rewrite a well-formed taskId for a task other than the session bound one', async () => {
    insertSession({
      session_id: 'mcp-taskid-guard-2',
      task_id: BOUND_TASK_ID,
      task_url: null,
      project_context_url: null,
      project_id: 'proj-1',
      status: 'running',
      started_at: Date.now(),
      session_type: 'groom',
    });

    const server = buildMcpServer('mcp-taskid-guard-2', new SessionManager());
    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    // task.getById is a read tool with no same-task-as-session restriction —
    // exercises the "not rejected/rewritten" side of the guard in isolation
    // from the separate, unrelated same-task write policy other tools apply.
    const otherTaskId = 'notion:4c133a02-63a4-921f-957c-efe7222b7cc4';
    const result = await client.callTool({
      name: 'task.getById',
      arguments: { taskId: otherTaskId },
    });
    expect(result.isError).not.toBe(true);
    expect(getTaskBackend).toHaveBeenCalled();
    const fetchTaskSummary = vi.mocked(getTaskBackend).mock.results[0]
      .value as { fetchTaskSummary: ReturnType<typeof vi.fn> };
    expect(fetchTaskSummary.fetchTaskSummary).toHaveBeenCalledWith(otherTaskId);

    await client.close();
    await server.close();
  });
});

describe('buildMcpServer — ctx.milestone attribution', () => {
  it("a gate-verify session's session.requestCapability persists the gate item's milestone", async () => {
    insertGateItem({
      id: 'gate-item-mcp-1',
      project: 'proj-1',
      milestone: 'M13',
      text: 'some gate item',
      classification: 'code',
      min_deployed_commit: null,
      state: 'open',
      current_disposition: null,
      latest_disposition: null,
      updated_at: new Date(0).toISOString(),
    });
    insertSession({
      session_id: 'mcp-gate-verify-1',
      task_id: 'gate-item:gate-item-mcp-1',
      task_url: null,
      project_context_url: null,
      project_id: 'proj-1',
      status: 'running',
      started_at: Date.now(),
      session_type: 'ops',
    });

    const server = buildMcpServer('mcp-gate-verify-1', new SessionManager());
    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.callTool({
      name: 'session.requestCapability',
      arguments: {
        payload: {
          capability: 'Bash(ls)',
          plan: 'list files to confirm the gate item is verifiable',
          evidence: 'the gate item requires inspecting repo contents',
        },
      },
    });
    const content = (result.content as { type: string; text: string }[])[0];
    const staged = JSON.parse(content.text) as { id: string };
    const row = getStagedIntent(staged.id);
    expect(row?.milestone).toBe('M13');

    await client.close();
    await server.close();
  });
});

describe('orchestratorMcpServer — MCP lifecycle instrumentation', () => {
  beforeEach(() => {
    _resetStageCredentialsForTesting();
  });

  it('records a connection-established event naming the session id, readable back with a non-null project_id', async () => {
    insertSession({
      session_id: 'mcp-lifecycle-1',
      task_id: null,
      task_url: null,
      project_context_url: null,
      project_id: 'proj-lifecycle-established',
      status: 'running',
      started_at: Date.now(),
      session_type: 'standard',
    });
    const token = mintStageCredential('mcp-lifecycle-1');
    const res = await supertest(buildApp())
      .post('/api/mcp')
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(res.status).toBe(200);

    const { entries } = queryAuditLogByProject('proj-lifecycle-established', {
      eventType: 'mcp_connection_established',
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].actorId).toBe('mcp-lifecycle-1');
    expect(entries[0].projectId).toBe('proj-lifecycle-established');
  });

  it('records a connection-closed teardown event naming the session id and a reason, with a non-null project_id', async () => {
    insertSession({
      session_id: 'mcp-lifecycle-2',
      task_id: null,
      task_url: null,
      project_context_url: null,
      project_id: 'proj-lifecycle-closed',
      status: 'running',
      started_at: Date.now(),
      session_type: 'standard',
    });
    const token = mintStageCredential('mcp-lifecycle-2');
    const res = await supertest(buildApp())
      .post('/api/mcp')
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(res.status).toBe(200);

    const { entries } = queryAuditLogByProject('proj-lifecycle-closed', {
      eventType: 'mcp_connection_closed',
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].actorId).toBe('mcp-lifecycle-2');
    expect(entries[0].projectId).toBe('proj-lifecycle-closed');
    expect((entries[0].payload as { reason: string }).reason).toBe('completed');
  });

  it('records events for a session resumed via --resume, not only its first spawn', async () => {
    insertSession({
      session_id: 'mcp-lifecycle-resume',
      task_id: null,
      task_url: null,
      project_context_url: null,
      project_id: 'proj-lifecycle-resume',
      status: 'running',
      started_at: Date.now(),
      session_type: 'standard',
    });
    // First spawn mints the credential and connects once.
    const token = mintStageCredential('mcp-lifecycle-resume');
    const app = buildApp();
    await supertest(app)
      .post('/api/mcp')
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

    // A --resume re-spawn re-mints (idempotently, same token — see
    // writeMcpConfig/mintStageCredential) and reconnects independently.
    const resumedToken = mintStageCredential('mcp-lifecycle-resume');
    expect(resumedToken).toBe(token);
    const resumedRes = await supertest(app)
      .post('/api/mcp')
      .set('Authorization', `Bearer ${resumedToken}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect(resumedRes.status).toBe(200);

    const { entries } = queryAuditLogByProject('proj-lifecycle-resume', {
      eventType: 'mcp_connection_established',
    });
    expect(entries).toHaveLength(2);
  });

  it('distinguishes an absent credential from a rejected/expired one', async () => {
    const absentRes = await supertest(buildApp())
      .post('/api/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(absentRes.status).toBe(401);
    const absentEvent = getLatestEventByType('mcp_stage_credential_rejected');
    expect(absentEvent).toBeDefined();
    expect(JSON.parse(absentEvent!.payload).reason).toBe('absent');
    expect(absentEvent!.project_id).toBeNull();
    expect(absentEvent!.actor_id).toBeNull();

    const unknownRes = await supertest(buildApp())
      .post('/api/mcp')
      .set('Authorization', 'Bearer never-minted-token')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(unknownRes.status).toBe(401);
    const unknownEvent = getLatestEventByType('mcp_stage_credential_rejected');
    expect(JSON.parse(unknownEvent!.payload).reason).toBe('unknown');
    expect(unknownEvent!.actor_id).toBeNull();
  });

  it('a revoked credential is rejected with an event attributing it back to the session, carrying a project_id', async () => {
    insertSession({
      session_id: 'mcp-lifecycle-revoked',
      task_id: null,
      task_url: null,
      project_context_url: null,
      project_id: 'proj-lifecycle-revoked',
      status: 'running',
      started_at: Date.now(),
      session_type: 'standard',
    });
    const token = mintStageCredential('mcp-lifecycle-revoked');
    revokeStageCredential('mcp-lifecycle-revoked', 'session_teardown');

    const res = await supertest(buildApp())
      .post('/api/mcp')
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(res.status).toBe(401);

    const { entries } = queryAuditLogByProject('proj-lifecycle-revoked', {
      eventType: 'mcp_stage_credential_rejected',
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].actorId).toBe('mcp-lifecycle-revoked');
    expect((entries[0].payload as { reason: string }).reason).toBe('revoked');

    // Teardown itself was also recorded, naming the session id and reason.
    const revokedEvent = getLatestEventByType('mcp_session_credential_revoked');
    expect(revokedEvent).toBeDefined();
    expect(revokedEvent!.actor_id).toBe('mcp-lifecycle-revoked');
    expect(revokedEvent!.project_id).toBe('proj-lifecycle-revoked');
    expect(JSON.parse(revokedEvent!.payload).reason).toBe('session_teardown');
  });

  it('never fails the MCP request when the audit write itself throws', async () => {
    insertSession({
      session_id: 'mcp-lifecycle-swallow',
      task_id: null,
      task_url: null,
      project_context_url: null,
      project_id: 'proj-lifecycle-swallow',
      status: 'running',
      started_at: Date.now(),
      session_type: 'standard',
    });
    const token = mintStageCredential('mcp-lifecycle-swallow');
    const spy = vi.spyOn(AuditLog, 'recordEvent').mockImplementation(() => {
      throw new Error('simulated audit write failure');
    });
    try {
      const res = await supertest(buildApp())
        .post('/api/mcp')
        .set('Authorization', `Bearer ${token}`)
        .set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
      expect(res.status).toBe(200);
    } finally {
      spy.mockRestore();
    }
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
