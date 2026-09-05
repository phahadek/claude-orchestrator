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
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

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
  startDeployRun,
  getDeployRun,
  listDeployRunEvents,
} from '../deployService.js';
import {
  DeployOrchestrator,
  type DeployOrchestratorDeps,
} from '../DeployOrchestrator.js';
import type { LoadPlaybookResult } from '../loadPlaybook.js';
import {
  buildWrapPlaybook,
  markMilestoneWrapped,
  MilestoneNotFoundError,
  bulkCarryPendingGateItems,
  repointAutoLaunchMilestone,
  createWrapShellRunner,
  recordWrapLaunchParams,
  readWrapLaunchParams,
  WRAP_STATIC_BINDINGS,
  WRAP_STEP_MARK_WRAPPED,
  WRAP_STEP_CARRY_GATE_ITEMS,
  WRAP_STEP_CONFIRM_INTEGRATE,
  WRAP_STEP_INTEGRATE,
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
  db.prepare('DELETE FROM deploy_run_event').run();
  db.prepare('DELETE FROM deploy_run').run();
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
  it('produces the 6-action, 9-step playbook — a confirm-gate ahead of each of the three prod-mutating gated actions', () => {
    const playbook = buildWrapPlaybook({
      projectId: PROJECT,
      closingMilestoneId: CLOSING_MILESTONE,
      nextMilestoneId: NEXT_MILESTONE,
      releaseVersion: '1.9.0',
      repoUrl: 'https://github.com/acme/wrap-test-project.git',
      baseBranch: 'dev',
    });

    expect(playbook.steps.map((s) => s.id)).toEqual([
      WRAP_STEP_MARK_WRAPPED,
      WRAP_STEP_CARRY_GATE_ITEMS,
      WRAP_STEP_CONFIRM_INTEGRATE,
      WRAP_STEP_INTEGRATE,
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
      'confirm-gate',
      'shell',
      'shell',
      'confirm-gate',
      'shell',
    ]);
    // The three hard-to-reverse actions (integrating the milestone branch,
    // repointing auto-launch, cutting the release) are prod-mutating; all
    // three confirm-gates precede them and are themselves non-mutating (they
    // only gate).
    const byId = Object.fromEntries(playbook.steps.map((s) => [s.id, s]));
    expect(byId[WRAP_STEP_CONFIRM_INTEGRATE].is_prod_mutating).toBe(false);
    expect(byId[WRAP_STEP_INTEGRATE].is_prod_mutating).toBe(true);
    expect(byId[WRAP_STEP_CONFIRM_REPOINT].is_prod_mutating).toBe(false);
    expect(byId[WRAP_STEP_REPOINT].is_prod_mutating).toBe(true);
    expect(byId[WRAP_STEP_CONFIRM_RELEASE].is_prod_mutating).toBe(false);
    expect(byId[WRAP_STEP_CUT_RELEASE].is_prod_mutating).toBe(true);
    expect(byId[WRAP_STEP_ADVANCE_MAIN].is_prod_mutating).toBe(true);
  });

  it('bakes the milestone branch and base branch into the integrate-milestone-branch command', () => {
    const playbook = buildWrapPlaybook({
      projectId: PROJECT,
      closingMilestoneId: CLOSING_MILESTONE,
      nextMilestoneId: NEXT_MILESTONE,
      releaseVersion: '1.9.0',
      repoUrl: 'https://github.com/acme/wrap-test-project.git',
      baseBranch: 'main',
    });
    const integrate = playbook.steps.find(
      (s) => s.id === WRAP_STEP_INTEGRATE,
    );
    expect(integrate?.command_or_prompt).toContain('git merge --no-ff');
    expect(integrate?.command_or_prompt).toContain('origin/milestone/m1');
    expect(integrate?.command_or_prompt).toContain('origin/main');
  });

  it('throws MilestoneNotFoundError when the closing milestone does not exist', () => {
    expect(() =>
      buildWrapPlaybook({
        projectId: PROJECT,
        closingMilestoneId: 'does-not-exist',
        nextMilestoneId: NEXT_MILESTONE,
        releaseVersion: '1.9.0',
        repoUrl: 'https://github.com/acme/wrap-test-project.git',
        baseBranch: 'dev',
      }),
    ).toThrow(MilestoneNotFoundError);
  });

  it('bakes the release tag into the advance-main/cut-release commands', () => {
    const playbook = buildWrapPlaybook({
      projectId: PROJECT,
      closingMilestoneId: CLOSING_MILESTONE,
      nextMilestoneId: NEXT_MILESTONE,
      releaseVersion: '2.0.0',
      repoUrl: 'https://github.com/acme/wrap-test-project.git',
      baseBranch: 'dev',
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
      baseBranch: 'dev',
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
      baseBranch: 'dev',
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
      baseBranch: 'dev',
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
      baseBranch: 'dev',
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
      baseBranch: 'dev',
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
      baseBranch: 'dev',
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

describe('recordWrapLaunchParams / readWrapLaunchParams (boot-resume support)', () => {
  it('round-trips the exact launch input a run was started with', () => {
    const run = startDeployRun({
      project: PROJECT,
      kind: 'wrap',
      targetSha: CLOSING_MILESTONE,
      startedAt: '2026-08-24T00:00:00.000Z',
    });
    const params = {
      projectId: PROJECT,
      closingMilestoneId: CLOSING_MILESTONE,
      nextMilestoneId: NEXT_MILESTONE,
      releaseVersion: '1.9.0',
      repoUrl: 'https://github.com/acme/wrap-test-project.git',
      baseBranch: 'dev',
    };

    recordWrapLaunchParams(run.run_id, params, '2026-08-24T00:00:00.000Z');

    expect(readWrapLaunchParams(run.run_id)).toEqual(params);
  });

  it('returns null for a run with no recorded launch params', () => {
    const run = startDeployRun({
      project: PROJECT,
      kind: 'wrap',
      targetSha: CLOSING_MILESTONE,
      startedAt: '2026-08-24T00:00:00.000Z',
    });
    expect(readWrapLaunchParams(run.run_id)).toBeNull();
  });

  it('returns null for an unknown run id', () => {
    expect(readWrapLaunchParams('no-such-run')).toBeNull();
  });
});

describe('Step: integrate-milestone-branch (confirm-gate + real merge)', () => {
  /** Flush pending microtasks so the fire-and-forget `drive()` loop settles. */
  async function flush(): Promise<void> {
    for (let i = 0; i < 15; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  function mkTmpDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  }

  /**
   * A bare "origin" repo with a base branch and a `milestone/m1` branch (the
   * slug `slugify('M1')` produces — matches the CLOSING_MILESTONE fixture's
   * name) diverged from it. `conflicting: true` also commits an overlapping
   * change to the base branch itself so merging the milestone branch in
   * conflicts; otherwise the milestone branch only touches a disjoint file,
   * so the merge is clean.
   */
  function setupGitFixture(options: { conflicting: boolean }): {
    originDir: string;
    baseBranch: string;
  } {
    const baseBranch = 'main';
    const originDir = mkTmpDir('wrap-origin-');
    execSync('git init -q --bare', { cwd: originDir });

    const workDir = mkTmpDir('wrap-work-');
    execSync('git init -q', { cwd: workDir });
    execSync('git checkout -q -b main', { cwd: workDir });
    execSync('git config user.email test@example.com', { cwd: workDir });
    execSync('git config user.name Test', { cwd: workDir });
    fs.writeFileSync(path.join(workDir, 'shared.txt'), 'base\n');
    execSync('git add .', { cwd: workDir });
    execSync('git commit -q -m base', { cwd: workDir });
    execSync(`git remote add origin ${originDir}`, { cwd: workDir });
    execSync(`git push -q origin ${baseBranch}`, { cwd: workDir });

    execSync('git checkout -q -b milestone/m1', { cwd: workDir });
    if (options.conflicting) {
      fs.writeFileSync(path.join(workDir, 'shared.txt'), 'milestone change\n');
    } else {
      fs.writeFileSync(path.join(workDir, 'feature.txt'), 'feature\n');
    }
    execSync('git add .', { cwd: workDir });
    execSync('git commit -q -m milestone-commit', { cwd: workDir });
    execSync('git push -q origin milestone/m1', { cwd: workDir });

    if (options.conflicting) {
      execSync(`git checkout -q ${baseBranch}`, { cwd: workDir });
      fs.writeFileSync(path.join(workDir, 'shared.txt'), 'main change\n');
      execSync('git add .', { cwd: workDir });
      execSync('git commit -q -m main-commit', { cwd: workDir });
      execSync(`git push -q origin ${baseBranch}`, { cwd: workDir });
    }

    return { originDir, baseBranch };
  }

  /** Builds a DeployOrchestrator driving only the confirm-gate + shell pair the integrate-milestone-branch step is made of. */
  function makeIntegrateOrchestrator(
    originDir: string,
    baseBranch: string,
    projectDir: string,
    waitForConfirmGate: DeployOrchestratorDeps['waitForConfirmGate'],
  ): DeployOrchestrator {
    const full = buildWrapPlaybook({
      projectId: PROJECT,
      closingMilestoneId: CLOSING_MILESTONE,
      nextMilestoneId: NEXT_MILESTONE,
      releaseVersion: '1.9.0',
      repoUrl: originDir,
      baseBranch,
    });
    const steps = full.steps.filter(
      (s) =>
        s.id === WRAP_STEP_CONFIRM_INTEGRATE || s.id === WRAP_STEP_INTEGRATE,
    );
    const loadResult: LoadPlaybookResult = {
      ok: true,
      playbook: { steps, hazards: [], failure_diagnoses: [], companions: [] },
    };
    return new DeployOrchestrator(PROJECT, projectDir, {
      loadPlaybook: () => loadResult,
      loadDeployBindings: () => ({
        ok: true,
        bindings: WRAP_STATIC_BINDINGS,
        bindingsPath: null,
      }),
      runShell: createWrapShellRunner(),
      spawnAgenticStep: vi.fn(),
      waitForConfirmGate,
      getDiffPaths: vi.fn(async () => []),
    });
  }

  it("blocks the merge until the confirm-gate is approved — the milestone branch's tip is not merged in while pending", async () => {
    const { originDir, baseBranch } = setupGitFixture({ conflicting: false });
    const projectDir = mkTmpDir('wrap-projectdir-');
    let resolveGate!: (approved: boolean) => void;
    const gatePromise = new Promise<boolean>((resolve) => {
      resolveGate = resolve;
    });
    const waitForConfirmGate = vi.fn(() => gatePromise);
    const orchestrator = makeIntegrateOrchestrator(
      originDir,
      baseBranch,
      projectDir,
      waitForConfirmGate,
    );

    const run = await orchestrator.startDeploy(CLOSING_MILESTONE);
    await flush();

    expect(waitForConfirmGate).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: run.run_id,
        step: expect.objectContaining({ id: WRAP_STEP_CONFIRM_INTEGRATE }),
      }),
    );
    expect(getDeployRun(run.run_id)?.status).toBe('running');
    const tipWhilePending = execSync(`git rev-parse ${baseBranch}`, {
      cwd: originDir,
    })
      .toString()
      .trim();

    resolveGate(true);
    await flush();

    expect(getDeployRun(run.run_id)?.status).toBe('succeeded');
    const tipAfterApproval = execSync(`git rev-parse ${baseBranch}`, {
      cwd: originDir,
    })
      .toString()
      .trim();
    expect(tipAfterApproval).not.toBe(tipWhilePending);
  });

  it('a clean merge advances the run past the step', async () => {
    const { originDir, baseBranch } = setupGitFixture({ conflicting: false });
    const projectDir = mkTmpDir('wrap-projectdir-');
    const orchestrator = makeIntegrateOrchestrator(
      originDir,
      baseBranch,
      projectDir,
      vi.fn(async () => true),
    );

    const run = await orchestrator.startDeploy(CLOSING_MILESTONE);
    await flush();

    expect(getDeployRun(run.run_id)?.status).toBe('succeeded');
    const events = listDeployRunEvents(run.run_id).map((e) => ({
      step: e.step,
      eventType: e.event_type,
    }));
    expect(events).toContainEqual({
      step: WRAP_STEP_INTEGRATE,
      eventType: 'step_succeeded',
    });

    const checkoutDir = mkTmpDir('wrap-verify-');
    execSync(`git clone -q ${originDir} ${checkoutDir}`);
    execSync(`git checkout -q ${baseBranch}`, { cwd: checkoutDir });
    expect(fs.existsSync(path.join(checkoutDir, 'feature.txt'))).toBe(true);
  });

  it('a conflicting merge fails the step, halts the run, and leaves origin and the prod checkout untouched', async () => {
    const { originDir, baseBranch } = setupGitFixture({ conflicting: true });
    const projectDir = mkTmpDir('wrap-projectdir-');
    const tipBefore = execSync(`git rev-parse ${baseBranch}`, {
      cwd: originDir,
    })
      .toString()
      .trim();

    const orchestrator = makeIntegrateOrchestrator(
      originDir,
      baseBranch,
      projectDir,
      vi.fn(async () => true),
    );
    const run = await orchestrator.startDeploy(CLOSING_MILESTONE);
    await flush();

    expect(getDeployRun(run.run_id)?.status).toBe('failed');
    const events = listDeployRunEvents(run.run_id).map((e) => e.event_type);
    expect(events).toContain('step_failed');

    // No partial mutation: origin's base branch tip is unchanged (the
    // conflict aborts the throwaway clone's merge before it ever pushes),
    // and the "prod checkout" (projectDir) — never touched by the
    // clone-into-$tmp mechanism to begin with — stays empty.
    const tipAfter = execSync(`git rev-parse ${baseBranch}`, {
      cwd: originDir,
    })
      .toString()
      .trim();
    expect(tipAfter).toBe(tipBefore);
    expect(fs.readdirSync(projectDir)).toEqual([]);
  });
});
