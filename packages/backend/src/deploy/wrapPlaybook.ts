/**
 * The orchestrator-owned milestone-wrap playbook — a single, non-per-project
 * `DeployPlaybook` (see playbookSchema.ts) driven by the same
 * `DeployOrchestrator` engine a project's deploy playbook runs on, under the
 * `wrap` run kind. Mirrors the human-driven `/milestone-wrap` skill's five
 * actions (mark wrapped, carry pending gate items, repoint auto-launch,
 * advance dev->main, cut the release tag), each expressed as a
 * `StepDescriptor`; the two prod-mutating, hard-to-reverse actions
 * (repointing auto-launch and cutting the release) are preceded by their own
 * `confirm-gate` step, exactly as the skill pauses for explicit go-ahead
 * before them.
 */
import type { DeployPlaybook, StepDescriptor } from './playbookSchema';
import type { ShellResult, ShellRunner } from './DeployOrchestrator';
import { spawnShell } from './DeployOrchestrator';
import { appendDeployRunEvent, listDeployRunEvents } from './deployService';
import { ProjectService } from '../projects/ProjectService';
import { updateProject, listGateItemsByMilestone } from '../db/queries';
import { resolveMilestoneForProject } from '../projects/milestoneResolver';
import { carryForwardGateItem } from '../gate/gateService';
import { recordEvent } from '../audit/AuditLog';
import { logger } from '../logger';

/**
 * The `advance-main`/`cut-release` steps' only shell-local variable — a
 * throwaway-clone directory path, reassigned by bash on each use. The
 * engine's preflight (`validateBindingReferences`) treats every `$NAME` a
 * playbook's steps reference as a binding that must resolve, uniformly
 * across step kinds — this declares it (empty value; bash's own local
 * assignment shadows it at run time) so a plain shell-local variable
 * doesn't read as a missing binding.
 */
export const WRAP_STATIC_BINDINGS: Record<string, string> = { tmp: '' };

export const WRAP_STEP_MARK_WRAPPED = 'mark-wrapped';
export const WRAP_STEP_CARRY_GATE_ITEMS = 'carry-gate-items';
export const WRAP_STEP_CONFIRM_REPOINT = 'confirm-repoint-auto-launch';
export const WRAP_STEP_REPOINT = 'repoint-auto-launch';
export const WRAP_STEP_ADVANCE_MAIN = 'advance-main';
export const WRAP_STEP_CONFIRM_RELEASE = 'confirm-cut-release';
export const WRAP_STEP_CUT_RELEASE = 'cut-release';

export interface WrapPlaybookInput {
  projectId: string;
  closingMilestoneId: string;
  nextMilestoneId: string;
  /** e.g. "1.9.0" — used to build the "vX.Y.Z" tag cut in the final step. */
  releaseVersion: string;
  /** Git remote to clone into a throwaway directory for the dev->main/tag steps — never the prod checkout. */
  repoUrl: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// ─── Launch params (boot-resume support) ────────────────────────────────────
// A wrap run's playbook is built fresh from its WrapPlaybookInput at launch
// time (see createWrapRouter) rather than loaded from a file the way a
// project's deploy playbook is — so unlike a deploy run, there is nothing on
// disk resume() can re-read after a backend restart. Recording the exact
// input as the run's very first deploy_run_event lets a boot-time resume
// rebuild the identical playbook via buildWrapPlaybook and re-drive the run
// from its persisted current_step, the same way a deploy run survives a
// self-deploy restart.

const WRAP_LAUNCH_PARAMS_EVENT_TYPE = 'wrap_launch_params';
const WRAP_LAUNCH_PARAMS_STEP = '_meta';

export function recordWrapLaunchParams(
  runId: string,
  input: WrapPlaybookInput,
  at: string = new Date().toISOString(),
): void {
  appendDeployRunEvent({
    runId,
    step: WRAP_LAUNCH_PARAMS_STEP,
    eventType: WRAP_LAUNCH_PARAMS_EVENT_TYPE,
    detail: JSON.stringify(input),
    at,
  });
}

/** The WrapPlaybookInput a run was launched with, or null if it predates this recording (or the event is unreadable). */
export function readWrapLaunchParams(runId: string): WrapPlaybookInput | null {
  const event = listDeployRunEvents(runId).find(
    (e) => e.event_type === WRAP_LAUNCH_PARAMS_EVENT_TYPE,
  );
  if (!event?.detail) return null;
  try {
    return JSON.parse(event.detail) as WrapPlaybookInput;
  } catch {
    return null;
  }
}

/**
 * Builds the 7-`StepDescriptor` playbook for the 5 wrap actions (two of the
 * five are themselves a `confirm-gate` followed by the mutating `shell`
 * step it gates). `mark-wrapped`, `carry-gate-items`, and `repoint-auto-launch`
 * encode as `wrap-directive:` marker commands rather than literal bash —
 * see `createWrapShellRunner` — since they're pure in-process orchestrator
 * state changes; `advance-main` and `cut-release` are real shell/git
 * invocations, since they genuinely need a throwaway clone.
 */
export function buildWrapPlaybook(input: WrapPlaybookInput): DeployPlaybook {
  const {
    projectId,
    closingMilestoneId,
    nextMilestoneId,
    releaseVersion,
    repoUrl,
  } = input;
  const tag = `v${releaseVersion}`;

  const steps: StepDescriptor[] = [
    {
      id: WRAP_STEP_MARK_WRAPPED,
      kind: 'shell',
      command_or_prompt: encodeDirective({
        kind: 'mark-wrapped',
        milestoneId: closingMilestoneId,
      }),
      is_prod_mutating: true,
    },
    {
      id: WRAP_STEP_CARRY_GATE_ITEMS,
      kind: 'shell',
      command_or_prompt: encodeDirective({
        kind: 'carry-gate-items',
        projectId,
        closingMilestoneId,
        nextMilestoneId,
      }),
      is_prod_mutating: true,
    },
    {
      id: WRAP_STEP_CONFIRM_REPOINT,
      kind: 'confirm-gate',
      command_or_prompt:
        `Repoint ${projectId}'s auto_launch_milestone_id to ` +
        `${nextMilestoneId} now that ${closingMilestoneId} is wrapped? ` +
        'On an auto-launch project this turns on auto-dispatch of the ' +
        "next milestone's Ready/Code tasks.",
      is_prod_mutating: false,
    },
    {
      id: WRAP_STEP_REPOINT,
      kind: 'shell',
      command_or_prompt: encodeDirective({
        kind: 'repoint-auto-launch',
        projectId,
        nextMilestoneId,
      }),
      is_prod_mutating: true,
    },
    {
      id: WRAP_STEP_ADVANCE_MAIN,
      kind: 'shell',
      command_or_prompt: [
        'set -e',
        'tmp=$(mktemp -d)',
        `git clone --quiet ${shellQuote(repoUrl)} "$tmp"`,
        'cd "$tmp"',
        'git fetch --quiet origin main dev',
        'git checkout -B main origin/main',
        `git merge --no-ff --quiet origin/dev -m ${shellQuote(
          `chore(release): merge dev into main for milestone close (${tag})`,
        )}`,
        'git push --quiet origin main',
        'rm -rf "$tmp"',
      ].join(' && '),
      is_prod_mutating: true,
    },
    {
      id: WRAP_STEP_CONFIRM_RELEASE,
      kind: 'confirm-gate',
      command_or_prompt:
        `Cut release ${tag} on ${projectId}'s main branch and publish the ` +
        'GitHub release now? This is outward-facing — auto-updaters pick ' +
        'it up within ~24h.',
      is_prod_mutating: false,
    },
    {
      id: WRAP_STEP_CUT_RELEASE,
      kind: 'shell',
      command_or_prompt: [
        'set -e',
        'tmp=$(mktemp -d)',
        `git clone --quiet ${shellQuote(repoUrl)} "$tmp"`,
        'cd "$tmp"',
        'git fetch --quiet origin main',
        'git checkout --quiet main',
        `git tag ${shellQuote(tag)}`,
        `git push --quiet origin ${shellQuote(tag)}`,
        `gh release create ${shellQuote(tag)} --notes ${shellQuote(`Release ${tag}`)}`,
        'rm -rf "$tmp"',
      ].join(' && '),
      is_prod_mutating: true,
    },
  ];

  return { steps, hazards: [], failure_diagnoses: [], companions: [] };
}

// ─── Wrap step directives ───────────────────────────────────────────────────
// mark-wrapped/carry-gate-items/repoint-auto-launch are pure in-process
// orchestrator state changes — encoding them as a `wrap-directive:` marker
// (rather than literal bash) lets createWrapShellRunner dispatch them
// directly to the same sanctioned service functions the equivalent HTTP
// routes call, with no self-loopback HTTP hop or device-token plumbing
// needed inside the very process those routes are defined in.

type WrapDirective =
  | { kind: 'mark-wrapped'; milestoneId: string }
  | {
      kind: 'carry-gate-items';
      projectId: string;
      closingMilestoneId: string;
      nextMilestoneId: string;
    }
  | { kind: 'repoint-auto-launch'; projectId: string; nextMilestoneId: string };

const WRAP_DIRECTIVE_PREFIX = 'wrap-directive:';

function encodeDirective(directive: WrapDirective): string {
  return `${WRAP_DIRECTIVE_PREFIX}${JSON.stringify(directive)}`;
}

function decodeDirective(command: string): WrapDirective | null {
  if (!command.startsWith(WRAP_DIRECTIVE_PREFIX)) return null;
  try {
    return JSON.parse(
      command.slice(WRAP_DIRECTIVE_PREFIX.length),
    ) as WrapDirective;
  } catch {
    return null;
  }
}

export class MilestoneNotFoundError extends Error {
  constructor(milestoneId: string) {
    super(`Milestone '${milestoneId}' not found`);
    this.name = 'MilestoneNotFoundError';
  }
}

export interface MarkMilestoneWrappedResult {
  wrappedAt: number;
  /** True when the milestone was already wrapped before this call — the idempotent-success case (mirrors the route's 409 being treated as step success). */
  alreadyWrapped: boolean;
}

/**
 * In-process equivalent of `POST /api/milestones/:id/wrapped` — same
 * idempotent semantics (a milestone already wrapped is a no-op success, not
 * an error) and the same `milestone_wrapped` audit event, reused directly
 * since this step runs inside the very backend process that route is
 * defined in.
 */
export function markMilestoneWrapped(
  milestoneId: string,
  operator?: string,
): MarkMilestoneWrappedResult {
  const existing = ProjectService.getMilestone(milestoneId);
  if (!existing) throw new MilestoneNotFoundError(milestoneId);
  if (existing.wrappedAt != null) {
    return { wrappedAt: existing.wrappedAt, alreadyWrapped: true };
  }
  const wrappedAt = Date.now();
  ProjectService.updateMilestone(milestoneId, { wrapped_at: wrappedAt });
  recordEvent({
    event_type: 'milestone_wrapped',
    actor_type: operator ? 'human' : 'system',
    actor_id: operator ?? null,
    project_id: existing.projectId,
    payload: { milestoneId, wrappedAt },
  });
  return { wrappedAt, alreadyWrapped: false };
}

export interface BulkCarryGateItemsResult {
  carriedCount: number;
  carriedIds: string[];
}

/**
 * Bulk-carries every `pending` gate item on the closing milestone forward to
 * the next milestone, via the same item-level `carryForwardGateItem` a
 * single `/api/gate/items/:id/carry-forward` call uses — this step's whole
 * job is to do that for every pending item in one pass rather than one at a
 * time. Idempotent per item (carryForwardGateItem dedupes by
 * (project, milestone, text)), so a retried step is safe.
 */
export function bulkCarryPendingGateItems(
  projectId: string,
  closingMilestoneId: string,
  nextMilestoneId: string,
): BulkCarryGateItemsResult {
  const closingCanonical = resolveMilestoneForProject(
    projectId,
    closingMilestoneId,
  );
  const nextCanonical = resolveMilestoneForProject(projectId, nextMilestoneId);
  const pending = listGateItemsByMilestone(projectId, closingCanonical).filter(
    (item) => item.state === 'pending',
  );
  const carriedIds = pending.map(
    (item) => carryForwardGateItem(item.id, nextCanonical).id,
  );
  return { carriedCount: carriedIds.length, carriedIds };
}

/**
 * In-process equivalent of `PATCH /api/projects/:id` `{autoLaunchMilestoneId}`
 * — the live pointer `AutoLauncher` polls for the next milestone's
 * `Ready`/`Code` auto-dispatch.
 */
export function repointAutoLaunchMilestone(
  projectId: string,
  nextMilestoneId: string,
): void {
  const updated = updateProject(projectId, {
    auto_launch_milestone_id: nextMilestoneId,
  });
  if (!updated) {
    throw new Error(`unknown project "${projectId}"`);
  }
}

function shellOk(payload: unknown): ShellResult {
  const output = JSON.stringify(payload);
  return { ok: true, output, exitCode: 0, stdout: output, stderr: '' };
}

function shellFail(err: unknown): ShellResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    output: message,
    exitCode: 1,
    stdout: '',
    stderr: message,
  };
}

/**
 * The `ShellRunner` a wrap `DeployOrchestrator` is constructed with:
 * dispatches `wrap-directive:` marker commands to the in-process functions
 * above, and falls through to a real shell (`spawnShell` by default,
 * injectable for tests) for every other command — the `advance-main` and
 * `cut-release` steps' genuine git/gh invocations.
 */
export function createWrapShellRunner(
  fallback: ShellRunner = (command, opts) =>
    spawnShell(command, {
      cwd: opts.cwd,
      runAs: opts.runAs,
      bindings: opts.bindings,
    }),
): ShellRunner {
  return async (command, opts) => {
    const directive = decodeDirective(command);
    if (!directive) return fallback(command, opts);

    try {
      switch (directive.kind) {
        case 'mark-wrapped':
          return shellOk(markMilestoneWrapped(directive.milestoneId));
        case 'carry-gate-items':
          return shellOk(
            bulkCarryPendingGateItems(
              directive.projectId,
              directive.closingMilestoneId,
              directive.nextMilestoneId,
            ),
          );
        case 'repoint-auto-launch':
          repointAutoLaunchMilestone(
            directive.projectId,
            directive.nextMilestoneId,
          );
          return shellOk({ repointed: true });
      }
    } catch (err) {
      logger.error(
        `[wrapPlaybook] directive "${directive.kind}" failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return shellFail(err);
    }
  };
}
