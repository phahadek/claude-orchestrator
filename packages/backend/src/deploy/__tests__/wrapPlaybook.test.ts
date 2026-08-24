/**
 * Tests for the milestone-wrap playbook (packages/backend/src/deploy/wrapPlaybook.ts).
 *
 * AC: buildWrapPlaybook produces the 5-action, 7-step playbook shape (two
 * confirm-gates ahead of their mutating step); each of the 5 action steps'
 * underlying logic behaves correctly in isolation, including
 * markMilestoneWrapped's idempotent-already-wrapped-as-success handling
 * (the in-process mirror of POST /api/milestones/:id/wrapped's 409); and
 * createWrapShellRunner dispatches wrap-directive commands to that logic
 * while falling through to a real shell for everything else (the
 * advance-main/cut-release steps).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import {
  insertProject,
  insertMilestone,
  insertGateItem,
} from '../../db/queries.js';
import {
  buildWrapPlaybook,
  markMilestoneWrapped,
  MilestoneNotFoundError,
  bulkCarryPendingGateItems,
  repointAutoLaunchMilestone,
  createWrapShellRunner,
  WRAP_STEP_MARK_WRAPPED,
  WRAP_STEP_CARRY_GATE_ITEMS,
  WRAP_STEP_CONFIRM_REPOINT,
  WRAP_STEP_REPOINT,
  WRAP_STEP_ADVANCE_MAIN,
  WRAP_STEP_CONFIRM_RELEASE,
  WRAP_STEP_CUT_RELEASE,
} from '../wrapPlaybook.js';

const PROJECT = 'wrap-test-project';
const CLOSING_MILESTONE = 'closing-milestone-id';
const NEXT_MILESTONE = 'next-milestone-id';

beforeEach(() => {
  db.prepare('DELETE FROM gate_item').run();
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM milestones').run();
  db.prepare('DELETE FROM projects').run();

  insertProject({
    id: PROJECT,
    name: 'Wrap Test Project',
    project_dir: '/tmp/wrap-test-project',
    context_url: null,
    github_repo: 'acme/wrap-test-project',
    task_source: 'notion',
  });
  insertMilestone({
    id: CLOSING_MILESTONE,
    project_id: PROJECT,
    name: 'M1',
    source_id: null,
    canonical_short_id: 'M1',
  });
  insertMilestone({
    id: NEXT_MILESTONE,
    project_id: PROJECT,
    name: 'M2',
    source_id: null,
    canonical_short_id: 'M2',
  });
});

function insertGateItemFixture(input: {
  id: string;
  milestone: string;
  text: string;
  state: string;
}): void {
  insertGateItem({
    id: input.id,
    project: PROJECT,
    milestone: input.milestone,
    text: input.text,
    classification: 'Read-Only',
    min_deployed_commit: null,
    state: input.state,
    current_disposition: null,
    latest_disposition: null,
    next_attempt_at: null,
    pending_attempt_count: 0,
    updated_at: '2026-08-24T00:00:00.000Z',
  });
}

describe('buildWrapPlaybook: shape', () => {
  it('produces the 5-action, 7-step playbook — a confirm-gate ahead of each of the two prod-mutating gated actions', () => {
    const playbook = buildWrapPlaybook({
      projectId: PROJECT,
      closingMilestoneId: CLOSING_MILESTONE,
      nextMilestoneId: NEXT_MILESTONE,
      releaseVersion: '1.9.0',
      repoUrl: 'https://github.com/acme/wrap-test-project.git',
    });

    expect(playbook.steps.map((s) => s.id)).toEqual([
      WRAP_STEP_MARK_WRAPPED,
      WRAP_STEP_CARRY_GATE_ITEMS,
      WRAP_STEP_CONFIRM_REPOINT,
      WRAP_STEP_REPOINT,
      WRAP_STEP_ADVANCE_MAIN,
      WRAP_STEP_CONFIRM_RELEASE,
      WRAP_STEP_CUT_RELEASE,
    ]);
    expect(playbook.steps.map((s) => s.kind)).toEqual([
      'shell',
      'shell',
      'confirm-gate',
      'shell',
      'shell',
      'confirm-gate',
      'shell',
    ]);
    // The two hard-to-reverse actions (repoint auto-launch, cut the
    // release) are prod-mutating; both confirm-gates precede them and are
    // themselves non-mutating (they only gate).
    const byId = Object.fromEntries(playbook.steps.map((s) => [s.id, s]));
    expect(byId[WRAP_STEP_CONFIRM_REPOINT].is_prod_mutating).toBe(false);
    expect(byId[WRAP_STEP_REPOINT].is_prod_mutating).toBe(true);
    expect(byId[WRAP_STEP_CONFIRM_RELEASE].is_prod_mutating).toBe(false);
    expect(byId[WRAP_STEP_CUT_RELEASE].is_prod_mutating).toBe(true);
    expect(byId[WRAP_STEP_ADVANCE_MAIN].is_prod_mutating).toBe(true);
  });

  it('bakes the release tag into the advance-main/cut-release commands', () => {
    const playbook = buildWrapPlaybook({
      projectId: PROJECT,
      closingMilestoneId: CLOSING_MILESTONE,
      nextMilestoneId: NEXT_MILESTONE,
      releaseVersion: '2.0.0',
      repoUrl: 'https://github.com/acme/wrap-test-project.git',
    });
    const cutRelease = playbook.steps.find(
      (s) => s.id === WRAP_STEP_CUT_RELEASE,
    );
    expect(cutRelease?.command_or_prompt).toContain('v2.0.0');
    expect(cutRelease?.command_or_prompt).toContain('gh release create');
    const advanceMain = playbook.steps.find(
      (s) => s.id === WRAP_STEP_ADVANCE_MAIN,
    );
    expect(advanceMain?.command_or_prompt).toContain('git merge --no-ff');
    expect(advanceMain?.command_or_prompt).toContain('origin/dev');
  });
});

describe('Step 1 — markMilestoneWrapped (the mark-wrapped step)', () => {
  it('wraps an unwrapped milestone and records the audit event', () => {
    const result = markMilestoneWrapped(CLOSING_MILESTONE);
    expect(result.alreadyWrapped).toBe(false);
    expect(result.wrappedAt).toBeGreaterThan(0);

    const row = db
      .prepare('SELECT wrapped_at FROM milestones WHERE id = ?')
      .get(CLOSING_MILESTONE) as { wrapped_at: number | null };
    expect(row.wrapped_at).toBe(result.wrappedAt);

    const event = db
      .prepare(`SELECT * FROM audit_log WHERE event_type = 'milestone_wrapped'`)
      .get() as { payload: string } | undefined;
    expect(event).toBeDefined();
    expect(JSON.parse(event!.payload)).toMatchObject({
      milestoneId: CLOSING_MILESTONE,
    });
  });

  it('treats an already-wrapped milestone as success — the idempotent 409-as-success case', () => {
    const first = markMilestoneWrapped(CLOSING_MILESTONE);
    const second = markMilestoneWrapped(CLOSING_MILESTONE);

    expect(second.alreadyWrapped).toBe(true);
    expect(second.wrappedAt).toBe(first.wrappedAt);

    // Only the first call recorded an audit event — a retried step doesn't
    // double-record.
    const events = db
      .prepare(`SELECT * FROM audit_log WHERE event_type = 'milestone_wrapped'`)
      .all();
    expect(events).toHaveLength(1);
  });

  it('throws MilestoneNotFoundError for an unknown milestone id', () => {
    expect(() => markMilestoneWrapped('does-not-exist')).toThrow(
      MilestoneNotFoundError,
    );
  });
});

describe('Step 2 — bulkCarryPendingGateItems (the carry-gate-items step)', () => {
  it('carries every pending item on the closing milestone forward, leaving non-pending items untouched', () => {
    insertGateItemFixture({
      id: 'item-pending-1',
      milestone: 'M1',
      text: 'pending item one',
      state: 'pending',
    });
    insertGateItemFixture({
      id: 'item-pending-2',
      milestone: 'M1',
      text: 'pending item two',
      state: 'pending',
    });
    insertGateItemFixture({
      id: 'item-open',
      milestone: 'M1',
      text: 'still-open item',
      state: 'open',
    });
    insertGateItemFixture({
      id: 'item-deferred',
      milestone: 'M1',
      text: 'deferred item',
      state: 'deferred',
    });

    const result = bulkCarryPendingGateItems(
      PROJECT,
      CLOSING_MILESTONE,
      NEXT_MILESTONE,
    );

    expect(result.carriedCount).toBe(2);

    const nextItems = db
      .prepare(
        `SELECT text FROM gate_item WHERE project = ? AND milestone = 'M2'`,
      )
      .all(PROJECT) as { text: string }[];
    expect(nextItems.map((i) => i.text).sort()).toEqual([
      'pending item one',
      'pending item two',
    ]);

    // The originals stay under the closing milestone, state untouched.
    const originalStates = db
      .prepare(
        `SELECT id, state FROM gate_item WHERE milestone = 'M1' ORDER BY id`,
      )
      .all() as { id: string; state: string }[];
    expect(originalStates).toEqual([
      { id: 'item-deferred', state: 'deferred' },
      { id: 'item-open', state: 'open' },
      { id: 'item-pending-1', state: 'pending' },
      { id: 'item-pending-2', state: 'pending' },
    ]);
  });

  it('is a no-op when the closing milestone has no pending items', () => {
    insertGateItemFixture({
      id: 'item-open',
      milestone: 'M1',
      text: 'still-open item',
      state: 'open',
    });
    const result = bulkCarryPendingGateItems(
      PROJECT,
      CLOSING_MILESTONE,
      NEXT_MILESTONE,
    );
    expect(result).toEqual({ carriedCount: 0, carriedIds: [] });
  });

  it('is idempotent — re-running the carry for the same items does not duplicate them', () => {
    insertGateItemFixture({
      id: 'item-pending-1',
      milestone: 'M1',
      text: 'pending item one',
      state: 'pending',
    });

    bulkCarryPendingGateItems(PROJECT, CLOSING_MILESTONE, NEXT_MILESTONE);
    bulkCarryPendingGateItems(PROJECT, CLOSING_MILESTONE, NEXT_MILESTONE);

    const nextItems = db
      .prepare(
        `SELECT text FROM gate_item WHERE project = ? AND milestone = 'M2'`,
      )
      .all(PROJECT) as { text: string }[];
    expect(nextItems).toHaveLength(1);
  });
});

describe('Step 3 — repointAutoLaunchMilestone (the repoint-auto-launch step)', () => {
  it('repoints the project auto_launch_milestone_id to the next milestone', () => {
    repointAutoLaunchMilestone(PROJECT, NEXT_MILESTONE);
    const row = db
      .prepare('SELECT auto_launch_milestone_id FROM projects WHERE id = ?')
      .get(PROJECT) as { auto_launch_milestone_id: string | null };
    expect(row.auto_launch_milestone_id).toBe(NEXT_MILESTONE);
  });

  it('throws for an unknown project', () => {
    expect(() =>
      repointAutoLaunchMilestone('no-such-project', NEXT_MILESTONE),
    ).toThrow(/unknown project/);
  });
});

describe('createWrapShellRunner: directive dispatch', () => {
  it('dispatches a mark-wrapped directive to markMilestoneWrapped', async () => {
    const runner = createWrapShellRunner(vi.fn());
    const playbook = buildWrapPlaybook({
      projectId: PROJECT,
      closingMilestoneId: CLOSING_MILESTONE,
      nextMilestoneId: NEXT_MILESTONE,
      releaseVersion: '1.9.0',
      repoUrl: 'https://github.com/acme/wrap-test-project.git',
    });
    const markWrappedStep = playbook.steps.find(
      (s) => s.id === WRAP_STEP_MARK_WRAPPED,
    )!;

    const result = await runner(markWrappedStep.command_or_prompt as string, {
      cwd: '/tmp',
    });

    expect(result.ok).toBe(true);
    const row = db
      .prepare('SELECT wrapped_at FROM milestones WHERE id = ?')
      .get(CLOSING_MILESTONE) as { wrapped_at: number | null };
    expect(row.wrapped_at).not.toBeNull();
  });

  it('treats a mark-wrapped directive against an already-wrapped milestone as a successful step (409-as-success)', async () => {
    markMilestoneWrapped(CLOSING_MILESTONE);
    const runner = createWrapShellRunner(vi.fn());
    const playbook = buildWrapPlaybook({
      projectId: PROJECT,
      closingMilestoneId: CLOSING_MILESTONE,
      nextMilestoneId: NEXT_MILESTONE,
      releaseVersion: '1.9.0',
      repoUrl: 'https://github.com/acme/wrap-test-project.git',
    });
    const markWrappedStep = playbook.steps.find(
      (s) => s.id === WRAP_STEP_MARK_WRAPPED,
    )!;

    const result = await runner(markWrappedStep.command_or_prompt as string, {
      cwd: '/tmp',
    });

    expect(result.ok).toBe(true);
    expect(JSON.parse(result.stdout ?? result.output)).toMatchObject({
      alreadyWrapped: true,
    });
  });

  it('a mark-wrapped directive against an unknown milestone fails the step', async () => {
    const runner = createWrapShellRunner(vi.fn());
    const playbook = buildWrapPlaybook({
      projectId: PROJECT,
      closingMilestoneId: 'does-not-exist',
      nextMilestoneId: NEXT_MILESTONE,
      releaseVersion: '1.9.0',
      repoUrl: 'https://github.com/acme/wrap-test-project.git',
    });
    const markWrappedStep = playbook.steps.find(
      (s) => s.id === WRAP_STEP_MARK_WRAPPED,
    )!;

    const result = await runner(markWrappedStep.command_or_prompt as string, {
      cwd: '/tmp',
    });

    expect(result.ok).toBe(false);
  });

  it('dispatches a carry-gate-items directive to bulkCarryPendingGateItems', async () => {
    insertGateItemFixture({
      id: 'item-pending-1',
      milestone: 'M1',
      text: 'pending item one',
      state: 'pending',
    });
    const runner = createWrapShellRunner(vi.fn());
    const playbook = buildWrapPlaybook({
      projectId: PROJECT,
      closingMilestoneId: CLOSING_MILESTONE,
      nextMilestoneId: NEXT_MILESTONE,
      releaseVersion: '1.9.0',
      repoUrl: 'https://github.com/acme/wrap-test-project.git',
    });
    const carryStep = playbook.steps.find(
      (s) => s.id === WRAP_STEP_CARRY_GATE_ITEMS,
    )!;

    const result = await runner(carryStep.command_or_prompt as string, {
      cwd: '/tmp',
    });

    expect(result.ok).toBe(true);
    expect(JSON.parse(result.stdout ?? result.output)).toMatchObject({
      carriedCount: 1,
    });
  });

  it('dispatches a repoint-auto-launch directive to repointAutoLaunchMilestone', async () => {
    const runner = createWrapShellRunner(vi.fn());
    const playbook = buildWrapPlaybook({
      projectId: PROJECT,
      closingMilestoneId: CLOSING_MILESTONE,
      nextMilestoneId: NEXT_MILESTONE,
      releaseVersion: '1.9.0',
      repoUrl: 'https://github.com/acme/wrap-test-project.git',
    });
    const repointStep = playbook.steps.find((s) => s.id === WRAP_STEP_REPOINT)!;

    const result = await runner(repointStep.command_or_prompt as string, {
      cwd: '/tmp',
    });

    expect(result.ok).toBe(true);
    const row = db
      .prepare('SELECT auto_launch_milestone_id FROM projects WHERE id = ?')
      .get(PROJECT) as { auto_launch_milestone_id: string | null };
    expect(row.auto_launch_milestone_id).toBe(NEXT_MILESTONE);
  });

  it('falls through to the real shell for the advance-main/cut-release steps (not a wrap-directive)', async () => {
    const fallback = vi.fn(async () => ({
      ok: true,
      output: 'ran',
      exitCode: 0,
    }));
    const runner = createWrapShellRunner(fallback);
    const playbook = buildWrapPlaybook({
      projectId: PROJECT,
      closingMilestoneId: CLOSING_MILESTONE,
      nextMilestoneId: NEXT_MILESTONE,
      releaseVersion: '1.9.0',
      repoUrl: 'https://github.com/acme/wrap-test-project.git',
    });
    const advanceMainStep = playbook.steps.find(
      (s) => s.id === WRAP_STEP_ADVANCE_MAIN,
    )!;

    const result = await runner(advanceMainStep.command_or_prompt as string, {
      cwd: '/tmp',
    });

    expect(fallback).toHaveBeenCalledWith(advanceMainStep.command_or_prompt, {
      cwd: '/tmp',
    });
    expect(result.ok).toBe(true);
  });
});
