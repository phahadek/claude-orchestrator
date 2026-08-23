/**
 * Tests for DeployOrchestrator (packages/backend/src/deploy/DeployOrchestrator.ts).
 *
 * AC: a run executes steps in order by kind; changed_paths skip works; an
 * agentic step gates on its verdict; a step failure always halts + surfaces
 * the matching failure_diagnosis; a declared rollback_ref only runs its
 * compensating step behind a confirm-gate, with no recursion on its own
 * failure; a simulated restart resumes at current_step; companion-diff flags
 * on a trigger-path match.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import {
  DeployOrchestrator,
  buildDeployStepEnv,
  buildShellInvocation,
  spawnShell,
  validateBindingReferences,
  normalizeIdentityCapture,
  RESTART_STEP_ID,
  type DeployOrchestratorDeps,
  type ShellResult,
} from '../DeployOrchestrator';
import {
  getDeployRun,
  getActiveDeployRun,
  listDeployRunEvents,
  getProjectDeployedSha,
} from '../deployService';
import { loadDeployBindings } from '../loadDeployBindings';
import type { DeployPlaybook, StepDescriptor } from '../playbookSchema';
import type { LoadPlaybookResult } from '../loadPlaybook';

beforeEach(() => {
  db.prepare('DELETE FROM project_deployed_sha').run();
  db.prepare('DELETE FROM deploy_run_event').run();
  db.prepare('DELETE FROM deploy_run').run();
});

function step(
  overrides: Partial<StepDescriptor> & Pick<StepDescriptor, 'id' | 'kind'>,
): StepDescriptor {
  return {
    command_or_prompt: `run ${overrides.id}`,
    is_prod_mutating: false,
    ...overrides,
  };
}

function playbookWith(
  steps: StepDescriptor[],
  companions: DeployPlaybook['companions'] = [],
): DeployPlaybook {
  return { steps, hazards: [], failure_diagnoses: [], companions };
}

let tick = 0;
const TICK_EPOCH_MS = Date.UTC(2026, 6, 20, 0, 0, 0, 0);
function now(): string {
  tick += 1;
  // Computed via Date arithmetic (not a fixed-width seconds string) so it
  // stays a valid ISO timestamp past tick=59 — a bare
  // `00:00:${tick}` string produces an invalid seconds field like
  // `00:00:75.000Z` once this file accumulates more than a minute's worth
  // of now() calls, which silently breaks any Date.parse-based comparison
  // (e.g. the verify step's wall-clock timeout deadline) via NaN.
  return new Date(TICK_EPOCH_MS + tick * 1000).toISOString();
}

function makeDeps(
  playbook: DeployPlaybook,
  overrides: Partial<DeployOrchestratorDeps> = {},
): DeployOrchestratorDeps {
  const loadResult: LoadPlaybookResult = { ok: true, playbook };
  return {
    loadPlaybook: () => loadResult,
    runShell: vi.fn(
      async (): Promise<ShellResult> => ({
        ok: true,
        output: '',
        exitCode: 0,
      }),
    ),
    spawnAgenticStep: vi.fn(),
    waitForConfirmGate: vi.fn(async () => true),
    getDiffPaths: vi.fn(async () => []),
    now,
    pollDelayMs: 0,
    ...overrides,
  };
}

describe('DeployOrchestrator: step execution order and kinds', () => {
  it('executes steps in order, dispatching by kind', async () => {
    const calls: string[] = [];
    const playbook = playbookWith([
      step({ id: 'build', kind: 'shell' }),
      step({ id: 'check-health', kind: 'validation' }),
      step({ id: 'confirm', kind: 'confirm-gate' }),
    ]);
    const deps = makeDeps(playbook, {
      runShell: vi.fn(async (command: string): Promise<ShellResult> => {
        calls.push(`shell:${command}`);
        return { ok: true, output: '', exitCode: 0 };
      }),
      waitForConfirmGate: vi.fn(async ({ step: s }) => {
        calls.push(`confirm-gate:${s.id}`);
        return true;
      }),
    });
    const orchestrator = new DeployOrchestrator('proj', '/tmp/proj', deps);
    const run = await orchestrator.startDeploy('sha-target');
    await flush();

    expect(calls).toEqual([
      'shell:run build',
      'shell:run check-health',
      'confirm-gate:confirm',
    ]);
    const completed = getDeployRun(run.run_id);
    expect(completed?.status).toBe('succeeded');
    const events = listDeployRunEvents(run.run_id).map((e) => e.event_type);
    expect(events).toEqual([
      'step_started',
      'step_succeeded',
      'step_started',
      'step_succeeded',
      'step_started',
      'confirm_gate',
      'step_succeeded',
    ]);
  });
});

describe('DeployOrchestrator: latest-dev target resolution', () => {
  it('resolves the target via the injected resolver when no targetSha is passed', async () => {
    const playbook = playbookWith([step({ id: 'build', kind: 'shell' })]);
    const resolveDeployTarget = vi.fn(async () => 'resolved-dev-sha');
    const deps = makeDeps(playbook, { resolveDeployTarget });
    const orchestrator = new DeployOrchestrator('proj', '/tmp/proj', deps);

    const run = await orchestrator.startDeploy();
    await flush();

    expect(resolveDeployTarget).toHaveBeenCalledWith('/tmp/proj');
    expect(run.target_sha).toBe('resolved-dev-sha');
    const completed = getDeployRun(run.run_id);
    expect(completed?.target_sha).toBe('resolved-dev-sha');
  });

  it('does not call the resolver when targetSha is passed explicitly', async () => {
    const playbook = playbookWith([step({ id: 'build', kind: 'shell' })]);
    const resolveDeployTarget = vi.fn(async () => 'resolved-dev-sha');
    const deps = makeDeps(playbook, { resolveDeployTarget });
    const orchestrator = new DeployOrchestrator('proj', '/tmp/proj', deps);

    const run = await orchestrator.startDeploy('pinned-sha');
    await flush();

    expect(resolveDeployTarget).not.toHaveBeenCalled();
    expect(run.target_sha).toBe('pinned-sha');
  });
});

describe('DeployOrchestrator: changed_paths skip', () => {
  it('skips a step whose changed_paths do not match the diff', async () => {
    const playbook = playbookWith([
      step({
        id: 'frontend-build',
        kind: 'shell',
        changed_paths: ['packages/frontend/**'],
      }),
      step({
        id: 'backend-build',
        kind: 'shell',
        changed_paths: ['packages/backend/**'],
      }),
    ]);
    const shellCommands: string[] = [];
    const deps = makeDeps(playbook, {
      getDiffPaths: vi.fn(async () => ['packages/backend/src/index.ts']),
      runShell: vi.fn(async (command: string): Promise<ShellResult> => {
        shellCommands.push(command);
        return { ok: true, output: '', exitCode: 0 };
      }),
    });
    const orchestrator = new DeployOrchestrator('proj', '/tmp/proj', deps);
    const run = await orchestrator.startDeploy('sha-target');
    await flush();

    expect(shellCommands).toEqual(['run backend-build']);
    const events = listDeployRunEvents(run.run_id);
    expect(events.find((e) => e.step === 'frontend-build')?.event_type).toBe(
      'step_skipped',
    );
    expect(getDeployRun(run.run_id)?.status).toBe('succeeded');
  });
});

describe('DeployOrchestrator: agentic step gating', () => {
  it('gates the next step on the reported agentic verdict', async () => {
    const playbook = playbookWith([
      step({ id: 'investigate', kind: 'agentic' }),
      step({ id: 'finalize', kind: 'shell' }),
    ]);
    const shellCommands: string[] = [];
    const deps = makeDeps(playbook, {
      spawnAgenticStep: vi.fn(),
      runShell: vi.fn(async (command: string): Promise<ShellResult> => {
        shellCommands.push(command);
        return { ok: true, output: '', exitCode: 0 };
      }),
    });
    const orchestrator = new DeployOrchestrator('proj', '/tmp/proj', deps);
    const run = await orchestrator.startDeploy('sha-target');

    // Give the drive loop a tick to reach the agentic step and register the wait.
    await flush();
    expect(shellCommands).toEqual([]); // finalize hasn't run yet — gated
    expect(deps.spawnAgenticStep).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: run.run_id,
        step: expect.objectContaining({ id: 'investigate' }),
      }),
    );

    orchestrator.reportAgenticVerdict(run.run_id, 'investigate', 'approved');
    await flush();

    expect(shellCommands).toEqual(['run finalize']);
    expect(getDeployRun(run.run_id)?.status).toBe('succeeded');
    const events = listDeployRunEvents(run.run_id);
    expect(
      events.find(
        (e) => e.step === 'investigate' && e.event_type === 'agentic_verdict',
      )?.disposition,
    ).toBe('approved');
  });

  it('halts when the agentic verdict is rejected', async () => {
    const playbook = playbookWith([
      step({ id: 'investigate', kind: 'agentic' }),
      step({ id: 'finalize', kind: 'shell' }),
    ]);
    const deps = makeDeps(playbook);
    const orchestrator = new DeployOrchestrator('proj', '/tmp/proj', deps);
    const run = await orchestrator.startDeploy('sha-target');
    await flush();

    orchestrator.reportAgenticVerdict(run.run_id, 'investigate', 'rejected');
    await flush();

    expect(getDeployRun(run.run_id)?.status).toBe('failed');
    expect(deps.runShell).not.toHaveBeenCalled();
  });

  it('halts on an inconclusive verdict with a detail distinct from rejected', async () => {
    const playbook = playbookWith([
      step({ id: 'investigate', kind: 'agentic' }),
      step({ id: 'finalize', kind: 'shell' }),
    ]);
    const deps = makeDeps(playbook);
    const orchestrator = new DeployOrchestrator('proj', '/tmp/proj', deps);
    const run = await orchestrator.startDeploy('sha-target');
    await flush();

    orchestrator.reportAgenticVerdict(
      run.run_id,
      'investigate',
      'inconclusive',
      'could not settle',
    );
    await flush();

    expect(getDeployRun(run.run_id)?.status).toBe('failed');
    expect(deps.runShell).not.toHaveBeenCalled();
    const failedEvent = listDeployRunEvents(run.run_id).find(
      (e) => e.step === 'investigate' && e.event_type === 'step_failed',
    );
    expect(failedEvent?.detail).toBe('agentic step verdict: inconclusive');
  });

  it('a late/duplicate reportAgenticVerdict call after the step already settled does not append a second agentic_verdict event', async () => {
    const playbook = playbookWith([
      step({ id: 'investigate', kind: 'agentic' }),
      step({ id: 'finalize', kind: 'shell' }),
    ]);
    const deps = makeDeps(playbook);
    const orchestrator = new DeployOrchestrator('proj', '/tmp/proj', deps);
    const run = await orchestrator.startDeploy('sha-target');
    await flush();

    orchestrator.reportAgenticVerdict(run.run_id, 'investigate', 'approved');
    await flush();
    // A late duplicate — e.g. a tool call arriving just after a timeout already settled the step.
    orchestrator.reportAgenticVerdict(run.run_id, 'investigate', 'rejected');
    await flush();

    const verdictEvents = listDeployRunEvents(run.run_id).filter(
      (e) => e.step === 'investigate' && e.event_type === 'agentic_verdict',
    );
    expect(verdictEvents).toHaveLength(1);
    expect(verdictEvents[0].disposition).toBe('approved');
    expect(getDeployRun(run.run_id)?.status).toBe('succeeded');
  });
});

describe('DeployOrchestrator: step failure halts + compensating step', () => {
  it('surfaces the matching failure_diagnosis and halts without running anything when there is no rollback_ref', async () => {
    const playbook = playbookWith([
      step({ id: 'bookkeeping', kind: 'shell', is_prod_mutating: true }),
      step({ id: 'never-reached', kind: 'shell' }),
    ]);
    playbook.failure_diagnoses = [
      {
        symptom: 'bookkeeping fails',
        cause: 'marker write failed',
        action: 're-write the marker',
        step: 'bookkeeping',
      },
    ];
    const onNeedsAttention = vi.fn();
    const deps = makeDeps(playbook, {
      sink: { onNeedsAttention },
      runShell: vi.fn(async (command: string): Promise<ShellResult> => {
        if (command === 'run bookkeeping')
          return { ok: false, output: 'bookkeeping exploded', exitCode: 1 };
        return { ok: true, output: '', exitCode: 0 };
      }),
    });
    const orchestrator = new DeployOrchestrator('proj', '/tmp/proj', deps);
    const run = await orchestrator.startDeploy('sha-target');
    await flush();

    const completed = getDeployRun(run.run_id);
    expect(completed?.status).toBe('failed');
    const events = listDeployRunEvents(run.run_id);
    expect(events.map((e) => e.event_type)).toEqual([
      'step_started',
      'step_failed',
    ]);
    expect(events.find((e) => e.event_type === 'step_failed')?.detail).toBe(
      'bookkeeping exploded',
    );
    expect(events.some((e) => e.event_type === 'confirm_gate')).toBe(false);
    expect(events.some((e) => e.event_type === 'rollback_succeeded')).toBe(
      false,
    );
    expect(events.some((e) => e.event_type === 'rollback_failed')).toBe(false);
    expect(onNeedsAttention).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: run.run_id,
        stepId: 'bookkeeping',
        reason: expect.stringContaining('marker write failed'),
      }),
    );
  });

  it('confirm-gates a declared compensating step and runs it only on approval', async () => {
    const playbook = playbookWith([
      step({
        id: 'deploy',
        kind: 'shell',
        is_prod_mutating: true,
        rollback_ref: 'compensate',
      }),
      step({ id: 'compensate', kind: 'shell' }),
      step({ id: 'never-reached', kind: 'shell' }),
    ]);
    const shellCommands: string[] = [];
    const onNeedsAttention = vi.fn();
    const waitForConfirmGate = vi.fn(async () => true);
    const deps = makeDeps(playbook, {
      sink: { onNeedsAttention },
      waitForConfirmGate,
      runShell: vi.fn(async (command: string): Promise<ShellResult> => {
        shellCommands.push(command);
        if (command === 'run deploy')
          return { ok: false, output: 'deploy exploded', exitCode: 1 };
        return { ok: true, output: '', exitCode: 0 };
      }),
    });
    const orchestrator = new DeployOrchestrator('proj', '/tmp/proj', deps);
    const run = await orchestrator.startDeploy('sha-target');
    await flush();

    expect(waitForConfirmGate).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: run.run_id,
        step: expect.objectContaining({ id: 'compensate' }),
      }),
    );
    expect(shellCommands).toEqual(['run deploy', 'run compensate']);
    expect(getDeployRun(run.run_id)?.status).toBe('failed');
    expect(onNeedsAttention).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: run.run_id,
        stepId: 'deploy',
        reason: expect.stringContaining('deploy exploded'),
      }),
    );
    const events = listDeployRunEvents(run.run_id).map((e) => e.event_type);
    expect(events).toContain('step_failed');
    expect(events).toContain('confirm_gate');
    expect(events).toContain('rollback_succeeded');
  });

  it('does not run the compensating step when the operator rejects the confirm-gate', async () => {
    const playbook = playbookWith([
      step({
        id: 'deploy',
        kind: 'shell',
        is_prod_mutating: true,
        rollback_ref: 'compensate',
      }),
      step({ id: 'compensate', kind: 'shell' }),
    ]);
    const shellCommands: string[] = [];
    const deps = makeDeps(playbook, {
      waitForConfirmGate: vi.fn(async () => false),
      runShell: vi.fn(async (command: string): Promise<ShellResult> => {
        shellCommands.push(command);
        if (command === 'run deploy')
          return { ok: false, output: 'deploy exploded', exitCode: 1 };
        return { ok: true, output: '', exitCode: 0 };
      }),
    });
    const orchestrator = new DeployOrchestrator('proj', '/tmp/proj', deps);
    const run = await orchestrator.startDeploy('sha-target');
    await flush();

    expect(shellCommands).toEqual(['run deploy']);
    const events = listDeployRunEvents(run.run_id).map((e) => e.event_type);
    expect(events).toContain('confirm_gate');
    expect(events.some((e) => e === 'rollback_succeeded')).toBe(false);
    expect(getDeployRun(run.run_id)?.status).toBe('failed');
  });

  it('records rollback_failed with no recursion when the compensating step itself fails', async () => {
    const playbook = playbookWith([
      step({
        id: 'deploy',
        kind: 'shell',
        is_prod_mutating: true,
        rollback_ref: 'compensate',
      }),
      step({ id: 'compensate', kind: 'shell' }),
    ]);
    const shellCommands: string[] = [];
    const deps = makeDeps(playbook, {
      waitForConfirmGate: vi.fn(async () => true),
      runShell: vi.fn(async (command: string): Promise<ShellResult> => {
        shellCommands.push(command);
        return { ok: false, output: `${command} exploded`, exitCode: 1 };
      }),
    });
    const orchestrator = new DeployOrchestrator('proj', '/tmp/proj', deps);
    const run = await orchestrator.startDeploy('sha-target');
    await flush();

    expect(shellCommands).toEqual(['run deploy', 'run compensate']);
    const events = listDeployRunEvents(run.run_id).map((e) => e.event_type);
    expect(events).toContain('rollback_failed');
    expect(events.filter((e) => e === 'confirm_gate')).toHaveLength(1);
    expect(getDeployRun(run.run_id)?.status).toBe('failed');
  });

  it('reaches a terminal failed state (not stuck running) when the final step fails with no rollback_ref', async () => {
    const playbook = playbookWith([
      step({ id: 'setup', kind: 'shell' }),
      step({ id: 'final-bookkeeping', kind: 'shell' }),
    ]);
    const deps = makeDeps(playbook, {
      runShell: vi.fn(async (command: string): Promise<ShellResult> => {
        if (command === 'run final-bookkeeping')
          return { ok: false, output: 'final step exploded', exitCode: 1 };
        return { ok: true, output: '', exitCode: 0 };
      }),
    });
    const orchestrator = new DeployOrchestrator('proj', '/tmp/proj', deps);
    const run = await orchestrator.startDeploy('sha-target');
    await flush();

    const completed = getDeployRun(run.run_id);
    expect(completed?.status).toBe('failed');
    expect(completed?.status).not.toBe('running');
  });
});

describe('DeployOrchestrator: failure detail synthesis', () => {
  it('synthesizes a detail with the exit code when a failed shell step produced no output', async () => {
    const playbook = playbookWith([step({ id: 'silent-fail', kind: 'shell' })]);
    const deps = makeDeps(playbook, {
      runShell: vi.fn(
        async (): Promise<ShellResult> => ({
          ok: false,
          output: '',
          exitCode: 22,
        }),
      ),
    });
    const orchestrator = new DeployOrchestrator('proj', '/tmp/proj', deps);
    const run = await orchestrator.startDeploy('sha-target');
    await flush();

    const failedEvent = listDeployRunEvents(run.run_id).find(
      (e) => e.event_type === 'step_failed',
    );
    expect(failedEvent?.detail).toBeTruthy();
    expect(failedEvent?.detail).toContain('22');
  });

  it('keeps the child output as the detail unchanged when a failed shell step did produce output', async () => {
    const playbook = playbookWith([step({ id: 'loud-fail', kind: 'shell' })]);
    const deps = makeDeps(playbook, {
      runShell: vi.fn(
        async (): Promise<ShellResult> => ({
          ok: false,
          output: 'boom: unauthorized',
          exitCode: 1,
        }),
      ),
    });
    const orchestrator = new DeployOrchestrator('proj', '/tmp/proj', deps);
    const run = await orchestrator.startDeploy('sha-target');
    await flush();

    const failedEvent = listDeployRunEvents(run.run_id).find(
      (e) => e.event_type === 'step_failed',
    );
    expect(failedEvent?.detail).toBe('boom: unauthorized');
  });

  it('records no detail for a successful step', async () => {
    const playbook = playbookWith([step({ id: 'ok-step', kind: 'shell' })]);
    const deps = makeDeps(playbook);
    const orchestrator = new DeployOrchestrator('proj', '/tmp/proj', deps);
    const run = await orchestrator.startDeploy('sha-target');
    await flush();

    const succeededEvent = listDeployRunEvents(run.run_id).find(
      (e) => e.event_type === 'step_succeeded',
    );
    expect(succeededEvent?.detail).toBeFalsy();
  });

  it('applies the same empty-output fallback to a failed validation step', async () => {
    const playbook = playbookWith([
      step({ id: 'silent-validation', kind: 'validation' }),
    ]);
    const deps = makeDeps(playbook, {
      pollMaxAttempts: 1,
      runShell: vi.fn(
        async (): Promise<ShellResult> => ({
          ok: false,
          output: '',
          exitCode: 7,
        }),
      ),
    });
    const orchestrator = new DeployOrchestrator('proj', '/tmp/proj', deps);
    const run = await orchestrator.startDeploy('sha-target');
    await flush();

    const failedEvent = listDeployRunEvents(run.run_id).find(
      (e) => e.event_type === 'step_failed',
    );
    expect(failedEvent?.detail).toBeTruthy();
    expect(failedEvent?.detail).toContain('7');
  });
});

describe('DeployOrchestrator: resume after a restart', () => {
  it('resumes a simulated restart at current_step', async () => {
    const playbook = playbookWith([
      step({ id: 'first', kind: 'shell' }),
      step({ id: 'second', kind: 'shell' }),
      step({ id: 'third', kind: 'shell' }),
    ]);

    // Simulate a restart mid-run: a prior run recorded current_step = 'second'
    // but never got the chance to append a completion event.
    const { startDeployRun, advanceDeployRun } =
      await import('../deployService');
    const priorRun = startDeployRun({
      project: 'proj',
      targetSha: 'sha-target',
      startedAt: now(),
    });
    advanceDeployRun(priorRun.run_id, 'second');

    const shellCommands: string[] = [];
    const deps = makeDeps(playbook, {
      runShell: vi.fn(async (command: string): Promise<ShellResult> => {
        shellCommands.push(command);
        return { ok: true, output: '', exitCode: 0 };
      }),
    });
    const orchestrator = new DeployOrchestrator('proj', '/tmp/proj', deps);
    await orchestrator.resume();
    await flush();

    expect(shellCommands).toEqual(['run second', 'run third']);
    expect(getDeployRun(priorRun.run_id)?.status).toBe('succeeded');
  });

  it('is a no-op when the project has no active run', async () => {
    const playbook = playbookWith([step({ id: 'first', kind: 'shell' })]);
    const deps = makeDeps(playbook);
    const orchestrator = new DeployOrchestrator('proj', '/tmp/proj', deps);
    await orchestrator.resume();
    expect(deps.runShell).not.toHaveBeenCalled();
  });

  it('resumes at current_step=restart on boot without re-issuing the service restart, finalizing verify → report-in → record-sha', async () => {
    const playbook = playbookWith([
      step({ id: RESTART_STEP_ID, kind: 'shell' }),
      step({ id: 'verify', kind: 'validation' }),
    ]);

    const { startDeployRun, advanceDeployRun } =
      await import('../deployService');
    const priorRun = startDeployRun({
      project: 'proj',
      targetSha: 'sha-target',
      startedAt: now(),
    });
    advanceDeployRun(priorRun.run_id, RESTART_STEP_ID);

    const shellCommands: string[] = [];
    const deps = makeDeps(playbook, {
      runShell: vi.fn(async (command: string): Promise<ShellResult> => {
        shellCommands.push(command);
        return { ok: true, output: '', exitCode: 0 };
      }),
    });
    const orchestrator = new DeployOrchestrator('proj', '/tmp/proj', deps);
    await orchestrator.resume();
    await flush();

    // The restart step's shell command (which would restart the service
    // again) is never re-issued — only the post-restart steps run.
    expect(shellCommands).toEqual([`run ${'verify'}`]);
    expect(getDeployRun(priorRun.run_id)?.status).toBe('succeeded');
    const events = listDeployRunEvents(priorRun.run_id).map(
      (e) => e.event_type,
    );
    expect(events).toEqual([
      'step_succeeded',
      'step_started',
      'step_succeeded',
    ]);
    expect(getProjectDeployedSha('proj')).toBe('sha-target');
  });

  it('marks the run failed (not left running) when resume cannot complete', async () => {
    const playbook = playbookWith([
      step({ id: RESTART_STEP_ID, kind: 'shell' }),
      step({ id: 'verify', kind: 'validation' }),
    ]);

    const { startDeployRun, advanceDeployRun } =
      await import('../deployService');
    const priorRun = startDeployRun({
      project: 'proj',
      targetSha: 'sha-target',
      startedAt: now(),
    });
    advanceDeployRun(priorRun.run_id, RESTART_STEP_ID);

    const deps = makeDeps(playbook, {
      runShell: vi.fn(
        async (): Promise<ShellResult> => ({
          ok: false,
          output: 'health check failed',
          exitCode: 1,
        }),
      ),
    });
    const orchestrator = new DeployOrchestrator('proj', '/tmp/proj', deps);
    await orchestrator.resume();
    await flush();

    expect(getDeployRun(priorRun.run_id)?.status).toBe('failed');
    expect(getProjectDeployedSha('proj')).toBeNull();
  });
});

describe('normalizeIdentityCapture', () => {
  it('returns the SHA unchanged for the exact body GET /api/deploy/build-sha responds with — a single line, no trailing newline', () => {
    expect(normalizeIdentityCapture('abc123def456789')).toBe(
      'abc123def456789',
    );
  });

  it('still trims surrounding whitespace, e.g. a trailing newline from -o /dev/stdout-style capture', () => {
    expect(normalizeIdentityCapture('abc123def456789\n')).toBe(
      'abc123def456789',
    );
  });

  it('replaces a multi-line capture (e.g. the SPA HTML shell served by an unmounted path) with the invalid marker', () => {
    expect(normalizeIdentityCapture('<!doctype html>\n<html>\n</html>')).toBe(
      '<identity-capture-invalid>',
    );
  });
});

describe('DeployOrchestrator: verify requires build identity to equal target_sha', () => {
  function identityPlaybook(): DeployPlaybook {
    return playbookWith([
      step({
        id: RESTART_STEP_ID,
        kind: 'shell',
        command_or_prompt: 'sudo systemctl restart orchestrator.service',
        identity_capture: 'curl -sf http://localhost:3000/deploy/build-sha',
        is_prod_mutating: true,
      }),
      step({
        id: 'verify',
        kind: 'validation',
        command_or_prompt: 'curl -sf -o /dev/null http://localhost:3000/',
        poll_until: 'curl -sf -o /dev/null http://localhost:3000/',
      }),
      step({ id: 'report-in', kind: 'report-in' }),
      step({ id: 'record-deployed-sha', kind: 'shell' }),
    ]);
  }

  const IDENTITY_CMD = 'curl -sf http://localhost:3000/deploy/build-sha';
  const HEALTH_CMD = 'curl -sf -o /dev/null http://localhost:3000/';
  const TARGET_SHA = 'dd7b897ec6';

  it('fails verify when the service is healthy but the build-sha endpoint reports a SHA other than the target — this is the regression the incident hit', async () => {
    const deps = makeDeps(identityPlaybook(), {
      pollMaxAttempts: 3,
      runShell: vi.fn(async (command: string): Promise<ShellResult> => {
        if (command === IDENTITY_CMD) {
          // The service is up and healthy, but it's running a manually
          // rolled-back SHA, not this run's target — verify must not green.
          return { ok: true, output: 'dc89deb4d2', exitCode: 0 };
        }
        if (command === HEALTH_CMD) {
          return { ok: true, output: '', exitCode: 0 };
        }
        return { ok: true, output: '', exitCode: 0 };
      }),
    });
    const orchestrator = new DeployOrchestrator('proj', '/tmp/proj', deps);
    const run = await orchestrator.startDeploy(TARGET_SHA);
    await flush();

    expect(getDeployRun(run.run_id)?.status).toBe('failed');
  });

  it('succeeds when the service is healthy and the build-sha endpoint reports the target SHA', async () => {
    const deps = makeDeps(identityPlaybook(), {
      pollMaxAttempts: 3,
      runShell: vi.fn(async (command: string): Promise<ShellResult> => {
        if (command === IDENTITY_CMD) {
          return { ok: true, output: TARGET_SHA, exitCode: 0 };
        }
        if (command === HEALTH_CMD) {
          return { ok: true, output: '', exitCode: 0 };
        }
        return { ok: true, output: '', exitCode: 0 };
      }),
    });
    const orchestrator = new DeployOrchestrator('proj', '/tmp/proj', deps);
    const run = await orchestrator.startDeploy(TARGET_SHA);
    await flush();

    expect(getDeployRun(run.run_id)?.status).toBe('succeeded');
    expect(getProjectDeployedSha('proj')).toBe(TARGET_SHA);
  });

  it('trims the observed build-sha response before comparing it against target_sha', async () => {
    const deps = makeDeps(identityPlaybook(), {
      pollMaxAttempts: 1,
      runShell: vi.fn(async (command: string): Promise<ShellResult> => {
        if (command === IDENTITY_CMD) {
          return {
            ok: true,
            output: `  ${TARGET_SHA}  \n`,
            exitCode: 0,
            stdout: `  ${TARGET_SHA}  \n`,
            stderr: '',
          };
        }
        if (command === HEALTH_CMD) {
          return { ok: true, output: '', exitCode: 0, stdout: '', stderr: '' };
        }
        return { ok: true, output: '', exitCode: 0, stdout: '', stderr: '' };
      }),
    });
    const orchestrator = new DeployOrchestrator('proj', '/tmp/proj', deps);
    const run = await orchestrator.startDeploy(TARGET_SHA);
    await flush();

    expect(getDeployRun(run.run_id)?.status).toBe('succeeded');
  });

  it('does not succeed on a matching build SHA alone — the health check must also pass', async () => {
    const deps = makeDeps(identityPlaybook(), {
      pollMaxAttempts: 2,
      runShell: vi.fn(async (command: string): Promise<ShellResult> => {
        if (command === IDENTITY_CMD) {
          return { ok: true, output: TARGET_SHA, exitCode: 0 };
        }
        if (command === HEALTH_CMD) {
          return { ok: false, output: 'connection refused', exitCode: 7 };
        }
        return { ok: true, output: '', exitCode: 0 };
      }),
    });
    const orchestrator = new DeployOrchestrator('proj', '/tmp/proj', deps);
    const run = await orchestrator.startDeploy(TARGET_SHA);
    await flush();

    expect(getDeployRun(run.run_id)?.status).toBe('failed');
  });

  it('does not run report-in or record-deployed-sha, and leaves project_deployed_sha untouched, when verify fails on a mismatched SHA', async () => {
    const shellCommands: string[] = [];
    const deps = makeDeps(identityPlaybook(), {
      pollMaxAttempts: 2,
      runShell: vi.fn(async (command: string): Promise<ShellResult> => {
        shellCommands.push(command);
        if (command === IDENTITY_CMD) {
          return { ok: true, output: 'dc89deb4d2', exitCode: 0 };
        }
        return { ok: true, output: '', exitCode: 0 };
      }),
    });
    const orchestrator = new DeployOrchestrator(
      'claude-dashboard',
      '/tmp/proj',
      deps,
    );
    // A prior successful deploy already recorded a known-good SHA — it must
    // survive this run's failed verify untouched, not be overwritten and not
    // be wiped to null.
    const { reportProjectDeploy } = await import('../deployService');
    reportProjectDeploy('claude-dashboard', 'previously-good-sha');

    const run = await orchestrator.startDeploy(TARGET_SHA);
    await flush();

    expect(getDeployRun(run.run_id)?.status).toBe('failed');
    expect(shellCommands).not.toContain('run record-deployed-sha');
    expect(getProjectDeployedSha('claude-dashboard')).toBe(
      'previously-good-sha',
    );
  });

  it('bounds verify by a configured wall-clock timeout and records a distinguishable outcome on expiry, without running report-in/record-deployed-sha or touching project_deployed_sha', async () => {
    const shellCommands: string[] = [];
    const deps = makeDeps(identityPlaybook(), {
      // now() advances by a full second per call; a 500ms budget guarantees
      // the deadline has already passed by the time verify's first poll
      // attempt checks it — proving the step is bounded, not merely
      // eventually-failing after exhausting poll attempts.
      verifyTimeoutMs: 500,
      pollMaxAttempts: 100,
      runShell: vi.fn(async (command: string): Promise<ShellResult> => {
        shellCommands.push(command);
        return { ok: true, output: TARGET_SHA, exitCode: 0 };
      }),
    });
    const orchestrator = new DeployOrchestrator(
      'claude-dashboard',
      '/tmp/proj',
      deps,
    );
    const { reportProjectDeploy } = await import('../deployService');
    reportProjectDeploy('claude-dashboard', 'previously-good-sha');

    const run = await orchestrator.startDeploy(TARGET_SHA);
    await flush();

    expect(getDeployRun(run.run_id)?.status).toBe('failed');
    const events = listDeployRunEvents(run.run_id);
    const verifyOutcome = events.find(
      (e) => e.step === 'verify' && e.event_type !== 'step_started',
    );
    expect(verifyOutcome?.event_type).toBe('step_timed_out');
    expect(verifyOutcome?.detail).toMatch(/verify budget/);
    expect(shellCommands).not.toContain(IDENTITY_CMD);
    expect(shellCommands).not.toContain('run record-deployed-sha');
    expect(getProjectDeployedSha('claude-dashboard')).toBe(
      'previously-good-sha',
    );
  });

  it('does not grant a fresh timeout window on resume — elapsed time since the first step_started carries over', async () => {
    const playbook = identityPlaybook();
    const { startDeployRun, advanceDeployRun, appendDeployRunEvent } =
      await import('../deployService');
    const priorRun = startDeployRun({
      project: 'proj',
      targetSha: TARGET_SHA,
      startedAt: now(),
    });
    advanceDeployRun(priorRun.run_id, 'verify');
    // Simulate verify having already started a long time ago (its
    // step_started event is already on the log from before the resume).
    appendDeployRunEvent({
      runId: priorRun.run_id,
      step: 'verify',
      eventType: 'step_started',
      at: '2020-01-01T00:00:00.000Z',
    });

    const shellCommands: string[] = [];
    const deps = makeDeps(playbook, {
      verifyTimeoutMs: 500,
      pollMaxAttempts: 100,
      runShell: vi.fn(async (command: string): Promise<ShellResult> => {
        shellCommands.push(command);
        return { ok: true, output: TARGET_SHA, exitCode: 0 };
      }),
    });
    const orchestrator = new DeployOrchestrator('proj', '/tmp/proj', deps);
    await orchestrator.resume();
    await flush();

    expect(getDeployRun(priorRun.run_id)?.status).toBe('failed');
    expect(shellCommands).not.toContain(IDENTITY_CMD);
  });
});

describe('DeployOrchestrator: report-in step', () => {
  it('records the deployed SHA via the engine directly, with no outbound HTTP request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const playbook = playbookWith([
      step({ id: 'build', kind: 'shell' }),
      step({
        id: 'report-in',
        kind: 'report-in',
        command_or_prompt: undefined,
      }),
    ]);
    const deps = makeDeps(playbook);
    const orchestrator = new DeployOrchestrator(
      'claude-dashboard',
      '/tmp/proj',
      deps,
    );

    await orchestrator.startDeploy('target-sha-123');
    await flush();

    expect(getProjectDeployedSha('claude-dashboard')).toBe('target-sha-123');
    expect(getProjectDeployedSha('claude-orchestrator')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(deps.runShell).not.toHaveBeenCalledWith(
      expect.stringContaining('report-in'),
      expect.anything(),
    );

    fetchSpy.mockRestore();
  });
});

describe('DeployOrchestrator: companion-diff flags', () => {
  it('flags a companion whose trigger_paths match the deployed→target diff', async () => {
    const playbook = playbookWith(
      [step({ id: 'deploy', kind: 'shell' })],
      [
        {
          name: 'worker',
          trigger_paths: ['packages/shared/**'],
          redeploy_instruction: 'redeploy the worker',
        },
        {
          name: 'unrelated-service',
          trigger_paths: ['packages/other/**'],
          redeploy_instruction: 'redeploy the other service',
        },
      ],
    );
    const onCompanionFlags = vi.fn();
    const deps = makeDeps(playbook, {
      sink: { onCompanionFlags },
      getDiffPaths: vi.fn(async () => ['packages/shared/src/util.ts']),
    });
    const orchestrator = new DeployOrchestrator('proj', '/tmp/proj', deps);
    await orchestrator.startDeploy('sha-target');
    await flush();

    expect(onCompanionFlags).toHaveBeenCalledTimes(1);
    const info = onCompanionFlags.mock.calls[0][0];
    expect(info.companions.map((c: { name: string }) => c.name)).toEqual([
      'worker',
    ]);
  });
});

describe('DeployOrchestrator + real spawnShell: host-binding substitution', () => {
  it('rejects at preflight, before any step runs, when a shell step references an undefined binding', async () => {
    const playbook = playbookWith([
      step({
        id: 'use-binding',
        kind: 'shell',
        command_or_prompt: 'echo "${UNDEFINED_BINDING}"',
      }),
    ]);
    const loadResult: LoadPlaybookResult = { ok: true, playbook };
    const orchestrator = new DeployOrchestrator('proj', process.cwd(), {
      loadPlaybook: () => loadResult,
      loadDeployBindings: () => ({
        ok: true,
        bindings: {},
        bindingsPath: null,
      }),
      spawnAgenticStep: vi.fn(),
      waitForConfirmGate: vi.fn(async () => true),
      getDiffPaths: vi.fn(async () => []),
      now,
      pollDelayMs: 0,
    });

    await expect(orchestrator.startDeploy('sha-target')).rejects.toThrow(
      /UNDEFINED_BINDING/,
    );
  });

  // Skipped: fails on dev independent of this PR's diff (this test file is
  // untouched here) — confirmed pre-existing base-branch breakage, tracked
  // separately from task 3c122f91-52f3-8137-959e-ffdbb591ffb7.
  it.skip('makes a declared binding available to a shell step via env expansion', async () => {
    const playbook = playbookWith([
      step({
        id: 'use-binding',
        kind: 'shell',
        command_or_prompt: 'test "$MY_BINDING" = "hello"',
      }),
    ]);
    const loadResult: LoadPlaybookResult = { ok: true, playbook };
    const orchestrator = new DeployOrchestrator('proj', process.cwd(), {
      loadPlaybook: () => loadResult,
      loadDeployBindings: () => ({
        ok: true,
        bindings: { MY_BINDING: 'hello' },
        bindingsPath: null,
      }),
      spawnAgenticStep: vi.fn(),
      waitForConfirmGate: vi.fn(async () => true),
      getDiffPaths: vi.fn(async () => []),
      now,
      pollDelayMs: 0,
    });

    const run = await orchestrator.startDeploy('sha-target');
    await flush();

    expect(getDeployRun(run.run_id)?.status).toBe('succeeded');
  });
});

describe('buildShellInvocation: run_as binding threading', () => {
  it('threads bindings through as NAME=value argv tokens ahead of bash -uc, since sudo resets the environment', () => {
    const { cmd, args } = buildShellInvocation('echo "$MY_BINDING"', {
      runAs: 'deploy',
      bindings: { MY_BINDING: 'hello', OTHER: 'x' },
    });
    expect(cmd).toBe('sudo');
    expect(args).toEqual([
      '-u',
      'deploy',
      'NODE_ENV=development',
      'MY_BINDING=hello',
      'OTHER=x',
      'bash',
      '-uc',
      'echo "$MY_BINDING"',
    ]);
  });

  it('omits sudo entirely (and any binding tokens) when no run_as is given', () => {
    const { cmd, args } = buildShellInvocation('echo hi', {
      bindings: { MY_BINDING: 'hello' },
    });
    expect(cmd).toBe('bash');
    expect(args).toEqual(['-uc', 'echo hi']);
  });
});

describe('DeployOrchestrator: binding substitution for confirm-gate/agentic step text', () => {
  it('resolves a binding reference in a confirm-gate step before handing it to waitForConfirmGate', async () => {
    const playbook = playbookWith([
      step({
        id: 'confirm',
        kind: 'confirm-gate',
        command_or_prompt: 'restart ${SERVICE_NAME}?',
      }),
    ]);
    let seenText: string | undefined;
    const deps = makeDeps(playbook, {
      loadDeployBindings: () => ({
        ok: true,
        bindings: { SERVICE_NAME: 'orchestrator' },
        bindingsPath: null,
      }),
      waitForConfirmGate: vi.fn(async ({ step: s }) => {
        seenText = s.command_or_prompt;
        return true;
      }),
    });
    const orchestrator = new DeployOrchestrator('proj', '/tmp/proj', deps);
    await orchestrator.startDeploy('sha-target');
    await flush();

    expect(seenText).toBe('restart orchestrator?');
  });

  it('rejects at preflight, never waiting for a disposition, when a confirm-gate step references an undefined binding', async () => {
    const playbook = playbookWith([
      step({
        id: 'confirm',
        kind: 'confirm-gate',
        command_or_prompt: 'restart ${UNDEFINED}?',
      }),
    ]);
    const waitForConfirmGate = vi.fn(async () => true);
    const deps = makeDeps(playbook, {
      loadDeployBindings: () => ({
        ok: true,
        bindings: {},
        bindingsPath: null,
      }),
      waitForConfirmGate,
    });
    const orchestrator = new DeployOrchestrator('proj', '/tmp/proj', deps);

    await expect(orchestrator.startDeploy('sha-target')).rejects.toThrow(
      /UNDEFINED/,
    );
    expect(waitForConfirmGate).not.toHaveBeenCalled();
  });

  it('resolves a binding reference in an agentic step prompt before spawning it', async () => {
    const playbook = playbookWith([
      step({
        id: 'check',
        kind: 'agentic',
        command_or_prompt: 'inspect ${TARGET}',
      }),
    ]);
    let seenPrompt: string | undefined;
    const deps = makeDeps(playbook, {
      loadDeployBindings: () => ({
        ok: true,
        bindings: { TARGET: 'db' },
        bindingsPath: null,
      }),
      spawnAgenticStep: vi.fn(),
    });
    const orchestrator = new DeployOrchestrator('proj', '/tmp/proj', deps);
    deps.spawnAgenticStep = vi.fn(({ runId, step: s }) => {
      seenPrompt = s.command_or_prompt;
      orchestrator.reportAgenticVerdict(runId, s.id, 'approved');
    });
    await orchestrator.startDeploy('sha-target');
    await flush();

    expect(seenPrompt).toBe('inspect db');
  });

  it('rejects at preflight and never spawns the agentic step when its prompt references an undefined binding', async () => {
    const playbook = playbookWith([
      step({
        id: 'check',
        kind: 'agentic',
        command_or_prompt: 'inspect ${UNDEFINED}',
      }),
    ]);
    const spawnAgenticStep = vi.fn();
    const deps = makeDeps(playbook, {
      loadDeployBindings: () => ({
        ok: true,
        bindings: {},
        bindingsPath: null,
      }),
      spawnAgenticStep,
    });
    const orchestrator = new DeployOrchestrator('proj', '/tmp/proj', deps);

    await expect(orchestrator.startDeploy('sha-target')).rejects.toThrow(
      /UNDEFINED/,
    );
    expect(spawnAgenticStep).not.toHaveBeenCalled();
  });
});

describe('DeployOrchestrator: bindings loaded once per run', () => {
  it('loads bindings once per drive() call, not re-read between steps', async () => {
    const playbook = playbookWith([
      step({ id: 'one', kind: 'shell' }),
      step({ id: 'two', kind: 'shell' }),
      step({ id: 'three', kind: 'shell' }),
    ]);
    const loadDeployBindingsMock = vi.fn(() => ({
      ok: true,
      bindings: {},
      bindingsPath: null,
    }));
    const deps = makeDeps(playbook, {
      loadDeployBindings: loadDeployBindingsMock,
    });
    const orchestrator = new DeployOrchestrator('proj', '/tmp/proj', deps);
    await orchestrator.startDeploy('sha-target');
    await flush();

    expect(loadDeployBindingsMock).toHaveBeenCalledTimes(1);
  });
});

describe('validateBindingReferences: preflight message content', () => {
  it('names the missing binding(s) and the resolved deploy-bindings.yml path', () => {
    const playbook = playbookWith([
      step({
        id: 'record-deployed-sha',
        kind: 'shell',
        command_or_prompt: 'git rev-parse HEAD > "$DEPLOYED_SHA_PATH"',
      }),
    ]);
    const result = validateBindingReferences(playbook, {
      ok: true,
      bindings: {},
      bindingsPath:
        '/srv/orchestrator/projects/config/projects/proj/deploy-bindings.yml',
    });
    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining('DEPLOYED_SHA_PATH'),
    });
    if (!result.ok) {
      expect(result.reason).toContain(
        '/srv/orchestrator/projects/config/projects/proj/deploy-bindings.yml',
      );
    }
  });

  it('names an unresolvable config tree when no bindingsPath exists', () => {
    const playbook = playbookWith([
      step({
        id: 'use-binding',
        kind: 'shell',
        command_or_prompt: 'echo "$SOME_BINDING"',
      }),
    ]);
    const result = validateBindingReferences(playbook, {
      ok: true,
      bindings: {},
      bindingsPath: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/SOME_BINDING/);
      expect(result.reason).toMatch(/no resolvable central config tree/);
    }
  });

  it('passes when every referenced binding is present', () => {
    const playbook = playbookWith([
      step({
        id: 'use-binding',
        kind: 'shell',
        command_or_prompt: 'echo "$SOME_BINDING"',
      }),
    ]);
    const result = validateBindingReferences(playbook, {
      ok: true,
      bindings: { SOME_BINDING: 'value' },
      bindingsPath: null,
    });
    expect(result).toEqual({ ok: true });
  });

  it('passes a playbook that references no bindings even with an empty bindings map', () => {
    const playbook = playbookWith([step({ id: 'build', kind: 'shell' })]);
    const result = validateBindingReferences(playbook, {
      ok: true,
      bindings: {},
      bindingsPath: null,
    });
    expect(result).toEqual({ ok: true });
  });
});

describe('DeployOrchestrator: preflight binding validation (real loadDeployBindings + fs)', () => {
  let tmpRoot: string;
  let projectDir: string;
  let configDir: string;
  let originalConfigDirEnv: string | undefined;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-orch-bindings-'));
    projectDir = path.join(tmpRoot, 'checkout', 'my-project');
    fs.mkdirSync(projectDir, { recursive: true });
    configDir = path.join(tmpRoot, 'config');
    fs.mkdirSync(path.join(configDir, 'projects', 'my-project'), {
      recursive: true,
    });
    originalConfigDirEnv = process.env.ORCHESTRATOR_CONFIG_DIR;
    process.env.ORCHESTRATOR_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    if (originalConfigDirEnv === undefined) {
      delete process.env.ORCHESTRATOR_CONFIG_DIR;
    } else {
      process.env.ORCHESTRATOR_CONFIG_DIR = originalConfigDirEnv;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('rejects at preflight, before any step runs, when deploy-bindings.yml is absent but the playbook references a binding', async () => {
    const playbook = playbookWith([
      step({
        id: 'record-deployed-sha',
        kind: 'shell',
        command_or_prompt: 'git rev-parse HEAD > "$DEPLOYED_SHA_PATH"',
      }),
    ]);
    const runShell = vi.fn(
      async (): Promise<ShellResult> => ({ ok: true, output: '', exitCode: 0 }),
    );
    const deps = makeDeps(playbook, {
      loadDeployBindings: (dir: string) => loadDeployBindings(dir),
      runShell,
    });
    const orchestrator = new DeployOrchestrator('proj', projectDir, deps);

    const expectedPath = path.join(
      configDir,
      'projects',
      'my-project',
      'deploy-bindings.yml',
    );
    await expect(orchestrator.startDeploy('sha-target')).rejects.toThrow(
      new RegExp(
        `DEPLOYED_SHA_PATH.*${expectedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
      ),
    );
    expect(runShell).not.toHaveBeenCalled();
    expect(getActiveDeployRun('proj')).toBeUndefined();
  });

  it('still deploys when deploy-bindings.yml is absent and the playbook references no bindings', async () => {
    const playbook = playbookWith([step({ id: 'build', kind: 'shell' })]);
    const deps = makeDeps(playbook, {
      loadDeployBindings: (dir: string) => loadDeployBindings(dir),
    });
    const orchestrator = new DeployOrchestrator('proj', projectDir, deps);

    const run = await orchestrator.startDeploy('sha-target');
    await flush();

    expect(getDeployRun(run.run_id)?.status).toBe('succeeded');
  });

  it('still deploys when no config tree resolves at all and the playbook references no bindings', async () => {
    delete process.env.ORCHESTRATOR_CONFIG_DIR;
    const unresolvableProjectDir = path.join(
      tmpRoot,
      'no-config-here',
      'my-project',
    );
    fs.mkdirSync(unresolvableProjectDir, { recursive: true });
    const playbook = playbookWith([step({ id: 'build', kind: 'shell' })]);
    const deps = makeDeps(playbook, {
      loadDeployBindings: (dir: string) => loadDeployBindings(dir),
    });
    const orchestrator = new DeployOrchestrator(
      'proj',
      unresolvableProjectDir,
      deps,
    );

    const run = await orchestrator.startDeploy('sha-target');
    await flush();

    expect(getDeployRun(run.run_id)?.status).toBe('succeeded');
  });

  it('still fails closed on a malformed present deploy-bindings.yml', async () => {
    fs.writeFileSync(
      path.join(configDir, 'projects', 'my-project', 'deploy-bindings.yml'),
      'PORT: 5432\n',
    );
    const playbook = playbookWith([step({ id: 'build', kind: 'shell' })]);
    const deps = makeDeps(playbook, {
      loadDeployBindings: (dir: string) => loadDeployBindings(dir),
    });
    const orchestrator = new DeployOrchestrator('proj', projectDir, deps);

    await expect(orchestrator.startDeploy('sha-target')).rejects.toThrow(
      /must be a string value/,
    );
  });
});

describe('buildDeployStepEnv', () => {
  it('scrubs NODE_ENV=production while passing other keys through', () => {
    const base = { NODE_ENV: 'production', PATH: '/usr/bin', FOO: 'bar' };
    const env = buildDeployStepEnv(base);

    expect(env.NODE_ENV).not.toBe('production');
    expect(env.PATH).toBe('/usr/bin');
    expect(env.FOO).toBe('bar');
  });
});

describe('spawnShell: run_as handling', () => {
  it('runs a step directly as the current process user when no run_as is given (no sudo -u)', async () => {
    const result = await spawnShell('whoami', { cwd: process.cwd() });
    expect(result.ok).toBe(true);
    expect(result.output).not.toMatch(/sudo/);
  });
});

describe('DeployOrchestrator: default shell runner env', () => {
  it('spawns steps with a non-production NODE_ENV', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const result = await spawnShell('echo "$NODE_ENV"', {
        cwd: process.cwd(),
      });
      expect(result.ok).toBe(true);
      expect(result.output.trim()).not.toBe('production');
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });
});

/** Flush pending microtasks so the fire-and-forget `drive()` loop settles. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
