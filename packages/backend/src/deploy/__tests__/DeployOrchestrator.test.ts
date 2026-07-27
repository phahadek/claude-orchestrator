/**
 * Tests for DeployOrchestrator (packages/backend/src/deploy/DeployOrchestrator.ts).
 *
 * AC: a run executes steps in order by kind; changed_paths skip works; an
 * agentic step gates on its verdict; a step failure halts + surfaces + runs
 * rollback_ref; a simulated restart resumes at current_step; companion-diff
 * flags on a trigger-path match.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import {
  DeployOrchestrator,
  buildDeployStepEnv,
  spawnShell,
  RESTART_STEP_ID,
  type DeployOrchestratorDeps,
  type ShellResult,
} from '../DeployOrchestrator';
import {
  getDeployRun,
  listDeployRunEvents,
  getProjectDeployedSha,
} from '../deployService';
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
function now(): string {
  tick += 1;
  return `2026-07-20T00:00:${String(tick).padStart(2, '0')}.000Z`;
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
});

describe('DeployOrchestrator: step failure halts + rollback', () => {
  it('runs rollback_ref, halts, and surfaces on step failure', async () => {
    const playbook = playbookWith([
      step({ id: 'deploy', kind: 'shell', rollback_ref: 'rollback' }),
      step({ id: 'rollback', kind: 'shell' }),
      step({ id: 'never-reached', kind: 'shell' }),
    ]);
    const shellCommands: string[] = [];
    const onNeedsAttention = vi.fn();
    const deps = makeDeps(playbook, {
      sink: { onNeedsAttention },
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

    expect(shellCommands).toEqual(['run deploy', 'run rollback']);
    expect(getDeployRun(run.run_id)?.status).toBe('failed');
    expect(onNeedsAttention).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: run.run_id,
        stepId: 'deploy',
        reason: 'deploy exploded',
      }),
    );
    const events = listDeployRunEvents(run.run_id).map((e) => e.event_type);
    expect(events).toContain('step_failed');
    expect(events).toContain('rollback_succeeded');
  });

  it('halts to a terminal failed state with no rollback event when the failed step has no rollback_ref', async () => {
    const playbook = playbookWith([
      step({ id: 'bookkeeping', kind: 'shell' }),
      step({ id: 'never-reached', kind: 'shell' }),
    ]);
    const deps = makeDeps(playbook, {
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
    expect(events.some((e) => e.event_type === 'rollback_succeeded')).toBe(
      false,
    );
    expect(events.some((e) => e.event_type === 'rollback_failed')).toBe(false);
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
