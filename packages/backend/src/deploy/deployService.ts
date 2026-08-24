import { randomUUID } from 'crypto';
import {
  recordProjectDeployedSha,
  getProjectDeployedShaRow,
  getDeployRun as getDeployRunRow,
  getActiveDeployRunForProject,
  getLatestDeployRunForProject,
  insertDeployRun,
  updateDeployRunStep,
  updateDeployRunStatus,
  listDeployRunEvents as listDeployRunEventsRows,
  insertDeployRunEvent,
} from '../db/queries';
import type {
  DeployRunRow,
  DeployRunEventRow,
  DeployRunStatus,
  DeployRunKind,
} from '../db/types';

/**
 * The orchestrator owns the live deployed-commit record — reported in by
 * each project's deploy flow (skill→orchestrator direction), never read
 * from a deploy-written file.
 */
export function reportProjectDeploy(projectId: string, sha: string): void {
  recordProjectDeployedSha(projectId, sha);
}

/** The project's last-reported deployed SHA, or null if never reported. */
export function getProjectDeployedSha(projectId: string): string | null {
  return getProjectDeployedShaRow(projectId)?.sha ?? null;
}

/** Raised by startDeployRun when the project already has an in-flight run of the same kind. */
export class DeployRunConflictError extends Error {
  constructor(project: string, kind: DeployRunKind = 'deploy') {
    super(`deploy_run: project "${project}" already has an active ${kind} run`);
    this.name = 'DeployRunConflictError';
  }
}

export interface StartDeployRunInput {
  project: string;
  /** Defaults to 'deploy' — pass 'wrap' to start a milestone-wrap run instead. */
  kind?: DeployRunKind;
  targetSha: string;
  startedAt: string;
  runId?: string;
}

/**
 * Starts a new deploy_run. Relies on idx_deploy_run_active_per_project_kind
 * (a partial unique index on (project, kind) WHERE status = 'running') to
 * enforce the at-most-one-active-run-per-(project,kind) constraint
 * atomically — no read-then-write race between the check and the insert. A
 * deploy and a wrap run for the same project don't conflict with each other.
 */
export function startDeployRun(input: StartDeployRunInput): DeployRunRow {
  const kind = input.kind ?? 'deploy';
  const row: DeployRunRow = {
    run_id: input.runId ?? randomUUID(),
    project: input.project,
    kind,
    target_sha: input.targetSha,
    current_step: null,
    status: 'running',
    started_at: input.startedAt,
    completed_at: null,
  };
  try {
    insertDeployRun(row);
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) {
      throw new DeployRunConflictError(input.project, kind);
    }
    throw err;
  }
  return row;
}

export function getDeployRun(runId: string): DeployRunRow | undefined {
  return getDeployRunRow(runId);
}

/** The project's in-flight run of the given kind, or undefined if it has none. */
export function getActiveDeployRun(
  project: string,
  kind: DeployRunKind = 'deploy',
): DeployRunRow | undefined {
  return getActiveDeployRunForProject(project, kind);
}

/** The project's active run of the given kind, or (if none) its most recent terminal run of that kind. */
export function getLatestDeployRun(
  project: string,
  kind: DeployRunKind = 'deploy',
): DeployRunRow | undefined {
  return (
    getActiveDeployRunForProject(project, kind) ??
    getLatestDeployRunForProject(project, kind)
  );
}

/** Advances the run's step pointer — a step id in the engine's playbook, not a StepDescriptor. */
export function advanceDeployRun(runId: string, step: string): void {
  updateDeployRunStep(runId, step);
}

/** Terminates a run with a final status; completedAt marks when the engine stopped driving it. */
export function completeDeployRun(
  runId: string,
  status: Exclude<DeployRunStatus, 'running'>,
  completedAt: string,
): void {
  updateDeployRunStatus(runId, status, completedAt);
}

export interface AppendDeployRunEventInput {
  runId: string;
  step: string;
  eventType: string;
  disposition?: string | null;
  detail?: string | null;
  at: string;
}

/** Appends an immutable per-step outcome / confirm-gate disposition to a run's event log. */
export function appendDeployRunEvent(input: AppendDeployRunEventInput): void {
  insertDeployRunEvent({
    run_id: input.runId,
    step: input.step,
    event_type: input.eventType,
    disposition: input.disposition ?? null,
    detail: input.detail ?? null,
    at: input.at,
  });
}

/** A run's events in append order (oldest first). */
export function listDeployRunEvents(runId: string): DeployRunEventRow[] {
  return listDeployRunEventsRows(runId);
}
