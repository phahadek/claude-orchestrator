import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import path from 'path';

vi.mock('../db/queries', () => ({
  getGrantedCapabilities: vi.fn(() => []),
  getDeviceByToken: vi.fn(() => null),
  updateDeviceLastSeen: vi.fn(),
  getActiveDeviceCount: vi.fn(() => 1),
}));

import * as queries from '../db/queries';
import {
  mintRouteCredential,
  revokeRouteCredential,
  requireDeviceOrSessionRouteAuth,
  routeCredentialFilePath,
  writeRouteCredentialFile,
  isRouteAuthorizedForSession,
  _resetRouteCredentialsForTesting,
  _simulateRouteCredentialProcessRestartForTesting,
} from '../auth/SessionRouteAuth';

/** Mirrors the real server: the single combined middleware gates every /api route. */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.get('/api/gate/readiness', requireDeviceOrSessionRouteAuth, (_req, res) =>
    res.json({ ok: true }),
  );
  app.get(
    '/api/staged-intents',
    requireDeviceOrSessionRouteAuth,
    (_req, res) => res.json({ ok: true }),
  );
  return app;
}

const GATE_GRANT = 'Bash(node packages/backend/scripts/gate-state-client.mjs *)';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(queries.getActiveDeviceCount).mockReturnValue(1);
  vi.mocked(queries.getGrantedCapabilities).mockReturnValue([]);
  _resetRouteCredentialsForTesting();
});

describe('SessionRouteAuth — requireDeviceOrSessionRouteAuth middleware', () => {
  it('authenticates a dispatched session holding a granted route-client capability against its corresponding route', async () => {
    vi.mocked(queries.getGrantedCapabilities).mockImplementation((sessionId) =>
      sessionId === 'ops-session-1' ? [GATE_GRANT] : [],
    );
    const token = mintRouteCredential('ops-session-1');

    const res = await supertest(buildApp())
      .get('/api/gate/readiness')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('rejects the credential on a route the session was not granted a matching capability for', async () => {
    vi.mocked(queries.getGrantedCapabilities).mockImplementation((sessionId) =>
      sessionId === 'ops-session-2' ? [GATE_GRANT] : [],
    );
    const token = mintRouteCredential('ops-session-2');

    // gate-state-client.mjs grant does not cover /api/staged-intents.
    const res = await supertest(buildApp())
      .get('/api/staged-intents')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('route_credential_out_of_scope');
  });

  it('rejects a valid credential with no matching grant at all', async () => {
    const token = mintRouteCredential('ops-session-3');
    const res = await supertest(buildApp())
      .get('/api/gate/readiness')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("rejects a session presenting another session's credential", async () => {
    vi.mocked(queries.getGrantedCapabilities).mockImplementation((sessionId) =>
      sessionId === 'ops-session-A' ? [GATE_GRANT] : [],
    );
    // ops-session-A holds the grant, but ops-session-B's own token is what's
    // presented — a session can only ever authenticate as itself.
    mintRouteCredential('ops-session-A');
    const otherToken = mintRouteCredential('ops-session-B');

    const res = await supertest(buildApp())
      .get('/api/gate/readiness')
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('route_credential_out_of_scope');
  });

  it('falls back to standard device-auth rejection for an unrecognized bearer token', async () => {
    vi.mocked(queries.getActiveDeviceCount).mockReturnValue(1);
    vi.mocked(queries.getDeviceByToken).mockReturnValue(null);
    const res = await supertest(buildApp())
      .get('/api/gate/readiness')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('invalid_token');
  });

  it('rejects a revoked credential — a subsequent request is unauthorized', async () => {
    vi.mocked(queries.getGrantedCapabilities).mockImplementation((sessionId) =>
      sessionId === 'ops-session-4' ? [GATE_GRANT] : [],
    );
    const token = mintRouteCredential('ops-session-4');
    revokeRouteCredential('ops-session-4', 'session_teardown');

    const res = await supertest(buildApp())
      .get('/api/gate/readiness')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
  });
});

describe('SessionRouteAuth — mint/revoke lifecycle', () => {
  it('mintRouteCredential is idempotent per session id (resume-safe)', () => {
    const t1 = mintRouteCredential('ops-session-5');
    const t2 = mintRouteCredential('ops-session-5');
    expect(t1).toBe(t2);
  });

  it('survives a simulated backend restart with the same token', () => {
    const token = mintRouteCredential('ops-session-6');
    _simulateRouteCredentialProcessRestartForTesting();
    const tokenAfterRestart = mintRouteCredential('ops-session-6');
    expect(tokenAfterRestart).toBe(token);
  });

  it('revoke is idempotent and safe to call on an unminted session', () => {
    expect(() => revokeRouteCredential('never-minted')).not.toThrow();
  });

  it('two different sessions get two different tokens', () => {
    const a = mintRouteCredential('ops-session-7a');
    const b = mintRouteCredential('ops-session-7b');
    expect(a).not.toBe(b);
  });
});

describe('SessionRouteAuth — credential delivery file', () => {
  it('is written outside every project directory and outside the worktree', () => {
    const filePath = writeRouteCredentialFile('ops-session-8');
    const projectDir = '/home/user/projects/some-project';
    const worktreeDir = path.join(
      projectDir,
      '.claude',
      'worktrees',
      'ops-session-8',
    );
    expect(filePath.startsWith(projectDir)).toBe(false);
    expect(filePath.startsWith(worktreeDir)).toBe(false);
    expect(filePath).toBe(routeCredentialFilePath('ops-session-8'));
  });

  it('the delivery-file path is deterministic and requires no side effects to compute', () => {
    const before = routeCredentialFilePath('ops-session-9');
    const after = routeCredentialFilePath('ops-session-9');
    expect(before).toBe(after);
  });
});

describe('SessionRouteAuth — isRouteAuthorizedForSession scope', () => {
  it('a task-abort grant authorizes only the abort route, not staged-intents', () => {
    vi.mocked(queries.getGrantedCapabilities).mockReturnValue([
      'Bash(node packages/backend/scripts/task-abort-client.mjs *)',
    ]);
    expect(
      isRouteAuthorizedForSession('s', '/api/tasks/task-1/abort'),
    ).toBe(true);
    expect(isRouteAuthorizedForSession('s', '/api/staged-intents')).toBe(
      false,
    );
  });

  it('a wildcard denylisted capability (containing "apply") never authorizes anything', () => {
    vi.mocked(queries.getGrantedCapabilities).mockReturnValue([
      'Bash(node packages/backend/scripts/staged-intents-client.mjs apply *)',
    ]);
    expect(isRouteAuthorizedForSession('s', '/api/staged-intents')).toBe(
      false,
    );
  });

  it('the ops-client.mjs grant never authorizes the retired write path', () => {
    vi.mocked(queries.getGrantedCapabilities).mockReturnValue([
      'Bash(node scripts/ops-client.mjs *)',
    ]);
    expect(isRouteAuthorizedForSession('s', '/api/ops-journal')).toBe(true);
    expect(
      isRouteAuthorizedForSession('s', '/api/ops-journal/task-1/state'),
    ).toBe(false);
  });

  it('a non-tool-shaped capability never authorizes a route', () => {
    vi.mocked(queries.getGrantedCapabilities).mockReturnValue([
      'read:path:/srv/orchestrator/data',
    ]);
    expect(isRouteAuthorizedForSession('s', '/api/gate/readiness')).toBe(
      false,
    );
  });
});
