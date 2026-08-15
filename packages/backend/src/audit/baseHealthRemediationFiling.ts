/**
 * Files a 💻 Code remediation task the first time a project's base branch is
 * confirmed unhealthy at a given content hash (see
 * orchestration/baseHealthCheck.ts and orchestration/baseAttributableFilter.ts,
 * the sole caller). Dedup'd per content hash — a fresh confirmation only
 * recurs once the base tree itself changes (a new content hash), so there is
 * no reopen-on-task-close path the way flaky remediation has.
 *
 * Reuses flakyRemediationFiling.ts's atomic-claim/dedup shape (see
 * tryClaimBaseHealthRemediationFiling), but the trigger here is this task's
 * base-health confirmation directly — explicitly NOT that filer's flip-rate
 * flaky-detection gate (computeTestFlipRateFlag), which requires alternating
 * pass/fail outcomes for the same test and discards OOM-killed samples
 * outright, so it structurally cannot fire for a deterministic,
 * always-reproducing base break.
 */
import { logger } from '../logger';
import {
  setBaseHealthRemediationLinkedTask,
  tryClaimBaseHealthRemediationFiling,
} from '../db/queries';
import {
  resolveMilestoneDatabaseId,
  resolveMilestoneForTaskId,
  UnknownMilestoneError,
} from '../projects/milestoneResolver';
import { getTaskBackend } from '../tasks/TaskBackend';
import type { TaskBackend } from '../tasks/TaskBackend';
import { recordEvent } from './AuditLog';

const REMEDIATION_TASK_TYPE = '💻 Code';

export interface BaseHealthRemediationTrigger {
  projectId: string;
  contentHash: string;
  /** partial_fail = per-test breakdown exists; total_fail = whole-process crash, no breakdown. */
  outcome: 'partial_fail' | 'total_fail';
  /** Failing test ids, when a per-test breakdown exists (partial_fail only). */
  failingTestIds: string[];
  /** The triggering session's own task id — the filed task lands on this task's milestone. */
  triggeringTaskId: string | null;
}

export interface BaseHealthRemediationFilingResult {
  filed: boolean;
  taskId?: string;
  reason?: string;
}

function renderRemediationTaskTitle(contentHash: string): string {
  return `Base branch is broken (content hash ${contentHash.slice(0, 12)})`;
}

function renderRemediationTaskBody(
  trigger: BaseHealthRemediationTrigger,
): string {
  const lines = [
    '## Evidence',
    '',
    `- Base branch content hash: \`${trigger.contentHash}\``,
    trigger.outcome === 'total_fail'
      ? '- On-demand base-branch health check: whole-process crash — the base tree failed its own configured test commands with no per-test breakdown at all.'
      : `- On-demand base-branch health check: ${trigger.failingTestIds.length} failing test(s) on the base tree itself.`,
  ];
  if (trigger.failingTestIds.length > 0) {
    lines.push(
      `- Failing tests: ${trigger.failingTestIds.slice(0, 20).join(', ')}`,
    );
  }
  lines.push(
    '',
    '## Open question',
    '',
    'The base branch fails its own configured test commands at this content hash. ' +
      'Dispatched task sessions are having this failure filtered out of (or their whole ' +
      'run marked inconclusive in) their own test-request results so they are not blamed ' +
      'for a break that predates their diff. Investigate and fix the base branch directly.',
  );
  return lines.join('\n');
}

/**
 * If `trigger.contentHash` hasn't already been claimed for filing, files a
 * fresh 💻 Code remediation task against the triggering task's milestone.
 * Never throws: every failure past the claim (including backend.createTask
 * itself) is caught, logged, and releases the claim so a later confirmation
 * of the same content hash can retry — filing is best-effort and must never
 * block or delay the test-request result delivery it's attached to.
 */
export async function recordAndMaybeFileBaseHealthRemediation(
  trigger: BaseHealthRemediationTrigger,
  options: {
    resolveBackend?: (projectId: string) => TaskBackend;
    now?: () => string;
  } = {},
): Promise<BaseHealthRemediationFilingResult> {
  const resolveBackend = options.resolveBackend ?? getTaskBackend;
  const now = options.now ?? (() => new Date().toISOString());
  const nowIso = now();

  if (!tryClaimBaseHealthRemediationFiling(trigger.contentHash, nowIso)) {
    return { filed: false, reason: 'already-open' };
  }

  try {
    return await fileClaimedRemediationTask(trigger, resolveBackend, now);
  } catch (err) {
    logger.warn(
      `[baseHealthRemediationFiling] failed to file remediation task for base content hash ${trigger.contentHash}: ${(err as Error).message}`,
    );
    setBaseHealthRemediationLinkedTask(trigger.contentHash, null, false, now());
    return { filed: false, reason: 'create-task-failed' };
  }
}

async function fileClaimedRemediationTask(
  trigger: BaseHealthRemediationTrigger,
  resolveBackend: (projectId: string) => TaskBackend,
  now: () => string,
): Promise<BaseHealthRemediationFilingResult> {
  if (!trigger.triggeringTaskId) {
    logger.warn(
      `[baseHealthRemediationFiling] base content hash ${trigger.contentHash} confirmed unhealthy ` +
        `but has no triggering task id — skipping filing`,
    );
    setBaseHealthRemediationLinkedTask(trigger.contentHash, null, false, now());
    return { filed: false, reason: 'no-triggering-task' };
  }

  const milestone = resolveMilestoneForTaskId(
    trigger.projectId,
    trigger.triggeringTaskId,
  );
  if (!milestone) {
    logger.warn(
      `[baseHealthRemediationFiling] could not resolve milestone for triggering task ` +
        `${trigger.triggeringTaskId} (project ${trigger.projectId}) — skipping filing for content hash ${trigger.contentHash}`,
    );
    setBaseHealthRemediationLinkedTask(trigger.contentHash, null, false, now());
    return { filed: false, reason: 'no-resolvable-milestone' };
  }

  let databaseId: string;
  try {
    databaseId = resolveMilestoneDatabaseId(trigger.projectId, milestone);
  } catch (err) {
    if (err instanceof UnknownMilestoneError) {
      logger.warn(
        `[baseHealthRemediationFiling] ${err.message} — skipping filing for content hash ${trigger.contentHash}`,
      );
      setBaseHealthRemediationLinkedTask(
        trigger.contentHash,
        null,
        false,
        now(),
      );
      return { filed: false, reason: 'unknown-milestone' };
    }
    throw err;
  }

  const backend = resolveBackend(trigger.projectId);
  if (!backend.createTask) {
    logger.warn(
      `[baseHealthRemediationFiling] task backend for project ${trigger.projectId} does not support createTask`,
    );
    setBaseHealthRemediationLinkedTask(trigger.contentHash, null, false, now());
    return { filed: false, reason: 'backend-unsupported' };
  }

  const taskId = await backend.createTask({
    databaseId,
    title: renderRemediationTaskTitle(trigger.contentHash),
    type: REMEDIATION_TASK_TYPE,
    body: renderRemediationTaskBody(trigger),
  });

  setBaseHealthRemediationLinkedTask(trigger.contentHash, taskId, true, now());

  recordEvent({
    event_type: 'base_health_remediation_task_filed',
    actor_type: 'system',
    project_id: trigger.projectId,
    task_id: taskId,
    payload: {
      content_hash: trigger.contentHash,
      outcome: trigger.outcome,
      triggering_task_id: trigger.triggeringTaskId,
      milestone,
    },
  });

  logger.info(
    `[baseHealthRemediationFiling] filed remediation task ${taskId} for confirmed-unhealthy base ` +
      `content hash ${trigger.contentHash} (${trigger.outcome})`,
  );

  return { filed: true, taskId };
}
