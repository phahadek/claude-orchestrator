import { spawn } from 'child_process';
import { logger } from '../logger';
import { loadDeployPlaybook, LoadPlaybookResult } from './loadPlaybook';
import { matchesPathDiff } from './pathDiffPredicate';
import type { DeployPlaybook, StepDescriptor, CompanionDecl } from './playbookSchema';
import {
  startDeployRun,
  getActiveDeployRun,
  advanceDeployRun,
  completeDeployRun,
  appendDeployRunEvent,
  reportProjectDeploy,
  getProjectDeployedSha,
  DeployRunConflictError,
} from './deployService';
import type { DeployRunRow } from '../db/types';

export type AgenticVerdict = 'approved' | 'rejected';

export interface ShellResult {
  ok: boolean;
  output: string;
}

/** Runs a step's shell command (kind `shell`/`validation`), optionally as another user. */
export type ShellRunner = (
  command: string,
  opts: { runAs?: string; cwd: string },
) => Promise<ShellResult>;

/** Spawns the validation/investigation session for an `agentic` step. Fire-and-forget — the
 * engine gates the next step on `reportAgenticVerdict` being called back for this run/step. */
export type AgenticStepSpawner = (input: {
  runId: string;
  project: string;
  step: StepDescriptor;
}) => void;

/** Pauses for operator disposition on a `confirm-gate` step; resolves to whether it was approved. */
export type ConfirmGateWaiter = (input: {
  runId: string;
  project: string;
  step: StepDescriptor;
}) => Promise<boolean>;

/** Computes the repo-relative changed paths between the deployed and target SHAs. */
export type DiffProvider = (input: {
  project: string;
  projectDir: string;
  fromSha: string | null;
  toSha: string;
}) => Promise<string[]>;

export interface NeedsAttentionInfo {
  runId: string;
  project: string;
  stepId: string;
  reason: string;
}

export interface CompanionFlagInfo {
  runId: string;
  project: string;
  companions: CompanionDecl[];
}

export interface DeployOrchestratorSink {
  /** A step failed and rollback (if any) has run — the operator must intervene. */
  onNeedsAttention?(info: NeedsAttentionInfo): void;
  /** Advisory: a companion's trigger_paths matched the deployed→target diff. */
  onCompanionFlags?(info: CompanionFlagInfo): void;
}

export interface DeployOrchestratorDeps {
  loadPlaybook?: (projectDir: string) => LoadPlaybookResult;
  runShell?: ShellRunner;
  spawnAgenticStep: AgenticStepSpawner;
  waitForConfirmGate: ConfirmGateWaiter;
  getDiffPaths?: DiffProvider;
  sink?: DeployOrchestratorSink;
  /** Injectable clock for deterministic tests; defaults to `new Date().toISOString()`. */
  now?: () => string;
  /** Poll attempts/interval for a `validation` step's `poll_until`. */
  pollMaxAttempts?: number;
  pollDelayMs?: number;
}

interface StepOutcome {
  ok: boolean;
  detail?: string;
}

function spawnShell(
  command: string,
  opts: { cwd: string; runAs?: string },
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const [cmd, args] = opts.runAs
      ? ['sudo', ['-u', opts.runAs, 'bash', '-lc', command]]
      : ['bash', ['-lc', command]];
    const proc = spawn(cmd, args, { cwd: opts.cwd });
    let out = '';
    proc.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    proc.stderr?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    proc.on('error', (err) => resolve({ ok: false, output: String(err) }));
    proc.on('close', (code) => resolve({ ok: code === 0, output: out }));
  });
}

function gitDiffNameOnly(input: {
  projectDir: string;
  fromSha: string | null;
  toSha: string;
}): Promise<string[]> {
  if (!input.fromSha) return Promise.resolve([]);
  return new Promise((resolve) => {
    const proc = spawn(
      'git',
      ['diff', '--name-only', `${input.fromSha}..${input.toSha}`],
      { cwd: input.projectDir },
    );
    let out = '';
    proc.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    proc.on('error', () => resolve([]));
    proc.on('close', () => {
      resolve(
        out
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      );
    });
  });
}

/**
 * Executes a project's deploy playbook step-by-step (external-promise family,
 * mirroring ReviewOrchestrator): shell steps run as `run_as`, agentic steps
 * gate on a verdict reported back via `reportAgenticVerdict`, confirm-gate
 * steps pause for the operator, and validation steps poll where declared. A
 * step whose `changed_paths` doesn't match the deployed→target diff is
 * skipped. On failure the step's `rollback_ref` runs, the run halts, and the
 * sink is notified — no improvising past a failed step. Resuming after a
 * restart (including a self-deploy of this orchestrator) re-drives the
 * playbook starting at the run's `current_step`.
 */
export class DeployOrchestrator {
  private readonly loadPlaybook: (projectDir: string) => LoadPlaybookResult;
  private readonly runShell: ShellRunner;
  private readonly getDiffPaths: DiffProvider;
  private readonly now: () => string;
  private readonly pollMaxAttempts: number;
  private readonly pollDelayMs: number;
  private pendingAgenticVerdicts = new Map<
    string,
    (verdict: AgenticVerdict) => void
  >();

  constructor(
    private readonly project: string,
    private readonly projectDir: string,
    private readonly deps: DeployOrchestratorDeps,
  ) {
    this.loadPlaybook = deps.loadPlaybook ?? loadDeployPlaybook;
    this.runShell =
      deps.runShell ??
      ((command, opts) => spawnShell(command, { cwd: opts.cwd, runAs: opts.runAs }));
    this.getDiffPaths =
      deps.getDiffPaths ??
      ((input) =>
        gitDiffNameOnly({
          projectDir: input.projectDir,
          fromSha: input.fromSha,
          toSha: input.toSha,
        }));
    this.now = deps.now ?? (() => new Date().toISOString());
    this.pollMaxAttempts = deps.pollMaxAttempts ?? 5;
    this.pollDelayMs = deps.pollDelayMs ?? 1000;
  }

  /**
   * Starts a new deploy_run for `targetSha` and drives it to completion (or
   * halt) in the background. Throws DeployRunConflictError if the project
   * already has an active run — at most one active run per project.
   */
  async startDeploy(targetSha: string): Promise<DeployRunRow> {
    const loaded = this.loadPlaybook(this.projectDir);
    if (!loaded.ok) {
      throw new Error(`cannot start deploy: ${loaded.reason}`);
    }
    const run = startDeployRun({
      project: this.project,
      targetSha,
      startedAt: this.now(),
    });
    const deployedShaAtStart = getProjectDeployedSha(this.project);
    void this.drive(run.run_id, loaded.playbook, targetSha, deployedShaAtStart);
    return run;
  }

  /**
   * Rehydrates and resumes this project's in-progress deploy_run at boot (or
   * after a self-deploy restart), continuing at `current_step`. No-op if the
   * project has no active run.
   */
  async resume(): Promise<void> {
    const active = getActiveDeployRun(this.project);
    if (!active) return;
    const loaded = this.loadPlaybook(this.projectDir);
    if (!loaded.ok) {
      logger.error(
        `[DeployOrchestrator] resume: cannot load playbook for ${this.project} (run ${active.run_id}): ${loaded.reason}`,
      );
      completeDeployRun(active.run_id, 'failed', this.now());
      this.deps.sink?.onNeedsAttention?.({
        runId: active.run_id,
        project: this.project,
        stepId: active.current_step ?? '',
        reason: `cannot resume: ${loaded.reason}`,
      });
      return;
    }
    const deployedShaAtStart = getProjectDeployedSha(this.project);
    await this.drive(
      active.run_id,
      loaded.playbook,
      active.target_sha,
      deployedShaAtStart,
      active.current_step,
    );
  }

  /**
   * Reports the verdict for an in-flight `agentic` step's validation session,
   * recording it as a deploy_run_event and unblocking the step awaiting it.
   */
  reportAgenticVerdict(
    runId: string,
    stepId: string,
    verdict: AgenticVerdict,
    detail?: string,
  ): void {
    appendDeployRunEvent({
      runId,
      step: stepId,
      eventType: 'agentic_verdict',
      disposition: verdict,
      detail: detail ?? null,
      at: this.now(),
    });
    const key = `${runId}:${stepId}`;
    const resolve = this.pendingAgenticVerdicts.get(key);
    if (resolve) {
      this.pendingAgenticVerdicts.delete(key);
      resolve(verdict);
    }
  }

  private async drive(
    runId: string,
    playbook: DeployPlaybook,
    targetSha: string,
    deployedShaAtStart: string | null,
    resumeAtStep?: string | null,
  ): Promise<void> {
    const diffPaths = await this.getDiffPaths({
      project: this.project,
      projectDir: this.projectDir,
      fromSha: deployedShaAtStart,
      toSha: targetSha,
    });

    let startIndex = 0;
    if (resumeAtStep) {
      const idx = playbook.steps.findIndex((s) => s.id === resumeAtStep);
      if (idx >= 0) startIndex = idx;
    }

    for (let i = startIndex; i < playbook.steps.length; i++) {
      const step = playbook.steps[i];

      if (step.changed_paths && !matchesPathDiff(step.changed_paths, diffPaths)) {
        appendDeployRunEvent({
          runId,
          step: step.id,
          eventType: 'step_skipped',
          at: this.now(),
        });
        continue;
      }

      advanceDeployRun(runId, step.id);
      appendDeployRunEvent({
        runId,
        step: step.id,
        eventType: 'step_started',
        at: this.now(),
      });

      let outcome: StepOutcome;
      try {
        outcome = await this.executeStep(runId, step);
      } catch (err) {
        outcome = { ok: false, detail: String(err) };
      }

      if (!outcome.ok) {
        appendDeployRunEvent({
          runId,
          step: step.id,
          eventType: 'step_failed',
          detail: outcome.detail ?? null,
          at: this.now(),
        });
        await this.runRollback(runId, playbook, step);
        completeDeployRun(runId, 'failed', this.now());
        logger.error(
          `[DeployOrchestrator] run ${runId} (${this.project}) halted at step "${step.id}": ${outcome.detail ?? 'step failed'}`,
        );
        this.deps.sink?.onNeedsAttention?.({
          runId,
          project: this.project,
          stepId: step.id,
          reason: outcome.detail ?? 'step failed',
        });
        return;
      }

      appendDeployRunEvent({
        runId,
        step: step.id,
        eventType: 'step_succeeded',
        at: this.now(),
      });
    }

    const flagged = playbook.companions.filter((c) =>
      matchesPathDiff(c.trigger_paths, diffPaths),
    );
    if (flagged.length > 0) {
      this.deps.sink?.onCompanionFlags?.({
        runId,
        project: this.project,
        companions: flagged,
      });
    }

    reportProjectDeploy(this.project, targetSha);
    completeDeployRun(runId, 'succeeded', this.now());
  }

  private async runRollback(
    runId: string,
    playbook: DeployPlaybook,
    failedStep: StepDescriptor,
  ): Promise<void> {
    if (!failedStep.rollback_ref) return;
    const rollbackStep = playbook.steps.find(
      (s) => s.id === failedStep.rollback_ref,
    );
    if (!rollbackStep) {
      logger.warn(
        `[DeployOrchestrator] run ${runId}: rollback_ref "${failedStep.rollback_ref}" not found in playbook`,
      );
      return;
    }
    try {
      const result = await this.executeStep(runId, rollbackStep);
      appendDeployRunEvent({
        runId,
        step: rollbackStep.id,
        eventType: result.ok ? 'rollback_succeeded' : 'rollback_failed',
        detail: result.detail ?? null,
        at: this.now(),
      });
    } catch (err) {
      appendDeployRunEvent({
        runId,
        step: rollbackStep.id,
        eventType: 'rollback_failed',
        detail: String(err),
        at: this.now(),
      });
    }
  }

  private async executeStep(
    runId: string,
    step: StepDescriptor,
  ): Promise<StepOutcome> {
    switch (step.kind) {
      case 'shell': {
        const result = await this.runShell(step.command_or_prompt, {
          runAs: step.run_as,
          cwd: this.projectDir,
        });
        return { ok: result.ok, detail: result.ok ? undefined : result.output };
      }

      case 'validation': {
        const command = step.poll_until ?? step.command_or_prompt;
        return this.pollUntil(command, step.run_as);
      }

      case 'agentic': {
        const key = `${runId}:${step.id}`;
        const verdictPromise = new Promise<AgenticVerdict>((resolve) => {
          this.pendingAgenticVerdicts.set(key, resolve);
        });
        this.deps.spawnAgenticStep({ runId, project: this.project, step });
        const verdict = await verdictPromise;
        return {
          ok: verdict === 'approved',
          detail: verdict === 'approved' ? undefined : 'agentic step verdict: rejected',
        };
      }

      case 'confirm-gate': {
        const approved = await this.deps.waitForConfirmGate({
          runId,
          project: this.project,
          step,
        });
        appendDeployRunEvent({
          runId,
          step: step.id,
          eventType: 'confirm_gate',
          disposition: approved ? 'approved' : 'rejected',
          at: this.now(),
        });
        return {
          ok: approved,
          detail: approved ? undefined : 'operator rejected confirm-gate',
        };
      }
    }
  }

  private async pollUntil(
    command: string,
    runAs: string | undefined,
  ): Promise<StepOutcome> {
    let lastOutput = '';
    for (let attempt = 0; attempt < this.pollMaxAttempts; attempt++) {
      const result = await this.runShell(command, {
        runAs,
        cwd: this.projectDir,
      });
      if (result.ok) return { ok: true };
      lastOutput = result.output;
      if (attempt < this.pollMaxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, this.pollDelayMs));
      }
    }
    return { ok: false, detail: lastOutput };
  }
}

export { DeployRunConflictError };
