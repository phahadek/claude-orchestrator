/**
 * ops.prIntent is approve-terminal (see the approve route's ops.prIntent
 * branch and the stage-time group refusal in stagedIntents.ts) — it has no
 * separate apply step, the same as decision.pickOne, completeness.disposition,
 * review.dispute and test.request. The apply route carved out a 409 for those
 * four but not for ops.prIntent, so an operator's Apply click fell through to
 * applyIntent's `default:` case, threw a bare unknown-kind Error, and got
 * routed back to the staging session as a `provenance: 'auto'` pushback —
 * "the session's mistake to fix" — for an intent that was never malformed.
 * This covers the missing carve-out and its applyIntent defence-in-depth.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { EventEmitter } from 'events';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../../tasks/TaskBackend', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../tasks/TaskBackend')>();
  return { ...actual, getTaskBackend: vi.fn().mockReturnValue({ type: 'yaml' }) };
});

import { db } from '../../db/db';
import {
  insertSession,
  getStagedIntent,
  setStagedIntentGroup,
  transitionStagedIntent,
} from '../../db/queries';
import {
  createStagedIntentsRouter,
  setStagedIntentBroadcast,
  stageIntent,
  commitGroupIntents,
} from '../stagedIntents';
import type { SessionManager } from '../../session/SessionManager';

const SESSION_ID = 'session-ops-pr-intent-apply';

function insertOpsSession(taskId: string): void {
  insertSession({
    session_id: SESSION_ID,
    task_id: taskId,
    task_url: 'https://notion.so/task-1',
    project_context_url: 'https://notion.so/ctx',
    status: 'idle',
    started_at: Date.now(),
    session_type: 'ops',
  });
}

function makeSessionManager(): SessionManager & EventEmitter {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    enqueueFeedback: vi.fn().mockResolvedValue(undefined),
    getLiveSession: vi.fn().mockReturnValue(undefined),
  }) as unknown as SessionManager & EventEmitter;
}

const VALID_PAYLOAD = {
  taskId: 'task-1',
  title: 'add retry to the poller',
  scope: 'src/ops/poller.ts and its test — add exponential backoff retry',
  reason: 'poller has been dropping events under transient network errors',
};

function stageOpsPrIntent() {
  return stageIntent(
    'ops.prIntent',
    VALID_PAYLOAD,
    'proj-1',
    null,
    SESSION_ID,
  );
}

function makeApp() {
  const sessionManager = makeSessionManager();
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter(undefined, sessionManager));
  return supertest(app);
}

beforeEach(() => {
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM audit_log').run();
  setStagedIntentBroadcast(() => {});
});

describe('ops.prIntent apply route — 409 carve-out', () => {
  it('returns 409 naming the approve route instead of falling through to applyIntent', async () => {
    insertOpsSession('task-1');
    const staged = stageOpsPrIntent();
    const agent = makeApp();

    const res = await agent.post(`/api/staged-intents/${staged.id}/apply`);

    expect(res.status).toBe(409);
    expect(String(res.body.error)).toContain('ops.prIntent');
    expect(String(res.body.error)).toContain('approval is terminal for it');
    expect(String(res.body.error)).toContain('/staged-intents/:id/approve');
  });

  it('leaves the intent state unchanged — never needs_revision — after the rejected apply call', async () => {
    insertOpsSession('task-1');
    const staged = stageOpsPrIntent();
    const agent = makeApp();

    const res = await agent.post(`/api/staged-intents/${staged.id}/apply`);
    expect(res.status).toBe(409);

    const row = getStagedIntent(staged.id);
    expect(row?.state).toBe('staged');
    expect(row?.state).not.toBe('needs_revision');
  });

  it('writes no staged_intent_disposition audit row with provenance "auto" for the rejected apply attempt', async () => {
    insertOpsSession('task-1');
    const staged = stageOpsPrIntent();
    const agent = makeApp();

    const res = await agent.post(`/api/staged-intents/${staged.id}/apply`);
    expect(res.status).toBe(409);

    const rows = db
      .prepare(
        `SELECT payload FROM audit_log WHERE event_type = 'staged_intent_disposition'`,
      )
      .all() as Array<{ payload: string }>;
    const autoPushbacksForThisIntent = rows
      .map((r) => JSON.parse(r.payload) as { intentId?: string; provenance?: string })
      .filter((p) => p.intentId === staged.id && p.provenance === 'auto');
    expect(autoPushbacksForThisIntent).toEqual([]);
  });
});

describe('applyIntent defence-in-depth for a stray grouped ops.prIntent', () => {
  it('returns a typed "not operator-appliable" error instead of the generic unknown-kind throw', async () => {
    insertOpsSession('task-1');
    const staged = stageOpsPrIntent();
    // ops.prIntent refuses grouping at stage time; force one into a group to
    // exercise applyIntent's defence-in-depth directly, the way a stray row
    // from an unforeseen future path would reach the group-commit loop.
    setStagedIntentGroup(staged.id, 'group-stray-ops-pr-intent');
    transitionStagedIntent(staged.id, 'approved');

    const result = await commitGroupIntents('group-stray-ops-pr-intent', {
      override: false,
      reason: '',
      actorType: 'human',
    });

    expect(result.status).toBe(409);
    expect(String(result.body.error)).toContain('not operator-appliable');
    expect(String(result.body.error)).not.toContain('unknown intent kind');
  });
});

describe('ops.prIntent approve route — existing-behaviour regression guard', () => {
  it('still transitions straight to committed, exactly as before this fix', async () => {
    insertOpsSession('task-1');
    const staged = stageOpsPrIntent();
    const agent = makeApp();

    const res = await agent.post(`/api/staged-intents/${staged.id}/approve`);

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('committed');
    const row = getStagedIntent(staged.id);
    expect(row?.state).toBe('committed');
  });
});

describe('approve-terminal kinds all have a matching apply-route 409 carve-out', () => {
  it('guards against the next approve-terminal kind repeating the ops.prIntent omission', () => {
    const sourcePath = path.join(__dirname, '..', 'stagedIntents.ts');
    const source = readFileSync(sourcePath, 'utf8');

    const approveRouteStart = source.indexOf("'/staged-intents/:id/approve'");
    expect(approveRouteStart).toBeGreaterThan(-1);
    const approveRouteEnd = source.indexOf(
      "router.post(",
      approveRouteStart + 1,
    );
    const approveRouteBody = source.slice(
      approveRouteStart,
      approveRouteEnd === -1 ? undefined : approveRouteEnd,
    );

    // Terminal kinds are the ones whose approve-route comment — written
    // immediately above their `if (intent.kind === '...')` branch — says
    // they have "no separate apply step either", i.e. applyIntent is the
    // alternate path they must be kept away from. (session.requestCapability
    // is deliberately excluded: its terminal comment lacks "either" because it
    // never applies via applyIntent at all — it grants a capability directly.)
    const ifBranchPattern = /if \(intent\.kind === '([^']+)'\)/g;
    const branches: Array<{ kind: string; index: number }> = [];
    let ifMatch: RegExpExecArray | null;
    while ((ifMatch = ifBranchPattern.exec(approveRouteBody)) !== null) {
      branches.push({ kind: ifMatch[1], index: ifMatch.index });
    }
    const terminalKinds = new Set<string>();
    let precedingStart = 0;
    for (const branch of branches) {
      const preceding = approveRouteBody.slice(precedingStart, branch.index);
      if (/has no separate apply step either/.test(preceding)) {
        terminalKinds.add(branch.kind);
      }
      precedingStart = branch.index;
    }

    expect(terminalKinds.size).toBeGreaterThanOrEqual(4);

    const applyRouteStart = source.indexOf("'/staged-intents/:id/apply'");
    expect(applyRouteStart).toBeGreaterThan(-1);
    const applyRouteEnd = source.indexOf('router.post(', applyRouteStart + 1);
    const applyRouteBody = source.slice(
      applyRouteStart,
      applyRouteEnd === -1 ? undefined : applyRouteEnd,
    );

    for (const kind of terminalKinds) {
      expect(applyRouteBody).toContain(`row.kind === '${kind}'`);
      expect(applyRouteBody).toContain('approval is terminal for it');
    }
  });
});
