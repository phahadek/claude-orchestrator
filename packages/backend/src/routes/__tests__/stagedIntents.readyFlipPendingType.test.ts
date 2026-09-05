/**
 * Tests for the Ready-flip gate resolving Type from a group-pending
 * task.setType when one is staged, instead of only the committed board
 * cache — mirroring how computeProposedBody already resolves the effective
 * body from a group's pending patches. Without this, a groom session cannot
 * retype a mis-typed task and promote it to Ready in the same pass, since
 * the grooming-promotion gate and readiness gate would both validate the
 * old, about-to-be-superseded type.
 *
 * Exercises all three Ready-flip resolution sites in one group-commit flow:
 * runStageTimeReadyChecks (stage-time, via approve), checkGroupArmingIntentCompleteness's
 * checkGroomingPromotionGate call, and precheckGroupCommit's checkReadiness
 * call (both commit-time).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const { mockGetTaskBackend, mockRecordEvent, mockClassifyReadyProposal } =
  vi.hoisted(() => ({
    mockGetTaskBackend: vi.fn(),
    mockRecordEvent: vi.fn(),
    mockClassifyReadyProposal: vi.fn(),
  }));

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: mockGetTaskBackend,
}));

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: mockRecordEvent,
}));

vi.mock('../../tasks/deferralClassifier', () => ({
  classifyReadyProposal: mockClassifyReadyProposal,
}));

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../../db/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/queries')>();
  return {
    ...actual,
    getTaskCache: vi.fn().mockReturnValue(null),
  };
});

import { db } from '../../db/db';
import { getTaskCache } from '../../db/queries';
import { createStagedIntentsRouter } from '../stagedIntents';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter());
  return app;
}

function sections(overrides: Record<string, unknown> = {}) {
  return {
    summary: 'A summary.',
    dependencies: [],
    context: [
      { type: 'heading_3', text: 'Open Questions' },
      { type: 'bulleted_list_item', text: 'Still unresolved?' },
    ],
    automatedCriteria: ['tests pass'],
    manualCriteria: [],
    ...overrides,
  };
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  mockRecordEvent.mockReset();
  mockClassifyReadyProposal.mockReset();
  mockClassifyReadyProposal.mockResolvedValue(undefined);
  vi.mocked(getTaskCache).mockReturnValue(null);
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM gate_accretion').run();
  db.prepare('DELETE FROM seed_accretion').run();
});

/** Stages the 3-member group a retype-plus-promote decision requires: setDependsOn, an optional setType, and the arming setStatus->Ready. */
async function stageRetypeGroup(
  agent: ReturnType<typeof supertest>,
  projectId: string,
  taskId: string,
  groupId: string,
  opts: {
    setType?: string;
    updateBodySections?: Record<string, unknown>;
    groomingGate?: Record<string, unknown>;
  },
) {
  const dependsOn = await agent.post('/api/staged-intents').send({
    kind: 'task.setDependsOn',
    projectId,
    groupId,
    payload: { taskId, dependsOn: [] },
  });
  let setType;
  if (opts.setType) {
    setType = await agent.post('/api/staged-intents').send({
      kind: 'task.setType',
      projectId,
      groupId,
      payload: { taskId, type: opts.setType },
    });
  }
  let updateBody;
  if (opts.updateBodySections) {
    updateBody = await agent.post('/api/staged-intents').send({
      kind: 'task.updateBody',
      projectId,
      groupId,
      payload: { taskId, sections: opts.updateBodySections },
    });
  }
  const setStatus = await agent.post('/api/staged-intents').send({
    kind: 'task.setStatus',
    projectId,
    groupId,
    payload: {
      taskId,
      status: 'Ready',
      groomingGate: {
        size_check: { decision: 'n/a' },
        type_check: { decision: 'none' },
        seam_check: { decision: 'n/a' },
        ...opts.groomingGate,
      },
    },
  });
  return {
    dependsOn: dependsOn.body,
    setType: setType?.body,
    updateBody: updateBody?.body,
    setStatus: setStatus.body,
  };
}

async function approveAll(
  agent: ReturnType<typeof supertest>,
  members: Array<{ id: string } | undefined>,
) {
  for (const member of members) {
    if (!member) continue;
    await agent.post(`/api/staged-intents/${member.id}/approve`).send({});
  }
}

describe('Ready-flip gate resolves a group-pending task.setType', () => {
  it('promotes using the pending type, not the committed cached type, at stage time and at both commit-time gate checks', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn(),
      updateBody: vi.fn(),
      setType: vi.fn(),
    });
    // Committed cache still says 💻 Code — the stale value the bug would
    // resolve against. A 💻 Code-shaped grooming gate is deliberately NOT
    // supplied (no filesPathsEntries), and the body carries an Open
    // Questions section that would fail readiness for 💻 Code but is exempt
    // for 📐 Design once the pending retype is honored.
    vi.mocked(getTaskCache).mockReturnValue({
      task_id: 't-retype',
      fetched_at: 0,
      raw_json: JSON.stringify({ type: '💻 Code' }),
    });
    const app = makeApp();
    const agent = supertest(app);

    const group = await stageRetypeGroup(
      agent,
      'proj-retype',
      't-retype',
      'g-retype',
      {
        setType: '📐 Design',
        updateBodySections: sections(),
        groomingGate: {
          triage: { proposedVerdict: 'clean', hasOpenQuestionsHeading: true },
        },
      },
    );

    // Stage-time (runStageTimeReadyChecks): the setStatus intent must not
    // carry a blocked annotation from the stale Code-typed resolution.
    const staged = await agent
      .get('/api/staged-intents')
      .query({ projectId: 'proj-retype' });
    const setStatusRow = staged.body.intents.find(
      (i: { id: string }) => i.id === group.setStatus.id,
    );
    expect(setStatusRow.annotation).toBeNull();

    await approveAll(agent, [
      group.dependsOn,
      group.setType,
      group.updateBody,
      group.setStatus,
    ]);

    // Commit time: both checkGroupArmingIntentCompleteness's
    // checkGroomingPromotionGate call and precheckGroupCommit's
    // checkReadiness call must resolve the same pending 📐 Design type —
    // if either fell back to the stale cached 💻 Code, this 409s.
    const commit = await agent
      .post('/api/staged-intents/group/g-retype/commit')
      .send({});

    expect(commit.status).toBe(200);
  });

  it('promotes using the pending type when the sibling task.setType is needs_revision, not staged — mirrors the pending-type case above but with the retype blocked mid-groom', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn(),
      updateBody: vi.fn(),
      setType: vi.fn(),
    });
    // Committed cache still says 💻 Code — the stale value the bug would
    // fall back to once the sibling task.setType is no longer 'staged'.
    vi.mocked(getTaskCache).mockReturnValue({
      task_id: 't-retype-nr',
      fetched_at: 0,
      raw_json: JSON.stringify({ type: '💻 Code' }),
    });
    const app = makeApp();
    const agent = supertest(app);

    await agent.post('/api/staged-intents').send({
      kind: 'task.setDependsOn',
      projectId: 'proj-retype-nr',
      groupId: 'g-retype-nr',
      payload: { taskId: 't-retype-nr', dependsOn: [] },
    });
    const setType = await agent.post('/api/staged-intents').send({
      kind: 'task.setType',
      projectId: 'proj-retype-nr',
      groupId: 'g-retype-nr',
      payload: { taskId: 't-retype-nr', type: '📐 Design' },
    });

    // Simulate the sibling task.setType being blocked mid-groom (its own
    // stage-time validation failure, or a group-level route-back) — exactly
    // the scenario this task reproduces: the retype intent sits in
    // needs_revision, still the session's live, intended change, not an
    // abandoned one (see EXPLICIT_SUPERSEDES_ALLOWED_STATES's comment).
    db.prepare(
      "UPDATE staged_intent SET state = 'needs_revision' WHERE id = ?",
    ).run(setType.body.id);

    await agent.post('/api/staged-intents').send({
      kind: 'task.updateBody',
      projectId: 'proj-retype-nr',
      groupId: 'g-retype-nr',
      payload: { taskId: 't-retype-nr', sections: sections() },
    });
    const setStatus = await agent.post('/api/staged-intents').send({
      kind: 'task.setStatus',
      projectId: 'proj-retype-nr',
      groupId: 'g-retype-nr',
      payload: {
        taskId: 't-retype-nr',
        status: 'Ready',
        groomingGate: {
          size_check: { decision: 'n/a' },
          type_check: { decision: 'none' },
          seam_check: { decision: 'n/a' },
          triage: { proposedVerdict: 'clean', hasOpenQuestionsHeading: true },
        },
      },
    });

    // Stage-time (runStageTimeReadyChecks): the setStatus intent must not
    // carry a blocked annotation from a stale Code-typed resolution — the
    // needs_revision task.setType must still be honored as the pending type.
    // (The group itself cannot commit while a member sits in needs_revision
    // — that's an unrelated, correct refusal — so this test only exercises
    // the stage-time resolution, not commit.)
    const staged = await agent
      .get('/api/staged-intents')
      .query({ projectId: 'proj-retype-nr' });
    const setStatusRow = staged.body.intents.find(
      (i: { id: string }) => i.id === setStatus.body.id,
    );
    expect(setStatusRow.annotation).toBeNull();
  });

  it('falls back to the committed cached type when no task.setType is staged in the group — unchanged existing behavior', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn(),
      updateBody: vi.fn(),
    });
    vi.mocked(getTaskCache).mockReturnValue({
      task_id: 't-no-retype',
      fetched_at: 0,
      raw_json: JSON.stringify({ type: '💻 Code' }),
    });
    const app = makeApp();
    const agent = supertest(app);

    const group = await stageRetypeGroup(
      agent,
      'proj-no-retype',
      't-no-retype',
      'g-no-retype',
      {
        updateBodySections: sections(),
        groomingGate: {
          triage: { proposedVerdict: 'clean', hasOpenQuestionsHeading: true },
        },
      },
    );

    await approveAll(agent, [
      group.dependsOn,
      group.updateBody,
      group.setStatus,
    ]);

    const commit = await agent
      .post('/api/staged-intents/group/g-no-retype/commit')
      .send({});

    // Still 💻 Code-typed (no pending setType), so the Open Questions
    // section still violates readiness, and the missing filesPathsEntries
    // still fails the grooming gate.
    expect(commit.status).toBe(409);
  });
});
