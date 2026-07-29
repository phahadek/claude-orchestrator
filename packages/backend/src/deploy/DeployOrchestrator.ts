import { spawn } from 'child_process';
import { logger } from '../logger';
import { loadDeployPlaybook, LoadPlaybookResult } from './loadPlaybook';
import { matchesPathDiff } from './pathDiffPredicate';
import type {
  DeployPlaybook,
  StepDescriptor,
  CompanionDecl,
} from './playbookSchema';
import {
  startDeployRun,
  getActiveDeployRun,
  advanceDeployRun,
  completeDeployRun,
  appendDeployRunEvent,
  listDeployRunEvents,
  reportProjectDeploy,
  getProjectDeployedSha,
} from './deployService';
import type { DeployRunRow } from '../db/types';

/**
 * Conventional step id for the step that restarts this project's own backend
 * service (a self-deploy) — the shell command kills the very process
 * driving the deploy before it returns, so this step is special-cased both
 * on the way forward (marked succeeded and current_step advanced past it
 * before the restart is issued) and on resume (never re-issued).
 */
export const RESTART_STEP_ID = 'restart';

/**
 * Conventional step id for the validation step that must confirm the
 * restarted process is serving before report-in/record-sha run. The engine
 * gates this step's poll on a differing `identity_capture` reading (see
 * playbookSchema) in addition to its own `poll_until` health check, so it
 * can't green against the outgoing process still bound during the restart
 * window.
 */
const VERIFY_STEP_ID = 'verify';

/** Event type recording the restart step's `identity_capture` output, read before it executes. */
const PRE_RESTART_IDENTITY_EVENT = 'pre_restart_identity_captured';

export type AgenticVerdict = 'approved' | 'rejected';

export interface ShellResult {
  ok: boolean;
  output: string;
  /** The child's exit code, or `null` when it never ran (e.g. spawn error). */
  exitCode: number | null;
}

/** Runs a step's shell command (kind `shell`/`validation`), optionally as another user. */
export type ShellRunner = (
  command: string,
  opts: { runAs?: string; cwd: string },
) => Promise<ShellResult>;

/** Spawns the validation/investigation session for an `agentic` step. Fire-and-forget — the
 * engine gates the next step on `reportAgenticVerdict` being called back for this run/step. */
type AgenticStepSpawner = (input: {
  runId: string;
  project: string;
  step: StepDescriptor;
}) => void;

/** Pauses for operator disposition on a `confirm-gate` step; resolves to whether it was approved. */
type ConfirmGateWaiter = (input: {
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

/** Resolves the deploy target when the caller doesn't pin one: fetches origin, then returns origin/dev HEAD. */
export type DeployTargetResolver = (projectDir: string) => Promise<string>;

interface NeedsAttentionInfo {
  runId: string;
  project: string;
  stepId: string;
  reason: string;
}

interface CompanionFlagInfo {
  runId: string;
  project: string;
  companions: CompanionDecl[];
}

interface DeployOrchestratorSink {
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
  resolveDeployTarget?: DeployTargetResolver;
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

/** Deploy steps build artifacts; they must not inherit the host service's
 *  NODE_ENV=production, which makes npm omit devDependencies (vite etc.). */
export function buildDeployStepEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...base, NODE_ENV: 'development' };
}

/** The default `ShellRunner` used when no `runShell` dep is injected. */
export function spawnShell(
  command: string,
  opts: { cwd: string; runAs?: string },
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const [cmd, args] = opts.runAs
      ? [
          'sudo',
          ['-u', opts.runAs, 'NODE_ENV=development', 'bash', '-lc', command],
        ]
      : ['bash', ['-lc', command]];
    const proc = spawn(cmd, args, { cwd: opts.cwd, env: buildDeployStepEnv() });
    let out = '';
    proc.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    proc.stderr?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    proc.on('error', (err) =>
      resolve({ ok: false, output: String(err), exitCode: null }),
    );
    proc.on('close', (code) =>
      resolve({ ok: code === 0, output: out, exitCode: code }),
    );
  });
}

/** Synthesises a diagnosable detail when a failed step's shell output is empty. */
function shellFailureDetail(stepId: string, result: ShellResult): string {
  if (result.output.trim().length > 0) return result.output;
  return `step "${stepId}" failed with exit code ${result.exitCode ?? 'unknown'} and produced no output`;
}

/**
 * Builds the operator-facing failure reason for a halted step: the step's
 * matching `failure_diagnoses` entry (symptom → cause → action) when the
 * playbook associates one with this step's id, else the raw failure detail
 * plus every declared diagnosis (no single one identified as the cause).
 */
function describeFailure(
  playbook: DeployPlaybook,
  step: StepDescriptor,
  detail: string | undefined,
): string {
  const base = detail ?? `step "${step.id}" failed`;
  const matching = playbook.failure_diagnoses.find((d) => d.step === step.id);
  if (matching) {
    return `${base} — diagnosis: symptom="${matching.symptom}"; cause="${matching.cause}"; action="${matching.action}"`;
  }
  if (playbook.failure_diagnoses.length === 0) return base;
  const all = playbook.failure_diagnoses
    .map((d) => `symptom="${d.symptom}"; cause="${d.cause}"; action="${d.action}"`)
    .join(' | ');
  return `${base} — no diagnosis matched step "${step.id}"; declared diagnoses: ${all}`;
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

function spawnCapture(
  cmd: string,
  args: string[],
  opts: { cwd: string },
): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { cwd: opts.cwd });
    let out = '';
    proc.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    proc.on('error', () => resolve({ ok: false, stdout: '' }));
    proc.on('close', (code) => resolve({ ok: code === 0, stdout: out.trim() }));
  });
}

/**
 * Default target resolution for a plain `startDeploy()` call: fetches
 * origin, then resolves origin/dev HEAD — a deploy always targets the
 * latest dev, not an operator-typed SHA.
 */
async function resolveDeployTarget(projectDir: string): Promise<string> {
  await spawnCapture('git', ['fetch', 'origin'], { cwd: projectDir });
  const result = await spawnCapture('git', ['rev-parse', 'origin/dev'], {
    cwd: projectDir,
  });
  if (!result.ok || !result.stdout) {
    throw new Error('failed to resolve origin/dev HEAD');
  }
  return result.stdout;
}

/**
 * Executes a project's deploy playbook step-by-step (external-promise family,
 * mirroring ReviewOrchestrator): shell steps run as `run_as`, agentic steps
 * gate on a verdict reported back via `reportAgenticVerdict`, confirm-gate
 * steps pause for the operator, and validation steps poll where declared. A
 * step whose `changed_paths` doesn't match the deployed→target diff is
 * skipped. On failure the run always halts and the sink is notified with the
 * matching `failure_diagnoses` entry (or all of them, unmatched); when the
 * failed step declares a `rollback_ref`, its compensating step runs only
 * after an operator confirm-gate — never silently. Resuming after a
 * restart (including a self-deploy of this orchestrator) re-drives the
 * playbook starting at the run's `current_step`.
 */
export class DeployOrchestrator {
  private readonly loadPlaybook: (projectDir: string) => LoadPlaybookResult;
  private readonly runShell: ShellRunner;
  private readonly getDiffPaths: DiffProvider;
  private readonly resolveDeployTarget: DeployTargetResolver;
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
      ((command, opts) =>
        spawnShell(command, { cwd: opts.cwd, runAs: opts.runAs }));
    this.getDiffPaths =
      deps.getDiffPaths ??
      ((input) =>
        gitDiffNameOnly({
          projectDir: input.projectDir,
          fromSha: input.fromSha,
          toSha: input.toSha,
        }));
    this.resolveDeployTarget = deps.resolveDeployTarget ?? resolveDeployTarget;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.pollMaxAttempts = deps.pollMaxAttempts ?? 5;
    this.pollDelayMs = deps.pollDelayMs ?? 1000;
  }

  /**
   * Starts a new deploy_run and drives it to completion (or halt) in the
   * background. A deploy always targets the latest dev: when `targetSha`
   * isn't passed, it's resolved server-side (fetch origin, then origin/dev
   * HEAD) before the run row is created. Throws DeployRunConflictError if
   * the project already has an active run — at most one active run per
   * project.
   */
  async startDeploy(targetSha?: string): Promise<DeployRunRow> {
    const loaded = this.loadPlaybook(this.projectDir);
    if (!loaded.ok) {
      throw new Error(`cannot start deploy: ${loaded.reason}`);
    }
    const resolvedSha =
      targetSha ?? (await this.resolveDeployTarget(this.projectDir));
    const run = startDeployRun({
      project: this.project,
      targetSha: resolvedSha,
      startedAt: this.now(),
    });
    const deployedShaAtStart = getProjectDeployedSha(this.project);
    void this.drive(
      run.run_id,
      loaded.playbook,
      resolvedSha,
      deployedShaAtStart,
    );
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

      if (
        step.changed_paths &&
        !matchesPathDiff(step.changed_paths, diffPaths)
      ) {
        appendDeployRunEvent({
          runId,
          step: step.id,
          eventType: 'step_skipped',
          at: this.now(),
        });
        continue;
      }

      // Resuming right at the restart step means it already ran (that's
      // what killed the process that was driving this run) — never
      // re-issue it, just record it done and move on to verify/report-in.
      if (step.id === RESTART_STEP_ID && resumeAtStep === step.id) {
        appendDeployRunEvent({
          runId,
          step: step.id,
          eventType: 'step_succeeded',
          detail: 'resumed after self-restart; not re-issued',
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

      if (step.id === RESTART_STEP_ID) {
        // Capture the pre-restart process identity (e.g. the outgoing
        // MainPID) BEFORE the restart is issued, so the verify step can
        // later require a differing reading rather than greening against
        // the process this step is about to replace.
        if (step.identity_capture) {
          const identityResult = await this.runShell(step.identity_capture, {
            runAs: step.run_as,
            cwd: this.projectDir,
          });
          appendDeployRunEvent({
            runId,
            step: step.id,
            eventType: PRE_RESTART_IDENTITY_EVENT,
            detail: identityResult.output.trim(),
            at: this.now(),
          });
        }
        // Record success and advance current_step past this step BEFORE
        // the restart is issued — the shell command may kill this very
        // process before it returns, so the resuming backend must already
        // see this step as done rather than re-driving it.
        appendDeployRunEvent({
          runId,
          step: step.id,
          eventType: 'step_succeeded',
          at: this.now(),
        });
        const next = playbook.steps[i + 1];
        if (next) advanceDeployRun(runId, next.id);
        try {
          const outcome = await this.executeStep(
            runId,
            step,
            targetSha,
            playbook,
          );
          if (!outcome.ok) {
            logger.error(
              `[DeployOrchestrator] run ${runId} (${this.project}) restart step "${step.id}" reported failure after being marked succeeded: ${outcome.detail ?? ''}`,
            );
          }
        } catch (err) {
          logger.error(
            `[DeployOrchestrator] run ${runId} (${this.project}) restart step "${step.id}" threw after being marked succeeded: ${err}`,
          );
        }
        continue;
      }

      let outcome: StepOutcome;
      try {
        outcome = await this.executeStep(runId, step, targetSha, playbook);
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
        if (step.rollback_ref) {
          await this.runCompensatingStep(runId, playbook, step, targetSha);
        }
        completeDeployRun(runId, 'failed', this.now());
        const reason = describeFailure(playbook, step, outcome.detail);
        logger.error(
          `[DeployOrchestrator] run ${runId} (${this.project}) halted at step "${step.id}": ${reason}`,
        );
        this.deps.sink?.onNeedsAttention?.({
          runId,
          project: this.project,
          stepId: step.id,
          reason,
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

  /**
   * Runs the failed step's declared compensating step (its `rollback_ref`),
   * gated behind an operator confirm — the engine offers, the operator
   * consents, never silent. A compensating step that itself fails records
   * `rollback_failed` and returns; it is never itself rolled back
   * (no recursion).
   */
  private async runCompensatingStep(
    runId: string,
    playbook: DeployPlaybook,
    failedStep: StepDescriptor,
    targetSha: string,
  ): Promise<void> {
    if (!failedStep.rollback_ref) return;
    const compensatingStep = playbook.steps.find(
      (s) => s.id === failedStep.rollback_ref,
    );
    if (!compensatingStep) {
      logger.warn(
        `[DeployOrchestrator] run ${runId}: rollback_ref "${failedStep.rollback_ref}" not found in playbook`,
      );
      return;
    }
    const approved = await this.deps.waitForConfirmGate({
      runId,
      project: this.project,
      step: compensatingStep,
    });
    appendDeployRunEvent({
      runId,
      step: compensatingStep.id,
      eventType: 'confirm_gate',
      disposition: approved ? 'approved' : 'rejected',
      at: this.now(),
    });
    if (!approved) return;
    try {
      const result = await this.executeStep(
        runId,
        compensatingStep,
        targetSha,
        playbook,
      );
      appendDeployRunEvent({
        runId,
        step: compensatingStep.id,
        eventType: result.ok ? 'rollback_succeeded' : 'rollback_failed',
        detail: result.detail ?? null,
        at: this.now(),
      });
    } catch (err) {
      appendDeployRunEvent({
        runId,
        step: compensatingStep.id,
        eventType: 'rollback_failed',
        detail: String(err),
        at: this.now(),
      });
    }
  }

  private async executeStep(
    runId: string,
    step: StepDescriptor,
    targetSha: string,
    playbook: DeployPlaybook,
  ): Promise<StepOutcome> {
    switch (step.kind) {
      case 'shell': {
        const result = await this.runShell(step.command_or_prompt as string, {
          runAs: step.run_as,
          cwd: this.projectDir,
        });
        return {
          ok: result.ok,
          detail: result.ok ? undefined : shellFailureDetail(step.id, result),
        };
      }

      case 'validation': {
        const command = step.poll_until ?? (step.command_or_prompt as string);
        const identityCheck = this.resolveIdentityCheck(runId, step, playbook);
        return this.pollUntil(step.id, command, step.run_as, identityCheck);
      }

      case 'report-in': {
        reportProjectDeploy(this.project, targetSha);
        return { ok: true };
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
          detail:
            verdict === 'approved'
              ? undefined
              : 'agentic step verdict: rejected',
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

  /**
   * For the conventional `verify` validation step, resolves the pre-restart
   * identity baseline (captured off the `restart` step's `identity_capture`
   * command, and persisted as a deploy_run_event so it survives a self-deploy
   * restart into a fresh process) plus the command to re-read it on each poll
   * attempt. Returns undefined when the playbook declares no identity_capture
   * — verify then falls back to its plain poll_until health check alone.
   */
  private resolveIdentityCheck(
    runId: string,
    step: StepDescriptor,
    playbook: DeployPlaybook,
  ): { command: string; baseline: string } | undefined {
    if (step.id !== VERIFY_STEP_ID) return undefined;
    const restartStep = playbook.steps.find((s) => s.id === RESTART_STEP_ID);
    if (!restartStep?.identity_capture) return undefined;
    const captured = listDeployRunEvents(runId)
      .filter((e) => e.event_type === PRE_RESTART_IDENTITY_EVENT)
      .pop();
    if (!captured) return undefined;
    return {
      command: restartStep.identity_capture,
      baseline: captured.detail ?? '',
    };
  }

  private async pollUntil(
    stepId: string,
    command: string,
    runAs: string | undefined,
    identityCheck?: { command: string; baseline: string },
  ): Promise<StepOutcome> {
    let lastResult: ShellResult = { ok: false, output: '', exitCode: null };
    for (let attempt = 0; attempt < this.pollMaxAttempts; attempt++) {
      if (identityCheck) {
        const identityResult = await this.runShell(identityCheck.command, {
          runAs,
          cwd: this.projectDir,
        });
        const currentIdentity = identityResult.output.trim();
        if (!identityResult.ok || currentIdentity === identityCheck.baseline) {
          lastResult = {
            ok: false,
            output: `post-restart identity still matches the pre-restart baseline ("${identityCheck.baseline}")`,
            exitCode: null,
          };
          if (attempt < this.pollMaxAttempts - 1) {
            await new Promise((resolve) =>
              setTimeout(resolve, this.pollDelayMs),
            );
          }
          continue;
        }
      }
      const result = await this.runShell(command, {
        runAs,
        cwd: this.projectDir,
      });
      if (result.ok) return { ok: true };
      lastResult = result;
      if (attempt < this.pollMaxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, this.pollDelayMs));
      }
    }
    return { ok: false, detail: shellFailureDetail(stepId, lastResult) };
  }
}
