/**
 * The declared-write auto-approve path: a write-shaped
 * session.requestCapability request from an ops session auto-approves when
 * it exact-matches a capability the task declared at grooming/Ready time
 * (captured onto the session's row at spawn — see
 * SessionManager.start/setSessionDeclaredWrites), and that declared entry is
 * not tagged Prod-Mutating. This is additive to — and independent of — the
 * pre-existing sanctioned-read-only auto-approve path covered by
 * stagedIntents.capabilityAutoApprove.test.ts.
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
import { insertSession, setSessionDeclaredWrites } from '../../db/queries';
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
      plan: 'run the declared write this task was approved for',
      evidence: 'declared in the Declared writes task-body section',
    },
    'proj-1',
    null,
    sessionId,
  );
}

function makeOpsSession(
  sessionId: string,
  declaredWrites: { capability: string; prodMutating: boolean }[],
): void {
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
  setSessionDeclaredWrites(sessionId, declaredWrites);
}

beforeEach(() => {
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM sessions').run();
  runtimeSettings.capability_auto_approve_enabled = true;
});

describe('session.requestCapability declared-write auto-approve', () => {
  it('auto-approves a declared, non-Prod-Mutating write from an ops session', async () => {
    const sessionManager = makeSessionManager();
    makeOpsSession('sess-declared-1', [
      { capability: 'Bash(npm ci:*)', prodMutating: false },
    ]);
    const intent = stageCapabilityRequest('sess-declared-1', 'Bash(npm ci:*)');

    const checked = await routeStageTimeBlock(intent, sessionManager);

    expect(checked.state).toBe('committed');
    expect(sessionManager.grantCapability).toHaveBeenCalledWith(
      'sess-declared-1',
      'Bash(npm ci:*)',
    );
  });

  it('never auto-approves a declared write tagged Prod-Mutating — always parks', async () => {
    const sessionManager = makeSessionManager();
    makeOpsSession('sess-declared-2', [
      { capability: 'Bash(git push:*)', prodMutating: true },
    ]);
    const intent = stageCapabilityRequest(
      'sess-declared-2',
      'Bash(git push:*)',
    );

    const checked = await routeStageTimeBlock(intent, sessionManager);

    expect(checked.state).toBe('staged');
    expect(sessionManager.grantCapability).not.toHaveBeenCalled();
  });

  it('parks an undeclared write from an ops session — no regression to manual approval', async () => {
    const sessionManager = makeSessionManager();
    makeOpsSession('sess-declared-3', [
      { capability: 'Bash(npm ci:*)', prodMutating: false },
    ]);
    const intent = stageCapabilityRequest(
      'sess-declared-3',
      'Bash(npm publish:*)',
    );

    const checked = await routeStageTimeBlock(intent, sessionManager);

    expect(checked.state).toBe('staged');
    expect(sessionManager.grantCapability).not.toHaveBeenCalled();
  });

  it('parks a write request for a session with no declared-writes capture at all', async () => {
    const sessionManager = makeSessionManager();
    makeOpsSession('sess-declared-4', []);
    const intent = stageCapabilityRequest('sess-declared-4', 'Bash(npm ci:*)');

    const checked = await routeStageTimeBlock(intent, sessionManager);

    expect(checked.state).toBe('staged');
    expect(sessionManager.grantCapability).not.toHaveBeenCalled();
  });

  it('never auto-approves a declared write from a non-ops session', async () => {
    const sessionManager = makeSessionManager();
    insertSession({
      session_id: 'sess-declared-5',
      task_id: 'notion:task-1',
      task_url: 'https://notion.so/task-1',
      project_context_url: 'https://notion.so/ctx',
      project_id: 'proj-1',
      status: 'running',
      started_at: Date.now(),
      session_type: 'standard',
    });
    setSessionDeclaredWrites('sess-declared-5', [
      { capability: 'Bash(npm ci:*)', prodMutating: false },
    ]);
    const intent = stageCapabilityRequest('sess-declared-5', 'Bash(npm ci:*)');

    const checked = await routeStageTimeBlock(intent, sessionManager);

    expect(checked.state).toBe('staged');
    expect(sessionManager.grantCapability).not.toHaveBeenCalled();
  });

  it('rejects a hard-denylisted capability outright even when it appears in the declared-writes set', async () => {
    makeOpsSession('sess-declared-6', [
      { capability: 'Bash(git push:*)', prodMutating: false },
    ]);

    expect(() =>
      stageIntent(
        'session.requestCapability',
        { capability: 'Write', plan: 'x', evidence: 'y' },
        'proj-1',
        null,
        'sess-declared-6',
      ),
    ).toThrow(/denied/);
  });
});
