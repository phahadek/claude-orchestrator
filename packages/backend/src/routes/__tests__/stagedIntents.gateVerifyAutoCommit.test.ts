/**
 * Tests for the gate.verify auto-commit policy (decision 3 of "Design
 * gate-verify conclusion presentation"): staging a gate.verify verdict whose
 * disposition matches an operator-armed (milestone, disposition class)
 * policy commits it immediately through the normal applyIntent/
 * routeVerificationResult write path — no operator action — and releases
 * the originating parked verify session exactly like a manual commit does.
 * A reclassify proposal is always excluded, regardless of policy. Arming a
 * policy for a class also sweeps and commits any already-staged/approved
 * backlog matching that class.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import express from 'express';
import supertest from 'supertest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { insertSession, getSession } from '../../db/queries';
import { insertItem } from '../../gate/gateStore';
import {
  createStagedIntentsRouter,
  stageIntent,
  autoCommitGateVerifyIntent,
  sweepGateVerifyAutoCommitBacklogForMilestone,
} from '../stagedIntents';
import { createMilestonesRouter } from '../milestones';
import { PlanningOrchestrator } from '../../orchestration/PlanningOrchestrator';
import { ProjectService } from '../../projects/ProjectService';
import { upsertGateVerifyAutoCommitPolicy } from '../../db/queries';

function makeSessionManager() {
  const sm = new EventEmitter();
  return Object.assign(sm, {
    enqueueFeedback: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn(),
    getLiveSession: vi.fn().mockReturnValue(undefined),
  });
}

function seedVerifySession(sessionId: string, gateItemId: string) {
  insertSession({
    session_id: sessionId,
    task_id: `gate-item:${gateItemId}`,
    task_url: null,
    project_context_url: null,
    status: 'idle',
    started_at: 0,
    session_type: 'ops',
    note: null,
    tags: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    compaction_count: 0,
    context_occupancy_tokens: 0,
    task_name: null,
    metadata: null,
    review_result: null,
    pause_reason: null,
    last_error_detail: null,
    events_pruned_at: null,
    granted_capabilities: '[]',
  });
}

function makeRunnableGateItem(overrides: Partial<Parameters<typeof insertItem>[0]> = {}) {
  const item = insertItem({
    project: 'proj-auto-commit',
    milestone: 'M12',
    text: 'Confirm the export job completes',
    classification: 'Read-Only',
    sources: [{ sourceTaskId: 'notion:xyz', sourceTaskTitle: 'Export job' }],
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  });
  db.prepare(`UPDATE gate_item SET state = 'runnable' WHERE id = ?`).run(item.id);
  return item;
}

beforeEach(() => {
  db.prepare('DELETE FROM gate_item_event').run();
  db.prepare('DELETE FROM gate_item_source').run();
  db.prepare('DELETE FROM gate_item').run();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM gate_verify_auto_commit_policy').run();
  db.prepare('DELETE FROM audit_log').run();

  if (!ProjectService.getById('proj-auto-commit')) {
    ProjectService.create({
      id: 'proj-auto-commit',
      name: 'Project Auto Commit',
      projectDir: '/tmp/proj-auto-commit',
    });
    ProjectService.createMilestone({
      id: 'ms-uuid-auto-commit-m12',
      projectId: 'proj-auto-commit',
      name: 'M12',
      canonicalShortId: 'M12',
    });
  }
});

describe('gate.verify auto-commit — staging-time attempt', () => {
  it('commits immediately when the staged disposition matches an armed policy, and releases the originating session', async () => {
    const item = makeRunnableGateItem();
    seedVerifySession('verify-session-1', item.id);
    upsertGateVerifyAutoCommitPolicy('M12', 'pass', true, Date.now());

    const sm = makeSessionManager();
    const planningOrchestrator = new PlanningOrchestrator(sm as any);
    // Wires the module-level SessionManager/PlanningOrchestrator instances
    // that stageIntent's fire-and-forget auto-commit attempt reads.
    createStagedIntentsRouter(planningOrchestrator, sm as any);

    const staged = stageIntent(
      'gate.verify',
      { gateItemId: item.id, disposition: 'pass' },
      'proj-auto-commit',
      null,
      'verify-session-1',
      `Gate item ${item.id}: reported pass`,
      null,
      null,
      item.milestone,
      null,
    );

    // stageIntent's own fire-and-forget auto-commit attempt races this
    // explicit call; autoCommitGateVerifyIntent's in-flight guard makes
    // whichever wins the only one that actually applies/commits, so
    // awaiting this call is sufficient to observe the outcome either way.
    await autoCommitGateVerifyIntent(staged as any, sm as any, planningOrchestrator);

    const row = db
      .prepare('SELECT state, annotation FROM staged_intent WHERE id = ?')
      .get(staged.id) as { state: string; annotation: string | null };
    expect(row.state).toBe('committed');
    expect(JSON.parse(row.annotation ?? '{}')).toEqual({ autoCommitted: true });

    const sessionRow = getSession('verify-session-1');
    expect(sessionRow?.status).toBe('done');
  });

  it('never auto-commits a reclassify proposal, even when its disposition matches an armed policy', async () => {
    const item = makeRunnableGateItem();
    seedVerifySession('verify-session-2', item.id);
    upsertGateVerifyAutoCommitPolicy('M12', 'fail', true, Date.now());

    const sm = makeSessionManager();
    const planningOrchestrator = new PlanningOrchestrator(sm as any);
    createStagedIntentsRouter(planningOrchestrator, sm as any);

    const staged = stageIntent(
      'gate.verify',
      {
        gateItemId: item.id,
        disposition: 'fail',
        reclassify: { to: 'Human-Observation', reason: 'needs a human eye' },
      },
      'proj-auto-commit',
      null,
      'verify-session-2',
      `Gate item ${item.id}: reported fail`,
      null,
      null,
      item.milestone,
      null,
    );

    const committed = await autoCommitGateVerifyIntent(
      staged as any,
      sm as any,
      planningOrchestrator,
    );

    expect(committed).toBe(false);
    const row = db
      .prepare('SELECT state FROM staged_intent WHERE id = ?')
      .get(staged.id) as { state: string };
    expect(row.state).toBe('staged');

    const sessionRow = getSession('verify-session-2');
    expect(sessionRow?.status).toBe('idle');
  });

  it('leaves an unarmed disposition class staged, untouched', async () => {
    const item = makeRunnableGateItem();
    seedVerifySession('verify-session-3', item.id);
    // No policy armed for any class.

    const sm = makeSessionManager();
    const planningOrchestrator = new PlanningOrchestrator(sm as any);
    createStagedIntentsRouter(planningOrchestrator, sm as any);

    const staged = stageIntent(
      'gate.verify',
      { gateItemId: item.id, disposition: 'pass' },
      'proj-auto-commit',
      null,
      'verify-session-3',
      `Gate item ${item.id}: reported pass`,
      null,
      null,
      item.milestone,
      null,
    );

    const row = db
      .prepare('SELECT state FROM staged_intent WHERE id = ?')
      .get(staged.id) as { state: string };
    expect(row.state).toBe('staged');
  });
});

describe('gate.verify auto-commit — backlog sweep on policy arm', () => {
  it('commits every matching staged/approved backlog member and releases each originating session', async () => {
    const item1 = makeRunnableGateItem({ text: 'Item one' });
    const item2 = makeRunnableGateItem({ text: 'Item two' });
    seedVerifySession('verify-session-backlog-1', item1.id);
    seedVerifySession('verify-session-backlog-2', item2.id);

    const sm = makeSessionManager();
    const planningOrchestrator = new PlanningOrchestrator(sm as any);
    createStagedIntentsRouter(planningOrchestrator, sm as any);

    // Stage both before any policy is armed — a pre-existing backlog.
    const staged1 = stageIntent(
      'gate.verify',
      { gateItemId: item1.id, disposition: 'pass' },
      'proj-auto-commit',
      null,
      'verify-session-backlog-1',
      `Gate item ${item1.id}: reported pass`,
      null,
      null,
      item1.milestone,
      null,
    );
    const staged2 = stageIntent(
      'gate.verify',
      { gateItemId: item2.id, disposition: 'pass' },
      'proj-auto-commit',
      null,
      'verify-session-backlog-2',
      `Gate item ${item2.id}: reported pass`,
      null,
      null,
      item2.milestone,
      null,
    );
    expect(
      (db.prepare('SELECT state FROM staged_intent WHERE id = ?').get(staged1.id) as any).state,
    ).toBe('staged');
    expect(
      (db.prepare('SELECT state FROM staged_intent WHERE id = ?').get(staged2.id) as any).state,
    ).toBe('staged');

    const swept = await sweepGateVerifyAutoCommitBacklogForMilestone('M12', 'pass');
    // Arming with no policy row yet armed should sweep nothing — arm first.
    expect(swept.committedIds).toEqual([]);

    upsertGateVerifyAutoCommitPolicy('M12', 'pass', true, Date.now());
    const sweptAfterArm = await sweepGateVerifyAutoCommitBacklogForMilestone(
      'M12',
      'pass',
    );

    expect(sweptAfterArm.committedIds.sort()).toEqual(
      [staged1.id, staged2.id].sort(),
    );
    expect(
      (db.prepare('SELECT state FROM staged_intent WHERE id = ?').get(staged1.id) as any).state,
    ).toBe('committed');
    expect(
      (db.prepare('SELECT state FROM staged_intent WHERE id = ?').get(staged2.id) as any).state,
    ).toBe('committed');
    expect(getSession('verify-session-backlog-1')?.status).toBe('done');
    expect(getSession('verify-session-backlog-2')?.status).toBe('done');
  });

  it('end-to-end: PUT /auto-commit-policy/:class with armed=true sweeps and commits the backlog and releases sessions', async () => {
    const item = makeRunnableGateItem({ text: 'End to end item' });
    seedVerifySession('verify-session-e2e', item.id);

    const sm = makeSessionManager();
    const planningOrchestrator = new PlanningOrchestrator(sm as any);
    const stagedApp = express();
    stagedApp.use(express.json());
    stagedApp.use('/api', createStagedIntentsRouter(planningOrchestrator, sm as any));

    const staged = stageIntent(
      'gate.verify',
      { gateItemId: item.id, disposition: 'fail' },
      'proj-auto-commit',
      null,
      'verify-session-e2e',
      `Gate item ${item.id}: reported fail`,
      null,
      null,
      item.milestone,
      null,
    );
    expect(
      (db.prepare('SELECT state FROM staged_intent WHERE id = ?').get(staged.id) as any).state,
    ).toBe('staged');

    const milestonesApp = express();
    milestonesApp.use(express.json());
    milestonesApp.use('/api', createMilestonesRouter());

    const res = await supertest(milestonesApp)
      .put('/api/milestones/M12/auto-commit-policy/fail')
      .send({ armed: true });

    expect(res.status).toBe(200);
    expect(res.body.sweptCommittedIds).toEqual([staged.id]);

    const row = db
      .prepare('SELECT state FROM staged_intent WHERE id = ?')
      .get(staged.id) as { state: string };
    expect(row.state).toBe('committed');
    expect(getSession('verify-session-e2e')?.status).toBe('done');
  });
});
