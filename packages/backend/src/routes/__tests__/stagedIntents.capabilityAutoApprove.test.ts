/**
 * The auto-approve policy for session.requestCapability: a request for a
 * sanctioned read-only own-record capability is granted and the requesting
 * session re-dispatched immediately, without an operator park. Everything
 * else — a write, a raw Bash/mcp-verb prefix, or another session's
 * own-record capability — still parks for the existing grant-on-re-dispatch
 * operator surface. Every request's disposition is audited, with provenance
 * distinguishing the auto path from the operator path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import {
  stageIntent,
  routeStageTimeBlock,
  type StagedIntent,
} from '../stagedIntents';
import { sessionRecordReadCapability } from '../../session/orchestrator-config';
import { getAuditLogByActorId } from '../../audit/AuditLog';
import { runtimeSettings } from '../../config';
import type { SessionManager } from '../../session/SessionManager';

function makeSessionManager() {
  return {
    grantCapability: vi.fn().mockReturnValue([]),
    enqueueFeedback: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionManager & {
    grantCapability: ReturnType<typeof vi.fn>;
    enqueueFeedback: ReturnType<typeof vi.fn>;
  };
}

function stageCapabilityRequest(
  sessionId: string,
  capability: string,
): StagedIntent {
  return stageIntent(
    'session.requestCapability',
    {
      capability,
      plan: 'verify a gate item by reading my own runtime record',
      evidence: 'no other grantable capability reaches this DB',
    },
    'proj-1',
    null,
    sessionId,
  );
}

beforeEach(() => {
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM audit_log').run();
  runtimeSettings.capability_auto_approve_enabled = true;
});

describe('session.requestCapability auto-approve policy', () => {
  it('auto-grants and re-dispatches a sanctioned own-record read request without an operator park', async () => {
    const sessionManager = makeSessionManager();
    const capability = sessionRecordReadCapability('sess-auto-1');
    const intent = stageCapabilityRequest('sess-auto-1', capability);
    expect(intent.state).toBe('staged');

    const checked = await routeStageTimeBlock(intent, sessionManager);

    expect(checked.state).toBe('committed');
    expect(sessionManager.grantCapability).toHaveBeenCalledWith(
      'sess-auto-1',
      capability,
    );
    expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(1);
    const [sessionId, source] = sessionManager.enqueueFeedback.mock.calls[0];
    expect(sessionId).toBe('sess-auto-1');
    expect(source).toBe('operator-disposition');
  });

  it('parks a write/prefix request unchanged — never auto-approved', async () => {
    const sessionManager = makeSessionManager();
    const intent = stageCapabilityRequest('sess-park-1', 'Bash(psql:*)');

    const checked = await routeStageTimeBlock(intent, sessionManager);

    expect(checked.state).toBe('staged');
    expect(sessionManager.grantCapability).not.toHaveBeenCalled();
    expect(sessionManager.enqueueFeedback).not.toHaveBeenCalled();
  });

  it('parks a request for a raw Bash-prefix grant even when it looks read-only', async () => {
    const sessionManager = makeSessionManager();
    const intent = stageCapabilityRequest('sess-park-2', 'Bash(cat:*)');

    const checked = await routeStageTimeBlock(intent, sessionManager);

    expect(checked.state).toBe('staged');
    expect(sessionManager.grantCapability).not.toHaveBeenCalled();
  });

  it('parks a request for another session\'s own-record read — only self-targeted reads are sanctioned', async () => {
    const sessionManager = makeSessionManager();
    const capability = sessionRecordReadCapability('some-other-session');
    const intent = stageCapabilityRequest('sess-park-3', capability);

    const checked = await routeStageTimeBlock(intent, sessionManager);

    expect(checked.state).toBe('staged');
    expect(sessionManager.grantCapability).not.toHaveBeenCalled();
  });

  it('is idempotent — re-requesting an already-granted sanctioned capability auto-grants again without error or duplication', async () => {
    const sessionManager = makeSessionManager();
    const capability = sessionRecordReadCapability('sess-auto-2');

    const first = stageCapabilityRequest('sess-auto-2', capability);
    const firstChecked = await routeStageTimeBlock(first, sessionManager);
    expect(firstChecked.state).toBe('committed');

    const second = stageCapabilityRequest('sess-auto-2', capability);
    const secondChecked = await routeStageTimeBlock(second, sessionManager);
    expect(secondChecked.state).toBe('committed');

    expect(sessionManager.grantCapability).toHaveBeenCalledTimes(2);
    expect(sessionManager.grantCapability).toHaveBeenNthCalledWith(
      1,
      'sess-auto-2',
      capability,
    );
    expect(sessionManager.grantCapability).toHaveBeenNthCalledWith(
      2,
      'sess-auto-2',
      capability,
    );
  });

  it('never auto-approves when the kill switch is off — every request parks regardless of the allowlist', async () => {
    runtimeSettings.capability_auto_approve_enabled = false;
    const sessionManager = makeSessionManager();
    const capability = sessionRecordReadCapability('sess-off-1');
    const intent = stageCapabilityRequest('sess-off-1', capability);

    const checked = await routeStageTimeBlock(intent, sessionManager);

    expect(checked.state).toBe('staged');
    expect(sessionManager.grantCapability).not.toHaveBeenCalled();
  });

  it('audits the auto-approved disposition with auto provenance', async () => {
    const sessionManager = makeSessionManager();
    const capability = sessionRecordReadCapability('sess-audit-auto');
    const intent = stageCapabilityRequest('sess-audit-auto', capability);

    await routeStageTimeBlock(intent, sessionManager);

    const events = getAuditLogByActorId('sess-audit-auto');
    const dispositionEvents = events.filter(
      (e) => e.eventType === 'capability_request_disposition',
    );
    expect(dispositionEvents).toHaveLength(1);
    const payload = dispositionEvents[0].payload as Record<string, unknown>;
    expect(payload.disposition).toBe('auto_approved');
    expect(payload.provenance).toBe('auto');
    expect(payload.capability).toBe(capability);
    expect(dispositionEvents[0].actorType).toBe('system');
  });

  it('audits the operator-approved disposition with operator provenance', async () => {
    const sessionManager = makeSessionManager();
    const intent = stageCapabilityRequest('sess-audit-op-approve', 'Bash(psql:*)');
    // Parked (not sanctioned) — simulate the existing operator-approve path
    // directly via the exported apply surface used by the REST route.
    const { createStagedIntentsRouter } = await import('../stagedIntents');
    const express = (await import('express')).default;
    const supertest = (await import('supertest')).default;
    const app = express();
    app.use(express.json());
    app.use('/api', createStagedIntentsRouter(undefined, sessionManager));

    await routeStageTimeBlock(intent, sessionManager);
    const res = await supertest(app).post(
      `/api/staged-intents/${intent.id}/approve`,
    );
    expect(res.status).toBe(200);

    const events = getAuditLogByActorId('sess-audit-op-approve');
    const dispositionEvents = events.filter(
      (e) => e.eventType === 'capability_request_disposition',
    );
    expect(dispositionEvents).toHaveLength(1);
    const payload = dispositionEvents[0].payload as Record<string, unknown>;
    expect(payload.disposition).toBe('operator_approved');
    expect(payload.provenance).toBe('operator');
    expect(dispositionEvents[0].actorType).toBe('human');
  });

  it('audits a declined request with operator provenance', async () => {
    const sessionManager = makeSessionManager();
    const intent = stageCapabilityRequest('sess-audit-decline', 'Bash(rm:*)');
    const { createStagedIntentsRouter } = await import('../stagedIntents');
    const express = (await import('express')).default;
    const supertest = (await import('supertest')).default;
    const app = express();
    app.use(express.json());
    app.use('/api', createStagedIntentsRouter(undefined, sessionManager));

    await routeStageTimeBlock(intent, sessionManager);
    const res = await supertest(app)
      .post(`/api/staged-intents/${intent.id}/reject`)
      .send({ outcome: 'decline', reason: 'too risky' });
    expect(res.status).toBe(200);

    const events = getAuditLogByActorId('sess-audit-decline');
    const dispositionEvents = events.filter(
      (e) => e.eventType === 'capability_request_disposition',
    );
    expect(dispositionEvents).toHaveLength(1);
    const payload = dispositionEvents[0].payload as Record<string, unknown>;
    expect(payload.disposition).toBe('declined');
    expect(payload.provenance).toBe('operator');
  });
});
