/**
 * A session.requestCapability request for a capability already present in
 * the requesting session's granted set (config-pre-granted or previously
 * approved) short-circuits to an immediate no-op — transitioned straight to
 * `withdrawn` — rather than re-running the sanctioned/declared-write
 * auto-approve pipeline or parking a fresh pending intent. Independent of
 * stagedIntents.capabilityAutoApprove.test.ts and
 * stagedIntents.declaredWriteAutoApprove.test.ts, which cover the two
 * auto-approve paths this short-circuit is checked ahead of.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

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
import { insertSession, seedGrantedCapabilities } from '../../db/queries';
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
      plan: 'use a capability this session already holds',
      evidence: 'redundant request — should short-circuit',
    },
    'proj-1',
    null,
    sessionId,
  );
}

function makeSessionWithGrant(sessionId: string, capability: string): void {
  insertSession({
    session_id: sessionId,
    task_id: 'notion:task-1',
    task_url: 'https://notion.so/task-1',
    project_context_url: 'https://notion.so/ctx',
    project_id: 'proj-1',
    status: 'running',
    started_at: Date.now(),
    session_type: 'ops',
  });
  seedGrantedCapabilities(sessionId, [capability]);
}

beforeEach(() => {
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM sessions').run();
  runtimeSettings.capability_auto_approve_enabled = true;
});

describe('session.requestCapability redundant-request short-circuit', () => {
  it('resolves immediately to withdrawn for a capability already in the granted set, without granting or auditing a disposition', async () => {
    const sessionManager = makeSessionManager();
    makeSessionWithGrant('sess-redundant-1', 'Bash(git log:*)');
    const intent = stageCapabilityRequest(
      'sess-redundant-1',
      'Bash(git log:*)',
    );
    expect(intent.state).toBe('staged');

    const checked = await routeStageTimeBlock(intent, sessionManager);

    expect(checked.state).toBe('withdrawn');
    expect(sessionManager.grantCapability).not.toHaveBeenCalled();
    expect(sessionManager.enqueueFeedback).not.toHaveBeenCalled();
    const events = getAuditLogByActorId('sess-redundant-1').filter(
      (e) => e.eventType === 'capability_request_disposition',
    );
    expect(events).toHaveLength(0);
  });

  it('still parks a request for a capability not in the granted set, unaffected by the short-circuit', async () => {
    const sessionManager = makeSessionManager();
    makeSessionWithGrant('sess-redundant-2', 'Bash(git log:*)');
    const intent = stageCapabilityRequest('sess-redundant-2', 'Bash(psql:*)');

    const checked = await routeStageTimeBlock(intent, sessionManager);

    expect(checked.state).toBe('staged');
    expect(sessionManager.grantCapability).not.toHaveBeenCalled();
  });
});
