/**
 * Tests SessionManager's wiring of SessionStageAuth/SessionRouteAuth's
 * revoked-credential handlers: a request presenting a credential this
 * backend knows it already revoked means an OS process is still alive and
 * calling in on a credential it can never refresh. SessionManager reclaims
 * it (rather than leaving it to retry/back off forever) by archiving the
 * session and recording a pause_reason naming the revocation — never by
 * writing a terminal status itself; terminalizing a session is an
 * operator-only action.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDbQueries } from './helpers/mockDbQueries';

vi.mock('../db/queries', () =>
  mockDbQueries({
    getSession: vi.fn(),
    updateSessionStatus: vi.fn(),
    archiveSession: vi.fn(),
    setSessionPauseReason: vi.fn(),
  }),
);

vi.mock('../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

import { SessionManager } from '../session/SessionManager';
import * as queries from '../db/queries';
import { recordEvent } from '../audit/AuditLog';
import {
  mintStageCredential,
  revokeStageCredential,
  requireSessionStageAuth,
  _resetStageCredentialsForTesting,
} from '../auth/SessionStageAuth';
import {
  mintRouteCredential,
  revokeRouteCredential,
  requireDeviceOrSessionRouteAuth,
  _resetRouteCredentialsForTesting,
} from '../auth/SessionRouteAuth';

function fakeRes() {
  const state: { statusCode?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      state.body = payload;
      return this;
    },
  };
  return {
    res: res as unknown as Parameters<typeof requireSessionStageAuth>[1],
    state,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(queries.getSession).mockReturnValue(undefined as never);
  _resetStageCredentialsForTesting();
  _resetRouteCredentialsForTesting();
});

describe('SessionManager — reclaims a session on a revoked stage credential', () => {
  it('archives the row, records a pause_reason, and audits it — never writes a terminal status', () => {
    // Constructing SessionManager wires setRevokedStageCredentialHandler.
    new SessionManager();

    const token = mintStageCredential('live-but-revoked');
    revokeStageCredential('live-but-revoked');

    const req = {
      headers: { authorization: `Bearer ${token}` },
      socket: { remoteAddress: '127.0.0.1' },
      path: '/api/mcp',
    } as unknown as Parameters<typeof requireSessionStageAuth>[0];
    const { res, state } = fakeRes();

    requireSessionStageAuth(req, res, () => {
      throw new Error('next() must not be called for a revoked credential');
    });

    expect(state.statusCode).toBe(410);
    expect((state.body as { code: string }).code).toBe(
      'session_credential_revoked',
    );
    expect(queries.updateSessionStatus).not.toHaveBeenCalled();
    expect(queries.archiveSession).toHaveBeenCalledWith('live-but-revoked');
    expect(queries.setSessionPauseReason).toHaveBeenCalledWith(
      'live-but-revoked',
      'credential_revoked_mcp',
    );
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'session_surfaced_to_operator',
        actor_id: 'live-but-revoked',
      }),
    );
  });

  it('is idempotent — still archives and sets pause_reason when the row is already terminal', () => {
    new SessionManager();
    vi.mocked(queries.getSession).mockReturnValue({
      session_id: 'already-killed',
      status: 'killed',
    } as never);

    const token = mintStageCredential('already-killed');
    revokeStageCredential('already-killed');

    const req = {
      headers: { authorization: `Bearer ${token}` },
      socket: { remoteAddress: '127.0.0.1' },
      path: '/api/mcp',
    } as unknown as Parameters<typeof requireSessionStageAuth>[0];
    const { res } = fakeRes();

    requireSessionStageAuth(req, res, () => {});

    expect(queries.updateSessionStatus).not.toHaveBeenCalled();
    expect(queries.archiveSession).toHaveBeenCalledWith('already-killed');
    expect(queries.setSessionPauseReason).toHaveBeenCalledWith(
      'already-killed',
      'credential_revoked_mcp',
    );
  });
});

describe('SessionManager — reclaims a session on a revoked route credential', () => {
  it('archives the row and records a pause_reason', async () => {
    new SessionManager();

    const token = mintRouteCredential('live-but-revoked-route');
    revokeRouteCredential('live-but-revoked-route');

    const req = {
      headers: { authorization: `Bearer ${token}` },
      socket: { remoteAddress: '127.0.0.1' },
      path: '/api/gate/readiness',
      method: 'GET',
    } as unknown as Parameters<typeof requireDeviceOrSessionRouteAuth>[0];
    const { res, state } = fakeRes();

    requireDeviceOrSessionRouteAuth(req, res, () => {
      throw new Error('next() must not be called for a revoked credential');
    });

    expect(state.statusCode).toBe(410);
    expect((state.body as { code: string }).code).toBe(
      'session_credential_revoked',
    );
    expect(queries.archiveSession).toHaveBeenCalledWith(
      'live-but-revoked-route',
    );
    expect(queries.setSessionPauseReason).toHaveBeenCalledWith(
      'live-but-revoked-route',
      'credential_revoked_route',
    );
  });
});
