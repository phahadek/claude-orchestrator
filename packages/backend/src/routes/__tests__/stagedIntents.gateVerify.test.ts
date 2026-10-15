/**
 * Tests for the gate.verify staged-intent kind: a gate-verify session's
 * reported disposition lands as a normal staged intent, and only an
 * operator's approval (never the session, never the backend automatically)
 * turns it into a gate_item_event write — see the task "Retire the
 * gate-verify adjudication layer".
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const STRUCTURED_FIX = {
  title: 'Write the missing env var in the deploy script',
  cause: {
    file: 'scripts/deploy.sh',
    line: 42,
    condition: 'the env block is skipped when DRY_RUN is unset',
  },
  input: 'deploy run 7 on 2026-10-14 with DRY_RUN unset',
  fix: 'write NEW_ENV_VAR whenever DRY_RUN is unset',
  filesAffected: ['scripts/deploy.sh'],
  automatedCriteria: ['deploy.sh writes NEW_ENV_VAR when DRY_RUN is unset'],
};

const { createTaskMock } = vi.hoisted(() => ({
  createTaskMock: vi.fn(async () => 'notion:new-followup-task'),
}));
vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn().mockReturnValue({
    type: 'notion',
    createTask: createTaskMock,
  }),
}));

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import { upsertTaskCache } from '../../db/queries.js';
import {
  insertItem,
  getItem,
  setMinDeployedCommit,
  setSourceMergeCommit,
} from '../../gate/gateStore.js';
import { reconcileGateRunnability } from '../../gate/gateService.js';
import {
  configureGateItemMirrorSink,
  reconcileHumanObservationMirrors,
} from '../../gate/gateReconciler.js';
import { createStagedIntentsRouter, stageIntent } from '../stagedIntents';
import { PLANNING_INTENT_KINDS } from '../../planning/planningIntentKinds';
import { KNOWN_INTENT_KINDS } from '../stagedIntents';
import { ProjectService } from '../../projects/ProjectService.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter());
  return app;
}

function makeGateItem(
  overrides: Partial<Parameters<typeof insertItem>[0]> = {},
) {
  return insertItem({
    project: 'proj-a',
    milestone: 'M12',
    text: 'the record is admitted for auto-dispatch with no manual DB intervention',
    classification: 'Read-Only',
    sources: [{ sourceTaskId: 'notion:abc', sourceTaskTitle: 'Some task' }],
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  });
}

// M13's row id below deliberately mirrors the legacy composite id-space
// (`<projectId>:<notionBoardId>`) production milestones M1-M3 carry — the
// same shape the old boardId fallback silently handed to createTask as a
// Notion database id. Its canonical_short_id ('M13') is what
// gate_item.milestone actually stores in production, and its sourceId is a
// distinct, valid-looking Notion database id — so a test that resolved via
// the retired board.id/name lookup (or the boardId fallback) would either
// miss entirely or hand createTask the wrong id, not vacuously pass.
const M13_SOURCE_ID = 'db00d3a1-aaaa-bbbb-cccc-1234567890ab';

beforeAll(() => {
  ProjectService.create({
    id: 'proj-a',
    name: 'Project A',
    projectDir: '/tmp/proj-a',
  });
  ProjectService.createMilestone({
    id: 'proj-a:legacyboard13',
    projectId: 'proj-a',
    name: 'M13',
    canonicalShortId: 'M13',
    sourceId: M13_SOURCE_ID,
  });
});

beforeEach(() => {
  db.prepare('DELETE FROM gate_item_event').run();
  db.prepare('DELETE FROM gate_item_source').run();
  db.prepare('DELETE FROM gate_item').run();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM audit_log').run();
  createTaskMock.mockClear();
});

describe('gate.verify — intent-kind registration', () => {
  it('is a genuine PLANNING_INTENT_KINDS.ops staged-intent kind and a known intent kind', () => {
    expect(PLANNING_INTENT_KINDS.ops).toContain('gate.verify');
    expect(KNOWN_INTENT_KINDS.has('gate.verify')).toBe(true);
  });
});

describe('gate.verify — stage then apply', () => {
  it('stages, and only records the gate_item_event on operator approval — with the reported disposition/evidence unmodified', async () => {
    const item = makeGateItem();
    const app = makeApp();
    const agent = supertest(app);

    const verbatimEvidence = {
      basis: 'operational',
      note:
        'queried audit_log with a windowed since/until range; there are no ' +
        'audit_log rows of any kind for this task in between, confirming ' +
        'no manual database intervention occurred.',
    };

    const staged = await agent.post('/api/staged-intents').send({
      kind: 'gate.verify',
      projectId: 'proj-a',
      payload: {
        gateItemId: item.id,
        disposition: 'pass',
        evidence: verbatimEvidence,
      },
    });
    expect(staged.status).toBe(201);
    expect(staged.body.state).toBe('staged');

    // Nothing written to the gate item yet — staging alone never mutates
    // gate state.
    expect(getItem(item.id)?.currentDisposition).toBeUndefined();

    const approved = await agent
      .post(`/api/staged-intents/${staged.body.id}/approve`)
      .send({});
    expect(approved.status).toBe(200);

    const applied = await agent
      .post(`/api/staged-intents/${staged.body.id}/apply`)
      .send({});
    expect(applied.status).toBe(200);

    const updated = getItem(item.id);
    expect(updated?.events.at(-1)).toMatchObject({
      disposition: 'pass',
      evidence: verbatimEvidence,
    });

    const row = db
      .prepare('SELECT state FROM staged_intent WHERE id = ?')
      .get(staged.body.id) as { state: string };
    expect(row.state).toBe('committed');
  });

  it('a genuinely abstaining needs-setup verdict leaves state and current_disposition untouched on apply', async () => {
    const item = makeGateItem();
    const app = makeApp();
    const agent = supertest(app);

    const staged = await agent.post('/api/staged-intents').send({
      kind: 'gate.verify',
      projectId: 'proj-a',
      payload: {
        gateItemId: item.id,
        disposition: 'needs-setup',
        evidence: { reason: 'ran out of turn budget' },
      },
    });
    await agent.post(`/api/staged-intents/${staged.body.id}/approve`).send({});
    await agent.post(`/api/staged-intents/${staged.body.id}/apply`).send({});

    const updated = getItem(item.id);
    expect(updated?.state).toBe(item.state);
    expect(updated?.currentDisposition).toBeUndefined();
    expect(updated?.events.at(-1)).toMatchObject({
      disposition: 'needs-setup',
    });
  });

  it('a rejection routes the intent to needs_revision — a normal turn for the session to revise, with no appeal cap', async () => {
    const item = makeGateItem();
    const app = makeApp();
    const agent = supertest(app);

    const staged = await agent.post('/api/staged-intents').send({
      kind: 'gate.verify',
      projectId: 'proj-a',
      payload: {
        gateItemId: item.id,
        disposition: 'pass',
        evidence: { basis: 'source', note: 'read the component' },
      },
    });

    const rejected = await agent
      .post(`/api/staged-intents/${staged.body.id}/reject`)
      .send({
        outcome: 'pushback',
        reason: 'this is source-only, not operational evidence',
      });
    expect(rejected.status).toBe(200);

    const row = db
      .prepare('SELECT state FROM staged_intent WHERE id = ?')
      .get(staged.body.id) as { state: string };
    expect(['needs_revision', 'rejected']).toContain(row.state);

    // No gate_item_event was ever written for the rejected intent.
    expect(getItem(item.id)?.events).toHaveLength(0);

    // The session can re-stage a revised gate.verify for the same item —
    // no cap on revisions, unlike the retired one-shot appeal.
    const restaged = await agent.post('/api/staged-intents').send({
      kind: 'gate.verify',
      projectId: 'proj-a',
      payload: {
        gateItemId: item.id,
        disposition: 'pass',
        evidence: { basis: 'operational', note: 'audit_log confirms it' },
      },
    });
    expect(restaged.status).toBe(201);

    // And that revised report can itself be pushed back on again — a
    // second round, still accepted.
    const rejectedAgain = await agent
      .post(`/api/staged-intents/${restaged.body.id}/reject`)
      .send({
        outcome: 'pushback',
        reason: 'still not enough — cite the specific row',
      });
    expect(rejectedAgain.status).toBe(200);
  });
});

describe('gate.verify — requires a full gate item id', () => {
  it('rejects an 8-character short form at stage time, naming the expected full-uuid shape', async () => {
    const item = makeGateItem();
    const app = makeApp();
    const agent = supertest(app);

    const staged = await agent.post('/api/staged-intents').send({
      kind: 'gate.verify',
      projectId: 'proj-a',
      payload: {
        gateItemId: item.id.slice(0, 8),
        disposition: 'pass',
        evidence: { basis: 'operational', note: 'checked audit_log' },
      },
    });

    expect(staged.status).toBe(400);
    expect(staged.body.error).toMatch(/full gate item id/i);
    expect(staged.body.error).toMatch(/uuid/i);

    // No gate state or staged-intent row was written for the rejected call.
    expect(getItem(item.id)?.events).toHaveLength(0);
    const rows = db
      .prepare('SELECT COUNT(*) as n FROM staged_intent')
      .get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it('accepts a full gate item uuid unchanged', async () => {
    const item = makeGateItem();
    const app = makeApp();
    const agent = supertest(app);

    const staged = await agent.post('/api/staged-intents').send({
      kind: 'gate.verify',
      projectId: 'proj-a',
      payload: {
        gateItemId: item.id,
        disposition: 'pass',
        evidence: { basis: 'operational', note: 'checked audit_log' },
      },
    });

    expect(staged.status).toBe(201);
    expect(staged.body.state).toBe('staged');
  });
});

describe('gate.verify — fail disposition files a follow-up task via resolveMilestoneSourceId', () => {
  it('applies cleanly and reaches appendGateItemEvent, with no routeApplyTimeFailure pushback (regression for the 2026-08-01 auto-rejections)', async () => {
    const item = makeGateItem({ milestone: 'M13' });
    const app = makeApp();
    const agent = supertest(app);

    const staged = await agent.post('/api/staged-intents').send({
      kind: 'gate.verify',
      projectId: 'proj-a',
      payload: {
        gateItemId: item.id,
        disposition: 'fail',
        evidence: { basis: 'operational', note: 'the env var is missing' },
        proposedFix: STRUCTURED_FIX,
      },
    });
    expect(staged.status).toBe(201);

    await agent.post(`/api/staged-intents/${staged.body.id}/approve`).send({});
    const applied = await agent
      .post(`/api/staged-intents/${staged.body.id}/apply`)
      .send({});

    // Before the fix, resolveMilestoneSourceId's boardId fallback would
    // hand createTask the legacy composite milestone row id instead of a
    // Notion database id, the real backend would reject it, and this apply
    // would come back 500 with redrivenToSession — exactly what happened to
    // the five gate items auto-rejected on 2026-08-01.
    expect(applied.status).toBe(200);
    expect(applied.body.redrivenToSession).toBeUndefined();

    expect(createTaskMock).toHaveBeenCalledTimes(1);
    expect(createTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({ databaseId: M13_SOURCE_ID }),
    );

    const updated = getItem(item.id);
    expect(updated?.events.at(-1)).toMatchObject({ disposition: 'fail' });

    const row = db
      .prepare('SELECT state FROM staged_intent WHERE id = ?')
      .get(staged.body.id) as { state: string };
    expect(row.state).toBe('committed');
  });

  it('uses the reported proposedFix title/summary for the filed task, in place of the generic boilerplate', async () => {
    const item = makeGateItem({ milestone: 'M13' });
    const app = makeApp();
    const agent = supertest(app);

    const staged = await agent.post('/api/staged-intents').send({
      kind: 'gate.verify',
      projectId: 'proj-a',
      payload: {
        gateItemId: item.id,
        disposition: 'fail',
        evidence: { basis: 'operational', note: 'the env var is missing' },
        proposedFix: STRUCTURED_FIX,
      },
    });
    expect(staged.status).toBe(201);

    await agent.post(`/api/staged-intents/${staged.body.id}/approve`).send({});
    const applied = await agent
      .post(`/api/staged-intents/${staged.body.id}/apply`)
      .send({});

    expect(applied.status).toBe(200);
    expect(createTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: STRUCTURED_FIX.title,
        body: expect.stringContaining('scripts/deploy.sh:42'),
      }),
    );
  });

  it('records the fail and files nothing when no proposedFix is reported', async () => {
    const item = makeGateItem({ milestone: 'M13' });
    const app = makeApp();
    const agent = supertest(app);

    const staged = await agent.post('/api/staged-intents').send({
      kind: 'gate.verify',
      projectId: 'proj-a',
      payload: {
        gateItemId: item.id,
        disposition: 'fail',
        evidence: { basis: 'operational', note: 'the env var is missing' },
      },
    });
    expect(staged.status).toBe(201);

    await agent.post(`/api/staged-intents/${staged.body.id}/approve`).send({});
    const applied = await agent
      .post(`/api/staged-intents/${staged.body.id}/apply`)
      .send({});

    expect(applied.status).toBe(200);
    expect(createTaskMock).not.toHaveBeenCalled();
    expect(getItem(item.id)?.events.at(-1)).toMatchObject({
      disposition: 'fail',
    });
  });
});

describe('gate.verify — stage-time proposedFix validation', () => {
  let repoDir: string;

  // A plain checkout directory, not a real git repo — the stage-time check
  // is a filesystem existence check (existsInRepoCheckout in stagedIntents.ts),
  // not a `git ls-files` shell-out, so no `git init`/`git add` is needed to
  // make `scripts/deploy.sh` resolve as "tracked". A bare `.git` marker
  // directory is still required: isGitCheckoutSync gates the whole check on
  // a direct `.git` entry so a project whose configured projectDir doesn't
  // exist (or happens to exist as unrelated bare directory on a long-lived
  // host) is never mistaken for a real checkout.
  beforeAll(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'gate-verify-repo-'));
    mkdirSync(join(repoDir, '.git'));
    mkdirSync(join(repoDir, 'scripts'));
    writeFileSync(join(repoDir, 'scripts', 'deploy.sh'), 'echo hi\n');
    ProjectService.create({
      id: 'proj-git',
      name: 'Project Git',
      projectDir: repoDir,
    });
    ProjectService.createMilestone({
      id: 'proj-git:m1',
      projectId: 'proj-git',
      name: 'M1',
      canonicalShortId: 'M1',
      sourceId: 'db00d3a1-aaaa-bbbb-cccc-1234567890ac',
    });
  });

  afterAll(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  function stageFail(item: { id: string }, proposedFix: unknown) {
    return () =>
      stageIntent(
        'gate.verify',
        { gateItemId: item.id, disposition: 'fail', proposedFix },
        'proj-git',
      );
  }

  const gitItem = () => makeGateItem({ project: 'proj-git', milestone: 'M1' });

  it('accepts tracked cause.file / filesAffected, with a *(new)* file exempt', () => {
    const item = gitItem();
    expect(
      stageFail(item, {
        ...STRUCTURED_FIX,
        filesAffected: ['scripts/deploy.sh', 'scripts/new.test.sh *(new)*'],
      }),
    ).not.toThrow();
  });

  it('rejects an untracked cause.file, naming the path', () => {
    const item = gitItem();
    expect(
      stageFail(item, {
        ...STRUCTURED_FIX,
        cause: { ...STRUCTURED_FIX.cause, file: 'scripts/missing.sh' },
      }),
    ).toThrow(/scripts\/missing\.sh/);
  });

  it('rejects an untracked non-new filesAffected entry, naming the path', () => {
    const item = gitItem();
    expect(
      stageFail(item, {
        ...STRUCTURED_FIX,
        filesAffected: ['scripts/deploy.sh', 'scripts/ghost.sh'],
      }),
    ).toThrow(/scripts\/ghost\.sh/);
  });

  it('rejects an existingTaskId that is truncated or not an open task on the board, and accepts a full open one', () => {
    const item = gitItem();
    upsertTaskCache(
      'board:proj-git:m1',
      JSON.stringify([
        { id: 'notion:aaaa1111bbbb2222cccc3333dddd4444', status: '🟡 Ready' },
        { id: 'notion:eeee1111ffff2222aaaa3333bbbb4444', status: '✅ Done' },
      ]),
    );
    expect(stageFail(item, { existingTaskId: 'notion:aaaa1111' })).toThrow(
      /existingTaskId/,
    );
    expect(
      stageFail(item, {
        existingTaskId: 'notion:eeee1111ffff2222aaaa3333bbbb4444',
      }),
    ).toThrow(/existingTaskId/);
    expect(
      stageFail(item, {
        existingTaskId: 'notion:aaaa1111bbbb2222cccc3333dddd4444',
      }),
    ).not.toThrow();
  });

  // Regression: a project whose configured projectDir exists on disk as a
  // bare directory (no `.git`) — e.g. stray leftover state on a long-lived
  // host, or simply a directory something else created — must not be
  // mistaken for a real checkout and have its unrelated contents checked
  // against cause.file/filesAffected.
  it('skips the tracked-file check for a projectDir that exists but is not a git checkout', () => {
    const bareDir = mkdtempSync(join(tmpdir(), 'gate-verify-bare-'));
    ProjectService.create({
      id: 'proj-bare-dir',
      name: 'Project Bare Dir',
      projectDir: bareDir,
    });
    ProjectService.createMilestone({
      id: 'proj-bare-dir:m1',
      projectId: 'proj-bare-dir',
      name: 'M1',
      canonicalShortId: 'M1',
      sourceId: 'db00d3a1-aaaa-bbbb-cccc-1234567890ad',
    });
    const item = makeGateItem({ project: 'proj-bare-dir', milestone: 'M1' });
    try {
      expect(() =>
        stageIntent(
          'gate.verify',
          {
            gateItemId: item.id,
            disposition: 'fail',
            proposedFix: STRUCTURED_FIX,
          },
          'proj-bare-dir',
        ),
      ).not.toThrow();
    } finally {
      rmSync(bareDir, { recursive: true, force: true });
    }
  });
});

describe('gate.verify — Human-Observation mirror apply (operator-supplied disposition)', () => {
  it('requires an operator-supplied mirrorDisposition — applying with none fails', async () => {
    const item = makeGateItem({ classification: 'Human-Observation' });
    const mirror = stageIntent(
      'gate.verify',
      { gateItemId: item.id, origin: 'mirror' },
      'proj-a',
      null,
      null,
      'Human-Observation mirror',
      null,
      null,
      'M13',
      null,
    );
    const app = makeApp();
    const agent = supertest(app);

    const applied = await agent
      .post(`/api/staged-intents/${mirror.id}/apply`)
      .send({});
    expect(applied.status).toBe(500);
    expect(getItem(item.id)?.events).toHaveLength(0);
  });

  it('rejects an unknown mirrorDisposition string — the widened union stays closed', async () => {
    const item = makeGateItem({ classification: 'Human-Observation' });
    const mirror = stageIntent(
      'gate.verify',
      { gateItemId: item.id, origin: 'mirror' },
      'proj-a',
      null,
      null,
      'Human-Observation mirror',
      null,
      null,
      'M13',
      null,
    );
    const app = makeApp();
    const agent = supertest(app);

    const applied = await agent
      .post(`/api/staged-intents/${mirror.id}/apply`)
      .send({ mirrorDisposition: 'parked' });
    expect(applied.status).toBe(500);
    expect(getItem(item.id)?.events).toHaveLength(0);
  });

  it('a mirrorDisposition of "pass" produces the exact same gate_item state as a direct GateReadinessPanel pass for the same item/evidence', async () => {
    const directItem = makeGateItem({ classification: 'Human-Observation' });
    const mirroredItem = makeGateItem({ classification: 'Human-Observation' });
    const evidence = { note: 'the banner renders in the correct brand blue' };

    // The direct GateReadinessPanel path: POST /gate/items/:id/events — a
    // human operator's freetext name (or none), never 'gate-verifier'
    // (routes/gateState.ts passes through whatever operatorName the panel's
    // input carries).
    const { appendGateItemEvent } = await import('../../gate/gateService.js');
    appendGateItemEvent(directItem.id, {
      disposition: 'pass',
      evidence,
      operator: 'jane',
    });

    const mirror = stageIntent(
      'gate.verify',
      { gateItemId: mirroredItem.id, origin: 'mirror' },
      'proj-a',
      null,
      null,
      'Human-Observation mirror',
      null,
      null,
      'M13',
      null,
    );
    const app = makeApp();
    const agent = supertest(app);
    const applied = await agent
      .post(`/api/staged-intents/${mirror.id}/apply`)
      .send({ mirrorDisposition: 'pass', mirrorEvidence: evidence });
    expect(applied.status).toBe(200);

    const direct = getItem(directItem.id);
    const mirrored = getItem(mirroredItem.id);
    expect(mirrored?.state).toBe(direct?.state);
    expect(mirrored?.currentDisposition).toBe(direct?.currentDisposition);
    expect(mirrored?.events.at(-1)).toMatchObject({
      disposition: 'pass',
      evidence,
    });

    const row = db
      .prepare('SELECT state, group_id FROM staged_intent WHERE id = ?')
      .get(mirror.id) as { state: string; group_id: string | null };
    expect(row.state).toBe('committed');
    expect(row.group_id).toBeNull();
  });

  it('a mirrorDisposition of "deferred" resolves the gate_item to deferred, matching GateReadinessPanel\'s direct-path Defer button', async () => {
    const item = makeGateItem({ classification: 'Human-Observation' });
    const mirror = stageIntent(
      'gate.verify',
      { gateItemId: item.id, origin: 'mirror' },
      'proj-a',
      null,
      null,
      'Human-Observation mirror',
      null,
      null,
      'M13',
      null,
    );
    const app = makeApp();
    const agent = supertest(app);
    const applied = await agent
      .post(`/api/staged-intents/${mirror.id}/apply`)
      .send({ mirrorDisposition: 'deferred' });
    expect(applied.status).toBe(200);

    expect(getItem(item.id)?.state).toBe('deferred');
  });

  it('a mirrorDisposition of "not-yet-triggerable" parks the gate_item at pending with a scheduled next_attempt_at, distinct from Defer\'s resolution', async () => {
    const item = makeGateItem({
      classification: 'Human-Observation',
      milestone: 'M13',
    });
    const mirror = stageIntent(
      'gate.verify',
      { gateItemId: item.id, origin: 'mirror' },
      'proj-a',
      null,
      null,
      'Human-Observation mirror',
      null,
      null,
      'M13',
      null,
    );
    const app = makeApp();
    const agent = supertest(app);
    const applied = await agent
      .post(`/api/staged-intents/${mirror.id}/apply`)
      .send({
        mirrorDisposition: 'not-yet-triggerable',
        mirrorEvidence: { note: 'the trigger scenario has not occurred yet' },
      });
    expect(applied.status).toBe(200);

    const updated = getItem(item.id);
    expect(updated?.state).toBe('pending');
    expect(updated?.state).not.toBe('deferred');
    expect(updated?.nextAttemptAt).toBeDefined();
    expect(updated?.pendingAttemptCount).toBe(1);
  });

  it('a parked mirror item is returned by nextPendingGateItems once its backoff elapses', async () => {
    const item = makeGateItem({
      classification: 'Human-Observation',
      milestone: 'M13',
    });
    const mirror = stageIntent(
      'gate.verify',
      { gateItemId: item.id, origin: 'mirror' },
      'proj-a',
      null,
      null,
      'Human-Observation mirror',
      null,
      null,
      'M13',
      null,
    );
    const app = makeApp();
    const agent = supertest(app);
    await agent.post(`/api/staged-intents/${mirror.id}/apply`).send({
      mirrorDisposition: 'not-yet-triggerable',
      mirrorEvidence: { note: 'not yet triggerable' },
    });

    const { nextPendingGateItems } = await import('../../gate/gateService.js');

    // Backoff hasn't elapsed yet — not returned.
    expect(
      nextPendingGateItems('proj-a', 'M13').map((i) => i.id),
    ).not.toContain(item.id);

    // Force the schedule into the past so it's due, mirroring how a real
    // backoff eventually elapses.
    db.prepare('UPDATE gate_item SET next_attempt_at = ? WHERE id = ?').run(
      new Date(0).toISOString(),
      item.id,
    );
    expect(nextPendingGateItems('proj-a', 'M13').map((i) => i.id)).toContain(
      item.id,
    );
  });

  it("a parked mirror item is counted in gate readiness's parked bucket, not its blocking set", async () => {
    const item = makeGateItem({
      classification: 'Human-Observation',
      milestone: 'M13',
    });
    const mirror = stageIntent(
      'gate.verify',
      { gateItemId: item.id, origin: 'mirror' },
      'proj-a',
      null,
      null,
      'Human-Observation mirror',
      null,
      null,
      'M13',
      null,
    );
    const app = makeApp();
    const agent = supertest(app);
    await agent.post(`/api/staged-intents/${mirror.id}/apply`).send({
      mirrorDisposition: 'not-yet-triggerable',
      mirrorEvidence: { note: 'not yet triggerable' },
    });

    const { getGateReadiness } = await import('../../gate/gateService.js');
    const readiness = getGateReadiness('proj-a', 'M13');
    expect(readiness.parked.map((i) => i.id)).toContain(item.id);
    expect(readiness.blocking.map((i) => i.id)).not.toContain(item.id);
  });

  it('a mirrorDisposition of "fail" re-opens the item via the same follow-up-filing path as a direct fail', async () => {
    const item = makeGateItem({
      classification: 'Human-Observation',
      milestone: 'M13',
    });
    const mirror = stageIntent(
      'gate.verify',
      { gateItemId: item.id, origin: 'mirror' },
      'proj-a',
      null,
      null,
      'Human-Observation mirror',
      null,
      null,
      'M13',
      null,
    );
    const app = makeApp();
    const agent = supertest(app);
    const applied = await agent
      .post(`/api/staged-intents/${mirror.id}/apply`)
      .send({
        mirrorDisposition: 'fail',
        mirrorEvidence: { note: 'the banner is the wrong colour' },
      });
    expect(applied.status).toBe(200);

    const updated = getItem(item.id);
    expect(updated?.state).toBe('open');
    expect(updated?.events.at(-1)).toMatchObject({ disposition: 'fail' });
    // No verifier ran, so no RCA: the fail is recorded and nothing is filed.
    expect(createTaskMock).not.toHaveBeenCalled();
  });

  it('advances state to pass (not runnable) and never tags the event operator "gate-verifier"', async () => {
    const item = makeGateItem({ classification: 'Human-Observation' });
    const mirror = stageIntent(
      'gate.verify',
      { gateItemId: item.id, origin: 'mirror' },
      'proj-a',
      null,
      null,
      'Human-Observation mirror',
      null,
      null,
      'M13',
      null,
    );
    const app = makeApp();
    const agent = supertest(app);
    const applied = await agent
      .post(`/api/staged-intents/${mirror.id}/apply`)
      .send({
        mirrorDisposition: 'pass',
        mirrorEvidence: { note: 'observed the correct rendering' },
      });
    expect(applied.status).toBe(200);

    const updated = getItem(item.id);
    expect(updated?.state).toBe('pass');
    expect(updated?.state).not.toBe('runnable');
    expect(updated?.currentDisposition).toBe('pass');
    const lastEvent = updated?.events.at(-1) as { operator?: string };
    expect(lastEvent.operator).not.toBe('gate-verifier');
  });

  it('a genuine verifier-originated pass (non-mirror gate.verify report, operator-approved) is still suppressed to advisory-only', async () => {
    const item = makeGateItem({ classification: 'Human-Observation' });
    const app = makeApp();
    const agent = supertest(app);

    const staged = await agent.post('/api/staged-intents').send({
      kind: 'gate.verify',
      projectId: 'proj-a',
      payload: {
        gateItemId: item.id,
        disposition: 'pass',
        evidence: { basis: 'operational', note: 'headless check looks fine' },
      },
    });
    expect(staged.status).toBe(201);

    await agent.post(`/api/staged-intents/${staged.body.id}/approve`).send({});
    const applied = await agent
      .post(`/api/staged-intents/${staged.body.id}/apply`)
      .send({});
    expect(applied.status).toBe(200);

    const updated = getItem(item.id);
    expect(updated?.state).toBe(item.state);
    expect(updated?.currentDisposition).toBeUndefined();
    const lastEvent = updated?.events.at(-1) as { operator?: string };
    expect(lastEvent.operator).toBe('gate-verifier');
  });

  it('after an operator-supplied mirror pass, the reconciler does not re-stage a mirror for that item', async () => {
    const item = makeGateItem({
      classification: 'Human-Observation',
      milestone: 'M13',
    });
    setSourceMergeCommit(item.id, 'notion:abc', 'sha1');
    setMinDeployedCommit(item.id, 'sha1', new Date(1).toISOString());
    await reconcileGateRunnability('sha1', { project: 'proj-a' });

    const app = makeApp();
    const agent = supertest(app);
    configureGateItemMirrorSink({
      stageMirror(mirrorItem) {
        stageIntent(
          'gate.verify',
          { gateItemId: mirrorItem.id, origin: 'mirror' },
          mirrorItem.project,
          null,
          null,
          `Human-Observation: ${mirrorItem.text}`,
          null,
          null,
          mirrorItem.milestone,
          null,
        );
      },
      retireMirror() {},
    });

    const staged = reconcileHumanObservationMirrors();
    expect(staged.staged).toEqual([item.id]);
    const mirrorRow = db
      .prepare(
        `SELECT id FROM staged_intent
         WHERE kind = 'gate.verify' AND json_extract(payload, '$.gateItemId') = ?`,
      )
      .get(item.id) as { id: string };

    const applied = await agent
      .post(`/api/staged-intents/${mirrorRow.id}/apply`)
      .send({
        mirrorDisposition: 'pass',
        mirrorEvidence: { note: 'observed the correct rendering' },
      });
    expect(applied.status).toBe(200);
    expect(getItem(item.id)?.state).toBe('pass');

    const second = reconcileHumanObservationMirrors();
    expect(second.staged).toEqual([]);
  });
});
