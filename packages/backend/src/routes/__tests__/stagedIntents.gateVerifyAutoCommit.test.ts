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

const { createTaskMock } = vi.hoisted(() => ({
  createTaskMock: vi.fn(async () => 'notion:40722f91-52f3-8100-0000-00000000fe01'),
}));
vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn().mockReturnValue({
    type: 'notion',
    createTask: createTaskMock,
  }),
}));

// config.getProjectById lazy-`require`s ProjectService, which a native
// require cannot load as TypeScript under vitest — resolve it via ESM import.
const projectLookup = vi.hoisted(() => ({
  getById: undefined as undefined | ((id: string) => unknown),
}));
vi.mock('../../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config')>();
  return {
    ...actual,
    getProjectById: (id: string) => projectLookup.getById?.(id),
  };
});

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import {
  insertSession,
  getSession,
  setSessionMetadata,
} from '../../db/queries';
import { insertItem, appendEvent } from '../../gate/gateStore';
import {
  createStagedIntentsRouter,
  stageIntent,
  autoCommitGateVerifyIntent,
  sweepGateVerifyAutoCommitBacklogForMilestone,
  withdrawGateVerifyMirror,
} from '../stagedIntents';
import {
  appendGateItemEvent,
  configureGateVerifyIntentRetireSink,
} from '../../gate/gateService';
import { createMilestonesRouter } from '../milestones';
import { PlanningOrchestrator } from '../../orchestration/PlanningOrchestrator';
import { ProjectService } from '../../projects/ProjectService';

projectLookup.getById = (id) => ProjectService.getById(id);
import { upsertGateVerifyAutoCommitPolicy } from '../../db/queries';

function makeSessionManager() {
  const sm = new EventEmitter();
  return Object.assign(sm, {
    enqueueFeedback: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn(),
    getLiveSession: vi.fn().mockReturnValue(undefined),
  });
}

function seedVerifySession(
  sessionId: string,
  gateItemId: string,
  metadata: string | null = null,
) {
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
  if (metadata) setSessionMetadata(sessionId, JSON.parse(metadata));
}

function makeRunnableGateItem(
  overrides: Partial<Parameters<typeof insertItem>[0]> = {},
) {
  const item = insertItem({
    project: 'proj-auto-commit',
    milestone: 'M12',
    text: 'Confirm the export job completes',
    classification: 'Read-Only',
    sources: [{ sourceTaskId: 'notion:xyz', sourceTaskTitle: 'Export job' }],
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  });
  db.prepare(`UPDATE gate_item SET state = 'runnable' WHERE id = ?`).run(
    item.id,
  );
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
      sourceId: 'db00d3a1-aaaa-bbbb-cccc-1234567890ac',
    });
  }
  createTaskMock.mockClear();
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
    await autoCommitGateVerifyIntent(
      staged as any,
      sm as any,
      planningOrchestrator,
    );

    const row = db
      .prepare('SELECT state, annotation FROM staged_intent WHERE id = ?')
      .get(staged.id) as { state: string; annotation: string | null };
    expect(row.state).toBe('committed');
    expect(JSON.parse(row.annotation ?? '{}')).toEqual({ autoCommitted: true });

    const sessionRow = getSession('verify-session-1');
    expect(sessionRow?.status).toBe('done');
  });

  it.each([
    ['pass', '{"gateVerifyUnattended":true}', 1],
    ['needs-setup', '{"gateVerifyUnattended":true}', 1],
    ['fail', '{"gateVerifyUnattended":true}', 1],
    ['pass', '{"gateVerifyUnattended":false}', 0],
    ['fail', null, 0],
  ] as const)(
    'records the dispatch origin on the gate_item_event: %s with metadata %s -> unattended=%i',
    async (disposition, metadata, expected) => {
      const item = makeRunnableGateItem();
      if (disposition === 'fail') {
        // A prior open fix task lets the reconciler dedup instead of filing one.
        appendEvent(item.id, {
          disposition: 'fail',
          filedFollowon: 'notion:40722f91-52f3-8100-0000-0000000000f1',
          at: new Date(0).toISOString(),
        });
      }
      seedVerifySession('verify-session-origin', item.id, metadata);
      upsertGateVerifyAutoCommitPolicy('M12', disposition, true, Date.now());

      const sm = makeSessionManager();
      const planningOrchestrator = new PlanningOrchestrator(sm as any);
      createStagedIntentsRouter(planningOrchestrator, sm as any);

      const staged = stageIntent(
        'gate.verify',
        { gateItemId: item.id, disposition },
        'proj-auto-commit',
        null,
        'verify-session-origin',
        `Gate item ${item.id}: reported ${disposition}`,
        null,
        null,
        item.milestone,
        null,
      );
      await autoCommitGateVerifyIntent(
        staged as any,
        sm as any,
        planningOrchestrator,
      );

      const row = db
        .prepare(
          'SELECT unattended FROM gate_item_event WHERE gate_item_id = ? AND disposition = ? ORDER BY id DESC',
        )
        .get(item.id, disposition) as { unattended: number } | undefined;
      expect(row?.unattended).toBe(expected);
    },
  );

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

  describe('reclassify-carrying needs-setup', () => {
    async function stageReclassifyNeedsSetup(armed: boolean) {
      const item = makeRunnableGateItem();
      seedVerifySession('verify-session-rc', item.id);
      if (armed) {
        upsertGateVerifyAutoCommitPolicy(
          'M12',
          'needs-setup',
          true,
          Date.now(),
        );
      }
      const sm = makeSessionManager();
      const planningOrchestrator = new PlanningOrchestrator(sm as any);
      createStagedIntentsRouter(planningOrchestrator, sm as any);
      const staged = stageIntent(
        'gate.verify',
        {
          gateItemId: item.id,
          disposition: 'needs-setup',
          evidence: { note: 'x' },
          reclassify: { to: 'Human-Observation', reason: 'needs a human eye' },
        },
        'proj-auto-commit',
        null,
        'verify-session-rc',
        `Gate item ${item.id}: reported needs-setup`,
        null,
        null,
        item.milestone,
        null,
      );
      return { item, staged, sm, planningOrchestrator };
    }

    it('commits needs-setup, keeps classification, releases the session and stages one session-free reclassify decision', async () => {
      const { item, staged, sm, planningOrchestrator } =
        await stageReclassifyNeedsSetup(true);
      await autoCommitGateVerifyIntent(
        staged as any,
        sm as any,
        planningOrchestrator,
      );

      const event = db
        .prepare(
          `SELECT evidence FROM gate_item_event WHERE gate_item_id = ? AND disposition = 'needs-setup'`,
        )
        .get(item.id) as { evidence: string };
      expect(JSON.parse(event.evidence).proposedReclassify).toEqual({
        to: 'Human-Observation',
        reason: 'needs a human eye',
      });
      const cls = db
        .prepare('SELECT classification FROM gate_item WHERE id = ?')
        .get(item.id) as { classification: string };
      expect(cls.classification).toBe('Read-Only');
      expect(getSession('verify-session-rc')?.status).toBe('done');

      const rows = db
        .prepare(
          `SELECT session_id, milestone, payload FROM staged_intent WHERE kind = 'gate.verify' AND json_extract(payload, '$.origin') = 'reclassify'`,
        )
        .all() as {
        session_id: string | null;
        milestone: string;
        payload: string;
      }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].session_id).toBeNull();
      expect(rows[0].milestone).toBe('M12');
      expect(JSON.parse(rows[0].payload).reclassify.to).toBe(
        'Human-Observation',
      );
    });

    it('approving the reclassify intent reclassifies without a disposition event; it is never auto-committed', async () => {
      const { item, staged, sm, planningOrchestrator } =
        await stageReclassifyNeedsSetup(true);
      await autoCommitGateVerifyIntent(
        staged as any,
        sm as any,
        planningOrchestrator,
      );
      const rc = db
        .prepare(
          `SELECT * FROM staged_intent WHERE json_extract(payload, '$.origin') = 'reclassify'`,
        )
        .get() as any;
      expect(
        await autoCommitGateVerifyIntent(rc, sm as any, planningOrchestrator),
      ).toBe(false);

      const eventsBefore = (
        db
          .prepare(
            'SELECT COUNT(*) AS n FROM gate_item_event WHERE gate_item_id = ?',
          )
          .get(item.id) as { n: number }
      ).n;
      const app = express();
      app.use(express.json());
      app.use(
        '/api',
        createStagedIntentsRouter(planningOrchestrator, sm as any),
      );
      const res = await supertest(app).post(
        `/api/staged-intents/${rc.id}/apply`,
      );
      expect(res.status).toBe(200);
      const cls = db
        .prepare('SELECT classification FROM gate_item WHERE id = ?')
        .get(item.id) as { classification: string };
      expect(cls.classification).toBe('Human-Observation');
      const dispositionEvents = db
        .prepare(
          `SELECT COUNT(*) AS n FROM gate_item_event WHERE gate_item_id = ? AND disposition IN ('pass', 'fail', 'deferred')`,
        )
        .get(item.id) as { n: number };
      expect(dispositionEvents.n).toBe(0);
      const needsSetupEvents = db
        .prepare(
          `SELECT COUNT(*) AS n FROM gate_item_event WHERE gate_item_id = ? AND disposition = 'needs-setup'`,
        )
        .get(item.id) as { n: number };
      expect(needsSetupEvents.n).toBe(1);
      expect(eventsBefore).toBeGreaterThan(0);
    });

    it('rejecting the reclassify intent leaves the classification unchanged', async () => {
      const { item, staged, sm, planningOrchestrator } =
        await stageReclassifyNeedsSetup(true);
      await autoCommitGateVerifyIntent(
        staged as any,
        sm as any,
        planningOrchestrator,
      );
      const rc = db
        .prepare(
          `SELECT id FROM staged_intent WHERE json_extract(payload, '$.origin') = 'reclassify'`,
        )
        .get() as { id: string };
      const app = express();
      app.use(express.json());
      app.use(
        '/api',
        createStagedIntentsRouter(planningOrchestrator, sm as any),
      );
      const res = await supertest(app)
        .post(`/api/staged-intents/${rc.id}/reject`)
        .send({ outcome: 'decline', reason: 'keep as is' });
      expect(res.status).toBe(200);
      const cls = db
        .prepare(
          'SELECT classification, latest_disposition FROM gate_item WHERE id = ?',
        )
        .get(item.id) as { classification: string; latest_disposition: string };
      expect(cls.classification).toBe('Read-Only');
      expect(cls.latest_disposition).toBe('needs-setup');
    });

    it('does not auto-commit a reclassify carried with a non-needs-setup disposition', async () => {
      const item = makeRunnableGateItem();
      seedVerifySession('verify-session-rc-pass', item.id);
      upsertGateVerifyAutoCommitPolicy('M12', 'pass', true, Date.now());
      const sm = makeSessionManager();
      const planningOrchestrator = new PlanningOrchestrator(sm as any);
      createStagedIntentsRouter(planningOrchestrator, sm as any);
      const staged = stageIntent(
        'gate.verify',
        {
          gateItemId: item.id,
          disposition: 'pass',
          reclassify: { to: 'Human-Observation', reason: 'x' },
        },
        'proj-auto-commit',
        null,
        'verify-session-rc-pass',
        `Gate item ${item.id}: reported pass`,
        null,
        null,
        item.milestone,
        null,
      );
      expect(
        await autoCommitGateVerifyIntent(
          staged as any,
          sm as any,
          planningOrchestrator,
        ),
      ).toBe(false);
      const row = db
        .prepare('SELECT state FROM staged_intent WHERE id = ?')
        .get(staged.id) as { state: string };
      expect(row.state).toBe('staged');
    });

    it('arming needs-setup sweeps a staged reclassify-carrying backlog and ignores reclassify-origin intents', async () => {
      const { item, staged } = await stageReclassifyNeedsSetup(false);
      expect(
        (
          db
            .prepare('SELECT state FROM staged_intent WHERE id = ?')
            .get(staged.id) as { state: string }
        ).state,
      ).toBe('staged');

      upsertGateVerifyAutoCommitPolicy('M12', 'needs-setup', true, Date.now());
      const swept = await sweepGateVerifyAutoCommitBacklogForMilestone(
        'M12',
        'needs-setup',
      );
      expect(swept.committedIds).toEqual([staged.id]);

      const rcRows = db
        .prepare(
          `SELECT id, state FROM staged_intent WHERE json_extract(payload, '$.origin') = 'reclassify'`,
        )
        .all() as { id: string; state: string }[];
      expect(rcRows).toHaveLength(1);
      expect(rcRows[0].state).toBe('staged');
      const again = await sweepGateVerifyAutoCommitBacklogForMilestone(
        'M12',
        'needs-setup',
      );
      expect(again.committedIds).toEqual([]);
      const cls = db
        .prepare('SELECT classification FROM gate_item WHERE id = ?')
        .get(item.id) as { classification: string };
      expect(cls.classification).toBe('Read-Only');
    });

    it('stays staged when needs-setup is disarmed', async () => {
      const { staged, sm, planningOrchestrator } =
        await stageReclassifyNeedsSetup(false);
      expect(
        await autoCommitGateVerifyIntent(
          staged as any,
          sm as any,
          planningOrchestrator,
        ),
      ).toBe(false);
    });
  });

  it('files the follow-up fix task with the reported proposedFix title/summary on an auto-committed fail', async () => {
    const item = makeRunnableGateItem();
    seedVerifySession('verify-session-proposed-fix', item.id);
    upsertGateVerifyAutoCommitPolicy('M12', 'fail', true, Date.now());

    const sm = makeSessionManager();
    const planningOrchestrator = new PlanningOrchestrator(sm as any);
    createStagedIntentsRouter(planningOrchestrator, sm as any);

    const staged = stageIntent(
      'gate.verify',
      {
        gateItemId: item.id,
        disposition: 'fail',
        proposedFix: {
          title: 'Fix the missing audit write',
          cause: {
            file: 'packages/backend/src/endpoint.ts',
            line: 7,
            condition: 'the success path returns before the audit write',
          },
          input: 'request 99 on 2026-10-14',
          fix: 'write the audit_log row before returning',
          filesAffected: ['packages/backend/src/endpoint.ts'],
          automatedCriteria: ['a successful call writes an audit_log row'],
        },
      },
      'proj-auto-commit',
      null,
      'verify-session-proposed-fix',
      `Gate item ${item.id}: reported fail`,
      null,
      null,
      item.milestone,
      null,
    );

    await autoCommitGateVerifyIntent(
      staged as any,
      sm as any,
      planningOrchestrator,
    );

    expect(createTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Fix the missing audit write' }),
    );
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

describe('gate.verify auto-commit — with the real retire sink wired', () => {
  beforeEach(() => {
    configureGateVerifyIntentRetireSink({
      retireGenuineIntent(intentId, _sessionId, reason) {
        withdrawGateVerifyMirror(intentId, reason);
      },
    });
  });

  function auditRows(intentId: string) {
    return (
      db
        .prepare(
          `SELECT payload FROM audit_log WHERE event_type = 'staged_intent_disposition'`,
        )
        .all() as { payload: string }[]
    )
      .map((r) => JSON.parse(r.payload))
      .filter((p) => p.intent_id === intentId || p.intentId === intentId);
  }

  for (const disposition of ['pass', 'fail', 'not-yet-triggerable'] as const) {
    it(`auto-committed ${disposition} ends committed with autoCommitted provenance`, async () => {
      const item = makeRunnableGateItem();
      const sid = `verify-session-sink-${disposition}`;
      seedVerifySession(sid, item.id);
      upsertGateVerifyAutoCommitPolicy('M12', disposition, true, Date.now());

      const sm = makeSessionManager();
      const planningOrchestrator = new PlanningOrchestrator(sm as any);
      const handleSpy = vi.spyOn(planningOrchestrator, 'handleDisposition');
      createStagedIntentsRouter(planningOrchestrator, sm as any);

      const staged = stageIntent(
        'gate.verify',
        {
          gateItemId: item.id,
          disposition,
          evidence: 'observed no trigger',
          ...(disposition === 'fail'
            ? {
                proposedFix: {
                  title: 'Fix the missing trigger',
                  cause: {
                    file: 'packages/backend/src/endpoint.ts',
                    line: 7,
                    condition: 'the trigger path never fires',
                  },
                  input: 'request 99 on 2026-10-14',
                  fix: 'fire the trigger on the success path',
                  filesAffected: ['packages/backend/src/endpoint.ts'],
                  automatedCriteria: ['a successful call fires the trigger'],
                },
              }
            : {}),
        },
        'proj-auto-commit',
        null,
        sid,
        `Gate item ${item.id}: reported ${disposition}`,
        null,
        null,
        item.milestone,
        null,
      );
      await autoCommitGateVerifyIntent(
        staged as any,
        sm as any,
        planningOrchestrator,
      );

      const row = db
        .prepare('SELECT state, annotation FROM staged_intent WHERE id = ?')
        .get(staged.id) as { state: string; annotation: string | null };
      expect(row.state).toBe('committed');
      expect(JSON.parse(row.annotation ?? '{}')).toEqual({
        autoCommitted: true,
      });
      expect(
        auditRows(staged.id).filter((p) => p.disposition === 'auto_committed'),
      ).toHaveLength(1);
      expect(handleSpy).toHaveBeenCalledWith(
        expect.objectContaining({ disposition: 'approve' }),
      );
      if (disposition === 'fail') {
        expect(createTaskMock).toHaveBeenCalledTimes(1);
      }
    });
  }

  it('an operator commit through the per-intent apply route ends committed, not withdrawn', async () => {
    const item = makeRunnableGateItem();
    seedVerifySession('verify-session-sink-op', item.id);

    const sm = makeSessionManager();
    const planningOrchestrator = new PlanningOrchestrator(sm as any);
    const app = express();
    app.use(express.json());
    app.use('/api', createStagedIntentsRouter(planningOrchestrator, sm as any));

    const staged = stageIntent(
      'gate.verify',
      { gateItemId: item.id, disposition: 'pass' },
      'proj-auto-commit',
      null,
      'verify-session-sink-op',
      `Gate item ${item.id}: reported pass`,
      null,
      null,
      item.milestone,
      null,
    );

    const res = await supertest(app).post(
      `/api/staged-intents/${staged.id}/apply`,
    );
    expect(res.status).toBe(200);
    const row = db
      .prepare('SELECT state FROM staged_intent WHERE id = ?')
      .get(staged.id) as { state: string };
    expect(row.state).toBe('committed');
  });

  it('a direct pass on an item whose verifier intent is still staged still withdraws it', async () => {
    const item = makeRunnableGateItem();
    seedVerifySession('verify-session-sink-direct', item.id);

    const sm = makeSessionManager();
    const planningOrchestrator = new PlanningOrchestrator(sm as any);
    createStagedIntentsRouter(planningOrchestrator, sm as any);

    const staged = stageIntent(
      'gate.verify',
      { gateItemId: item.id, disposition: 'pass' },
      'proj-auto-commit',
      null,
      'verify-session-sink-direct',
      `Gate item ${item.id}: reported pass`,
      null,
      null,
      item.milestone,
      null,
    );

    appendGateItemEvent(item.id, { disposition: 'pass', operator: 'jane' });

    const row = db
      .prepare(
        'SELECT state, disposition_reason FROM staged_intent WHERE id = ?',
      )
      .get(staged.id) as { state: string; disposition_reason: string | null };
    expect(row.state).toBe('withdrawn');
    expect(row.disposition_reason).toMatch(/direct disposition/);
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
      (
        db
          .prepare('SELECT state FROM staged_intent WHERE id = ?')
          .get(staged1.id) as any
      ).state,
    ).toBe('staged');
    expect(
      (
        db
          .prepare('SELECT state FROM staged_intent WHERE id = ?')
          .get(staged2.id) as any
      ).state,
    ).toBe('staged');

    const swept = await sweepGateVerifyAutoCommitBacklogForMilestone(
      'M12',
      'pass',
    );
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
      (
        db
          .prepare('SELECT state FROM staged_intent WHERE id = ?')
          .get(staged1.id) as any
      ).state,
    ).toBe('committed');
    expect(
      (
        db
          .prepare('SELECT state FROM staged_intent WHERE id = ?')
          .get(staged2.id) as any
      ).state,
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
    stagedApp.use(
      '/api',
      createStagedIntentsRouter(planningOrchestrator, sm as any),
    );

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
      (
        db
          .prepare('SELECT state FROM staged_intent WHERE id = ?')
          .get(staged.id) as any
      ).state,
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

  it('end-to-end: arming via the milestone DB board UUID (as the arm UI does) still auto-commits a subsequently-staged matching intent', async () => {
    const item = makeRunnableGateItem({ text: 'UUID-armed item' });
    seedVerifySession('verify-session-uuid-armed', item.id);

    const milestonesApp = express();
    milestonesApp.use(express.json());
    milestonesApp.use('/api', createMilestonesRouter());

    // The arm UI passes the milestone's DB board UUID, not its canonical
    // short id ('M12'), as :milestoneId.
    const armRes = await supertest(milestonesApp)
      .put('/api/milestones/ms-uuid-auto-commit-m12/auto-commit-policy/pass')
      .send({ armed: true });
    expect(armRes.status).toBe(200);
    expect(armRes.body.armed).toBe(true);

    const sm = makeSessionManager();
    const planningOrchestrator = new PlanningOrchestrator(sm as any);
    const stagedApp = express();
    stagedApp.use(express.json());
    stagedApp.use(
      '/api',
      createStagedIntentsRouter(planningOrchestrator, sm as any),
    );

    const staged = stageIntent(
      'gate.verify',
      { gateItemId: item.id, disposition: 'pass' },
      'proj-auto-commit',
      null,
      'verify-session-uuid-armed',
      `Gate item ${item.id}: reported pass`,
      null,
      null,
      item.milestone,
      null,
    );

    await autoCommitGateVerifyIntent(
      staged as any,
      sm as any,
      planningOrchestrator,
    );

    const row = db
      .prepare('SELECT state FROM staged_intent WHERE id = ?')
      .get(staged.id) as { state: string };
    expect(row.state).toBe('committed');
    expect(getSession('verify-session-uuid-armed')?.status).toBe('done');
  });
});
