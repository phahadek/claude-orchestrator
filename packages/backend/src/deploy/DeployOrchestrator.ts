import { spawn } from 'child_process';
import { logger } from '../logger';
import { loadDeployPlaybook, LoadPlaybookResult } from './loadPlaybook';
import {
  loadDeployBindings,
  LoadDeployBindingsResult,
} from './loadDeployBindings';
import {
  DeployBindings,
  substituteBindings,
  extractBindingRefs,
} from './deployBindingsSchema';
import { matchesPathDiff } from './pathDiffPredicate';
import {
  withCheckoutInstallLock,
  sharesCheckoutNodeModules,
} from '../orchestration/checkoutInstallLock';
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
import type { DeployRunRow, DeployRunKind } from '../db/types';

/**
 * Conventional step id for the step that restarts this project's own backend
 * service (a self-deploy) — the shell command kills the very process
 * driving the deploy before it returns, so this step is special-cased both
 * on the way forward (marked succeeded and current_step advanced past it
 * before the restart is issued) and on resume (never re-issued).
 */
export const RESTART_STEP_ID = 'restart';

/**
 * Conventional step id for the step that runs `npm ci` against the project
 * checkout — the only step serialized against concurrent test.request lane
 * runs via checkoutInstallLock, since it's the one that wipes and
 * reinstalls `node_modules` a worktree-less run resolves through.
 */
const INSTALL_DEPS_STEP_ID = 'install-deps';

/**
 * Conventional step id for the validation step that must confirm the
 * restarted process is serving before report-in/record-sha run. The engine
 * gates this step's poll on the restart step's `identity_capture` command
 * (see playbookSchema) reading back a value that *equals the run's own
 * target_sha* — not merely a value that differs from some pre-restart
 * baseline, which proves a restart happened but never which build came up.
 * This is in addition to the step's own `poll_until` health check, so it
 * can't green against a healthy-but-wrong-SHA process (e.g. an unrelated
 * manual restart or rollback landing during the poll window).
 */
const VERIFY_STEP_ID = 'verify';

/** Event type recording verify's bounded wall-clock budget expiring before its identity+health check ever passed. */
const VERIFY_TIMEOUT_EVENT = 'step_timed_out';

/** Default wall-clock budget for the `verify` step, timed from its own (first) `step_started` event — not reset by a resume. */
const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60_000;

/**
 * Persisted in place of an `identity_capture` reading that doesn't look like
 * a single-line token (empty, or spanning multiple lines) once stderr has
 * already been stripped out — e.g. the capture command itself printed a
 * warning to stdout, or produced no output at all. Storing this explicit
 * marker keeps a malformed capture from being persisted as if it were a
 * usable identity value.
 */
const IDENTITY_CAPTURE_INVALID = '<identity-capture-invalid>';

export type AgenticVerdict = 'approved' | 'rejected' | 'inconclusive';

/**
 * The `task_id` convention a dispatched agentic-step session is started
 * under — `deploy-agentic:<runId>:<stepId>` — mirroring the gate-verifier's
 * `gate-item:<id>` sentinel prefix (see sessionPredicates.ts's
 * isGateVerifySession). Lets a spawner recognize an already-dispatched,
 * still-live session for a given run/step (reattach on resume) without a
 * separate mapping table.
 */
const DEPLOY_AGENTIC_TASK_PREFIX = 'deploy-agentic:';

export function buildDeployAgenticTaskId(
  runId: string,
  stepId: string,
): string {
  return `${DEPLOY_AGENTIC_TASK_PREFIX}${runId}:${stepId}`;
}

/** Inverse of buildDeployAgenticTaskId; null when `taskId` isn't a deploy-agentic task. */
export function parseDeployAgenticTaskId(
  taskId: string | null | undefined,
): { runId: string; stepId: string } | null {
  if (!taskId || !taskId.startsWith(DEPLOY_AGENTIC_TASK_PREFIX)) return null;
  const rest = taskId.slice(DEPLOY_AGENTIC_TASK_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep < 0) return null;
  return { runId: rest.slice(0, sep), stepId: rest.slice(sep + 1) };
}

export interface ShellResult {
  ok: boolean;
  /** Combined stdout+stderr, kept for existing failure-diagnostic callers. */
  output: string;
  /** The child's exit code, or `null` when it never ran (e.g. spawn error). */
  exitCode: number | null;
  /** stdout only. Falls back to `output` when a `ShellRunner` doesn't distinguish streams (e.g. a test double). */
  stdout?: string;
  /** stderr only. Falls back to `''` when a `ShellRunner` doesn't distinguish streams. */
  stderr?: string;
}

/** stdout for a `ShellResult`, falling back to the combined `output` when a runner doesn't separate streams. */
function shellStdout(result: ShellResult): string {
  return result.stdout ?? result.output;
}

/**
 * Normalizes a captured identity reading: trims surrounding whitespace, and
 * replaces anything that doesn't look like a single-line token (empty, or
 * still spanning multiple lines) with the explicit invalid marker rather
 * than persisting it as-is.
 */
export function normalizeIdentityCapture(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed || /\r|\n/.test(trimmed)) return IDENTITY_CAPTURE_INVALID;
  return trimmed;
}

/** Runs a step's shell command (kind `shell`/`validation`), optionally as another user. */
export type ShellRunner = (
  command: string,
  opts: { runAs?: string; cwd: string; bindings?: DeployBindings },
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
  loadDeployBindings?: (projectDir: string) => LoadDeployBindingsResult;
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
  /** Wall-clock budget for the `verify` step, timed from its first `step_started` event. Defaults to `DEFAULT_VERIFY_TIMEOUT_MS`. */
  verifyTimeoutMs?: number;
}

interface StepOutcome {
  ok: boolean;
  detail?: string;
  /** True when the outcome is verify's bounded wall-clock budget expiring, rather than an ordinary poll failure — recorded as a distinct event type. */
  timedOut?: boolean;
}

/** Deploy steps build artifacts; they must not inherit the host service's
 *  NODE_ENV=production, which makes npm omit devDependencies (vite etc.).
 *  Host bindings are merged in last so a project can't clobber NODE_ENV. */
export function buildDeployStepEnv(
  base: NodeJS.ProcessEnv = process.env,
  bindings: DeployBindings = {},
): NodeJS.ProcessEnv {
  return { ...base, NODE_ENV: 'development', ...bindings };
}

/**
 * Builds the argv for a step's shell invocation. Always `bash -uc`
 * (nounset), so a step referencing an undefined binding aborts rather than
 * silently expanding to empty. `sudo` resets the environment by default, so
 * a `run_as` step threads each binding through as an explicit `NAME=value`
 * argv token (mirroring the existing `NODE_ENV=development` handling)
 * rather than relying on env inheritance into the sudo-invoked shell.
 */
export function buildShellInvocation(
  command: string,
  opts: { runAs?: string; bindings?: DeployBindings },
): { cmd: string; args: string[] } {
  const bindingTokens = Object.entries(opts.bindings ?? {}).map(
    ([name, value]) => `${name}=${value}`,
  );
  if (!opts.runAs) {
    return { cmd: 'bash', args: ['-uc', command] };
  }
  return {
    cmd: 'sudo',
    args: [
      '-u',
      opts.runAs,
      'NODE_ENV=development',
      ...bindingTokens,
      'bash',
      '-uc',
      command,
    ],
  };
}

/** The default `ShellRunner` used when no `runShell` dep is injected. */
export function spawnShell(
  command: string,
  opts: { cwd: string; runAs?: string; bindings?: DeployBindings },
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const { cmd, args } = buildShellInvocation(command, {
      runAs: opts.runAs,
      bindings: opts.bindings,
    });
    const proc = spawn(cmd, args, {
      cwd: opts.cwd,
      env: buildDeployStepEnv(process.env, opts.bindings),
    });
    let out = '';
    let err = '';
    proc.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    proc.stderr?.on('data', (d: Buffer) => {
      err += d.toString();
    });
    proc.on('error', (e) =>
      resolve({
        ok: false,
        output: String(e),
        exitCode: null,
        stdout: '',
        stderr: '',
      }),
    );
    proc.on('close', (code) =>
      resolve({
        ok: code === 0,
        output: out + err,
        exitCode: code,
        stdout: out,
        stderr: err,
      }),
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
    .map(
      (d) => `symptom="${d.symptom}"; cause="${d.cause}"; action="${d.action}"`,
    )
    .join(' | ');
  return `${base} — no diagnosis matched step "${step.id}"; declared diagnoses: ${all}`;
}

/**
 * Substitutes `${NAME}`/`$NAME` binding references into a `confirm-gate`/
 * `agentic` step's `command_or_prompt` before it's surfaced — these two
 * kinds are never shell-executed, so they don't get bash's own expansion
 * for free the way `shell`/`validation` do at the spawn boundary.
 */
function substituteStepText(
  step: StepDescriptor,
  bindings: DeployBindings,
): { ok: true; step: StepDescriptor } | { ok: false; reason: string } {
  if (step.command_or_prompt === undefined) return { ok: true, step };
  const result = substituteBindings(step.command_or_prompt, bindings);
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, step: { ...step, command_or_prompt: result.value } };
}

/**
 * Every binding name referenced anywhere in a playbook's steps
 * (`command_or_prompt`, `poll_until`, `identity_capture`) — the set
 * `DeployOrchestrator`'s preflight check must confirm is fully covered by
 * the loaded bindings before any step runs.
 */
function collectReferencedBindings(playbook: DeployPlaybook): string[] {
  const names = new Set<string>();
  for (const step of playbook.steps) {
    for (const text of [
      step.command_or_prompt,
      step.poll_until,
      step.identity_capture,
    ]) {
      for (const name of extractBindingRefs(text)) names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * Preflight: confirms every binding a playbook references is present in the
 * loaded bindings map, so a missing `deploy-bindings.yml` (or a binding
 * simply never declared) is reported before any step executes — instead of
 * a mid-run `bash -uc` (nounset) failure at whichever step happens to
 * dereference it first. A playbook that references no bindings is
 * unaffected even when no bindings file exists at all.
 */
export function validateBindingReferences(
  playbook: DeployPlaybook,
  loadedBindings: Extract<LoadDeployBindingsResult, { ok: true }>,
): { ok: true } | { ok: false; reason: string } {
  const referenced = collectReferencedBindings(playbook);
  const missing = referenced.filter(
    (name) => !(name in loadedBindings.bindings),
  );
  if (missing.length === 0) return { ok: true };

  const checkedPath = loadedBindings.bindingsPath
    ? `deploy-bindings.yml at ${loadedBindings.bindingsPath}`
    : 'no resolvable central config tree (set $ORCHESTRATOR_CONFIG_DIR)';
  return {
    ok: false,
    reason: `deploy playbook references undefined binding(s): ${missing.join(', ')} — checked ${checkedPath}`,
  };
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
  private readonly loadBindings: (
    projectDir: string,
  ) => LoadDeployBindingsResult;
  private readonly runShell: ShellRunner;
  private readonly getDiffPaths: DiffProvider;
  private readonly resolveDeployTarget: DeployTargetResolver;
  private readonly now: () => string;
  private readonly pollMaxAttempts: number;
  private readonly pollDelayMs: number;
  private readonly verifyTimeoutMs: number;
  private pendingAgenticVerdicts = new Map<
    string,
    (verdict: AgenticVerdict) => void
  >();

  constructor(
    private readonly project: string,
    private readonly projectDir: string,
    private readonly deps: DeployOrchestratorDeps,
    /**
     * 'deploy' (default) drives this project's production deploy playbook;
     * 'wrap' drives the orchestrator-owned milestone-wrap playbook. Each
     * kind gets its own exclusivity lock (idx_deploy_run_active_per_project_kind
     * is scoped to (project, kind)), so a deploy and a wrap can run
     * concurrently for the same project.
     */
    private readonly kind: DeployRunKind = 'deploy',
  ) {
    this.loadPlaybook = deps.loadPlaybook ?? loadDeployPlaybook;
    this.loadBindings = deps.loadDeployBindings ?? loadDeployBindings;
    this.runShell =
      deps.runShell ??
      ((command, opts) =>
        spawnShell(command, {
          cwd: opts.cwd,
          runAs: opts.runAs,
          bindings: opts.bindings,
        }));
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
    this.verifyTimeoutMs = deps.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
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
    const loadedBindings = this.loadBindings(this.projectDir);
    if (!loadedBindings.ok) {
      throw new Error(`cannot start deploy: ${loadedBindings.reason}`);
    }
    const bindingCheck = validateBindingReferences(
      loaded.playbook,
      loadedBindings,
    );
    if (!bindingCheck.ok) {
      throw new Error(`cannot start deploy: ${bindingCheck.reason}`);
    }
    const resolvedSha =
      targetSha ?? (await this.resolveDeployTarget(this.projectDir));
    const run = startDeployRun({
      project: this.project,
      kind: this.kind,
      targetSha: resolvedSha,
      startedAt: this.now(),
    });
    const deployedShaAtStart = getProjectDeployedSha(this.project);
    void this.drive(
      run.run_id,
      loaded.playbook,
      resolvedSha,
      deployedShaAtStart,
      loadedBindings.bindings,
    );
    return run;
  }

  /**
   * Rehydrates and resumes this project's in-progress deploy_run at boot (or
   * after a self-deploy restart), continuing at `current_step`. No-op if the
   * project has no active run.
   */
  async resume(): Promise<void> {
    const active = getActiveDeployRun(this.project, this.kind);
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
    const loadedBindings = this.loadBindings(this.projectDir);
    if (!loadedBindings.ok) {
      logger.error(
        `[DeployOrchestrator] resume: cannot load deploy bindings for ${this.project} (run ${active.run_id}): ${loadedBindings.reason}`,
      );
      completeDeployRun(active.run_id, 'failed', this.now());
      this.deps.sink?.onNeedsAttention?.({
        runId: active.run_id,
        project: this.project,
        stepId: active.current_step ?? '',
        reason: `cannot resume: ${loadedBindings.reason}`,
      });
      return;
    }
    const bindingCheck = validateBindingReferences(
      loaded.playbook,
      loadedBindings,
    );
    if (!bindingCheck.ok) {
      logger.error(
        `[DeployOrchestrator] resume: ${bindingCheck.reason} for ${this.project} (run ${active.run_id})`,
      );
      completeDeployRun(active.run_id, 'failed', this.now());
      this.deps.sink?.onNeedsAttention?.({
        runId: active.run_id,
        project: this.project,
        stepId: active.current_step ?? '',
        reason: `cannot resume: ${bindingCheck.reason}`,
      });
      return;
    }
    const deployedShaAtStart = getProjectDeployedSha(this.project);
    await this.drive(
      active.run_id,
      loaded.playbook,
      active.target_sha,
      deployedShaAtStart,
      loadedBindings.bindings,
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
    const key = `${runId}:${stepId}`;
    const resolve = this.pendingAgenticVerdicts.get(key);
    if (!resolve) {
      // The step already settled (e.g. a timeout fired first) — a late or
      // duplicate report arriving after that must not append a second
      // agentic_verdict event for the same step.
      return;
    }
    appendDeployRunEvent({
      runId,
      step: stepId,
      eventType: 'agentic_verdict',
      disposition: verdict,
      detail: detail ?? null,
      at: this.now(),
    });
    this.pendingAgenticVerdicts.delete(key);
    resolve(verdict);
  }

  private async drive(
    runId: string,
    playbook: DeployPlaybook,
    targetSha: string,
    deployedShaAtStart: string | null,
    bindings: DeployBindings,
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
            bindings,
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
        outcome = await this.executeStep(
          runId,
          step,
          targetSha,
          playbook,
          bindings,
        );
      } catch (err) {
        outcome = { ok: false, detail: String(err) };
      }

      if (!outcome.ok) {
        appendDeployRunEvent({
          runId,
          step: step.id,
          eventType: outcome.timedOut ? VERIFY_TIMEOUT_EVENT : 'step_failed',
          detail: outcome.detail ?? null,
          at: this.now(),
        });
        if (step.rollback_ref) {
          await this.runCompensatingStep(
            runId,
            playbook,
            step,
            targetSha,
            bindings,
          );
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

    // A wrap run's target_sha is the milestone being closed (or the dev SHA
    // it's promoting), never a build this project's runtime is now serving
    // — only a 'deploy' run's success actually changes what's deployed.
    if (this.kind === 'deploy') {
      reportProjectDeploy(this.project, targetSha);
    }
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
    bindings: DeployBindings,
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
        bindings,
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
    bindings: DeployBindings,
  ): Promise<StepOutcome> {
    switch (step.kind) {
      case 'shell': {
        const runIt = () =>
          this.runShell(step.command_or_prompt as string, {
            runAs: step.run_as,
            cwd: this.projectDir,
            bindings,
          });
        const result =
          step.id === INSTALL_DEPS_STEP_ID &&
          sharesCheckoutNodeModules(this.projectDir)
            ? await withCheckoutInstallLock(this.projectDir, runIt)
            : await runIt();
        return {
          ok: result.ok,
          detail: result.ok ? undefined : shellFailureDetail(step.id, result),
        };
      }

      case 'validation': {
        const command = step.poll_until ?? (step.command_or_prompt as string);
        const identityCheck = this.resolveIdentityCheck(
          step,
          playbook,
          targetSha,
        );
        const deadlineMs = this.resolveVerifyDeadline(runId, step.id);
        return this.pollUntil(
          step.id,
          command,
          step.run_as,
          bindings,
          identityCheck,
          deadlineMs,
        );
      }

      case 'report-in': {
        reportProjectDeploy(this.project, targetSha);
        return { ok: true };
      }

      case 'agentic': {
        const substituted = substituteStepText(step, bindings);
        if (!substituted.ok) return { ok: false, detail: substituted.reason };
        const key = `${runId}:${step.id}`;
        const verdictPromise = new Promise<AgenticVerdict>((resolve) => {
          this.pendingAgenticVerdicts.set(key, resolve);
        });
        this.deps.spawnAgenticStep({
          runId,
          project: this.project,
          step: substituted.step,
        });
        const verdict = await verdictPromise;
        return {
          ok: verdict === 'approved',
          detail:
            verdict === 'approved'
              ? undefined
              : verdict === 'rejected'
                ? 'agentic step verdict: rejected'
                : 'agentic step verdict: inconclusive',
        };
      }

      case 'confirm-gate': {
        const substituted = substituteStepText(step, bindings);
        if (!substituted.ok) return { ok: false, detail: substituted.reason };
        const approved = await this.deps.waitForConfirmGate({
          runId,
          project: this.project,
          step: substituted.step,
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
   * For the conventional `verify` validation step, resolves the command that
   * re-reads build identity on each poll attempt (the `restart` step's
   * `identity_capture`, conventionally `curl -sf .../deploy/build-sha`) plus
   * the target it must equal — the run's own `target_sha`, never merely a
   * value that differs from some pre-restart baseline. A restart from any
   * source (an operator, a rollback, systemd's own retry) satisfies a diff
   * check; only equality with target_sha proves this run's build is what's
   * serving. Returns undefined when the playbook declares no
   * identity_capture — verify then falls back to its plain poll_until health
   * check alone.
   */
  private resolveIdentityCheck(
    step: StepDescriptor,
    playbook: DeployPlaybook,
    targetSha: string,
  ): { command: string; target: string } | undefined {
    if (step.id !== VERIFY_STEP_ID) return undefined;
    const restartStep = playbook.steps.find((s) => s.id === RESTART_STEP_ID);
    if (!restartStep?.identity_capture) return undefined;
    return { command: restartStep.identity_capture, target: targetSha };
  }

  /**
   * Bounds the conventional `verify` step's wall-clock budget, timed from
   * its own FIRST `step_started` event in this run's log rather than the
   * event about to be appended for this attempt — so a run that resumes
   * hours later (e.g. after a boot crash-loop) inherits the elapsed time
   * instead of getting a fresh unbounded window on every resume. Returns
   * `undefined` (no deadline) for any step other than `verify`.
   */
  private resolveVerifyDeadline(
    runId: string,
    stepId: string,
  ): number | undefined {
    if (stepId !== VERIFY_STEP_ID) return undefined;
    const priorStart = listDeployRunEvents(runId).find(
      (e) => e.step === stepId && e.event_type === 'step_started',
    );
    const anchor = priorStart?.at ?? this.now();
    return Date.parse(anchor) + this.verifyTimeoutMs;
  }

  private async pollUntil(
    stepId: string,
    command: string,
    runAs: string | undefined,
    bindings: DeployBindings,
    identityCheck?: { command: string; target: string },
    deadlineMs?: number,
  ): Promise<StepOutcome> {
    let lastResult: ShellResult = { ok: false, output: '', exitCode: null };
    for (let attempt = 0; attempt < this.pollMaxAttempts; attempt++) {
      if (deadlineMs !== undefined && Date.parse(this.now()) >= deadlineMs) {
        return {
          ok: false,
          timedOut: true,
          detail: `step "${stepId}" exceeded its ${this.verifyTimeoutMs}ms verify budget without confirming the target build was serving`,
        };
      }
      if (identityCheck) {
        const identityResult = await this.runShell(identityCheck.command, {
          runAs,
          cwd: this.projectDir,
          bindings,
        });
        const stderr = (identityResult.stderr ?? '').trim();
        if (stderr) {
          logger.warn(
            `[DeployOrchestrator] identity_capture re-read for step "${stepId}" wrote to stderr: ${stderr}`,
          );
        }
        const currentIdentity = normalizeIdentityCapture(
          shellStdout(identityResult),
        );
        if (!identityResult.ok || currentIdentity !== identityCheck.target) {
          lastResult = {
            ok: false,
            output: `observed build identity ("${currentIdentity}") does not equal the run's target SHA ("${identityCheck.target}")`,
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
        bindings,
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
