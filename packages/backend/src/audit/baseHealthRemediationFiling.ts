/**
 * Files a 💻 Code remediation task once a project's base branch is confirmed
 * unhealthy (see orchestration/baseHealthCheck.ts and
 * orchestration/baseAttributableFilter.ts, the sole caller). Dedup'd per
 * identity, not per base-tree content hash, mirroring
 * flaky_remediation_tracking's proven reopen-on-close shape:
 *  - partial_fail: keyed per failing test id (base_health_remediation_test_tracking).
 *    A confirmation skips any test id already covered by an open remediation
 *    and claims+files only the newly-uncovered ids, so the SAME recurring
 *    failing tests never re-file just because an unrelated file changed the
 *    content hash.
 *  - total_fail: keyed per (project_id, failure_reason)
 *    (base_health_remediation_reason_tracking), gated by a counted-once-per-
 *    triggering-task guard (base_health_remediation_reason_counts) — a
 *    single triggering task's own retries get only one shot at a claim, even
 *    if the base tree moves and failure_reason drifts mid-retry.
 * Both shapes reopen once their linked task reaches a terminal status — see
 * closeBaseHealthRemediationTaskIfLinked, called from AutoMerger/
 * PRMergeWatcher's PR-merge → task-Done transition.
 *
 * Reuses flakyRemediationFiling.ts's atomic-claim/dedup shape, but the
 * trigger here is this task's base-health confirmation directly —
 * explicitly NOT that filer's flip-rate flaky-detection gate
 * (computeTestFlipRateFlag), which requires alternating pass/fail outcomes
 * for the same test and discards OOM-killed samples outright, so it
 * structurally cannot fire for a deterministic, always-reproducing base
 * break.
 */
import { logger } from '../logger';
import {
  getBaseHealthRemediationReasonTrackingByOpenTaskId,
  getBaseHealthRemediationTestTrackingByOpenTaskId,
  recordBaseHealthTotalFailCount,
  setBaseHealthRemediationReasonLinkedTask,
  setBaseHealthRemediationTestLinkedTask,
  tryClaimBaseHealthRemediationReasonFiling,
  tryClaimBaseHealthRemediationTestFiling,
} from '../db/queries';
import {
  resolveMilestoneSourceId,
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
  /** The base run's own failure_reason (total_fail only) — null falls back to 'generic'. */
  failureReason: string | null;
  /** The triggering session's own task id — the filed task lands on this task's milestone. */
  triggeringTaskId: string | null;
  /**
   * The base run's own passed/failed/total counts (partial_fail only —
   * total_fail has no per-test breakdown to count). Null when the run's
   * test_run_summaries row is unavailable; the partial-fail renderers fall
   * back to a denominator-less rendering in that case.
   */
  testCounts: { passed: number; failed: number; total: number } | null;
}

export interface BaseHealthRemediationFilingResult {
  filed: boolean;
  taskId?: string;
  reason?: string;
}

/**
 * A failure ratio above this threshold reads as the base tree itself being
 * broken; at or below it, the title states the count and denominator
 * instead of a verdict — a handful of failing tests on an otherwise-green
 * tree must not file under a headline that reads as a total outage.
 */
const PARTIAL_FAIL_BROKEN_RATIO_THRESHOLD = 0.5;

function renderPartialFailTitle(
  contentHash: string,
  testCounts: { passed: number; failed: number; total: number } | null,
): string {
  const hashSuffix = `content hash ${contentHash.slice(0, 12)}`;
  if (!testCounts || testCounts.total <= 0) {
    return `Base branch is broken (${hashSuffix})`;
  }
  const ratio = testCounts.failed / testCounts.total;
  if (ratio > PARTIAL_FAIL_BROKEN_RATIO_THRESHOLD) {
    return `Base branch is broken (${testCounts.failed} of ${testCounts.total} tests failing, ${hashSuffix})`;
  }
  return `${testCounts.failed} of ${testCounts.total} base-branch tests failing (${hashSuffix})`;
}

function renderPartialFailBody(
  trigger: BaseHealthRemediationTrigger,
  claimedTestIds: string[],
): string {
  const testCounts = trigger.testCounts;
  const lines = [
    '## Evidence',
    '',
    `- Base branch content hash: \`${trigger.contentHash}\``,
    testCounts
      ? `- Test results: ${testCounts.passed} passed, ${testCounts.failed} failed, ${testCounts.total} total.`
      : `- On-demand base-branch health check: ${claimedTestIds.length} failing test(s) on the base tree itself.`,
    `- Failing tests: ${claimedTestIds.slice(0, 20).join(', ')}`,
  ];
  const openQuestion = testCounts
    ? `${testCounts.failed} of ${testCounts.total} base-branch tests fail their own configured test commands at this ` +
      `content hash; the remaining ${testCounts.passed} passed. ` +
      'Dispatched task sessions are having this failure filtered out of (or their whole ' +
      'run marked inconclusive in) their own test-request results so they are not blamed ' +
      'for a break that predates their diff. Investigate and fix the base branch directly.'
    : 'The base branch fails its own configured test commands at this content hash. ' +
      'Dispatched task sessions are having this failure filtered out of (or their whole ' +
      'run marked inconclusive in) their own test-request results so they are not blamed ' +
      'for a break that predates their diff. Investigate and fix the base branch directly.';
  lines.push('', '## Open question', '', openQuestion);
  return lines.join('\n');
}

function renderTotalFailTitle(failureReason: string): string {
  return `Base branch is broken (failure reason ${failureReason})`;
}

function renderTotalFailBody(
  trigger: BaseHealthRemediationTrigger,
  failureReason: string,
): string {
  const lines = [
    '## Evidence',
    '',
    `- Base branch content hash: \`${trigger.contentHash}\``,
    `- Failure reason: \`${failureReason}\``,
    '- On-demand base-branch health check: whole-process crash — the base tree failed its own configured test commands with no per-test breakdown at all.',
    '',
    '## Open question',
    '',
    'The base branch fails its own configured test commands at this content hash. ' +
      'Dispatched task sessions are having this failure filtered out of (or their whole ' +
      'run marked inconclusive in) their own test-request results so they are not blamed ' +
      'for a break that predates their diff. Investigate and fix the base branch directly.',
  ];
  return lines.join('\n');
}

/**
 * If `trigger.outcome`'s dedup key hasn't already been claimed for filing
 * (per-test-id for partial_fail, per-(project, failure_reason) for
 * total_fail — see the module comment), files a fresh 💻 Code remediation
 * task against the triggering task's milestone. Never throws: every failure
 * past the claim (including backend.createTask itself) is caught, logged,
 * and releases the claim so a later confirmation can retry — filing is
 * best-effort and must never block or delay the test-request result
 * delivery it's attached to.
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

  if (trigger.outcome === 'partial_fail') {
    return recordAndMaybeFilePartialFail(trigger, resolveBackend, now);
  }
  return recordAndMaybeFileTotalFail(trigger, resolveBackend, now);
}

async function recordAndMaybeFilePartialFail(
  trigger: BaseHealthRemediationTrigger,
  resolveBackend: (projectId: string) => TaskBackend,
  now: () => string,
): Promise<BaseHealthRemediationFilingResult> {
  if (trigger.failingTestIds.length === 0) {
    // Zero-evidence partial_fail — treated like `unknown` for filing
    // purposes; nothing to key a claim off of.
    return { filed: false, reason: 'no-evidence' };
  }

  const nowIso = now();
  const claimedTestIds = tryClaimBaseHealthRemediationTestFiling(
    trigger.projectId,
    trigger.failingTestIds,
    nowIso,
  );
  if (claimedTestIds.length === 0) {
    return { filed: false, reason: 'already-open' };
  }

  try {
    return await fileClaimedPartialFailTask(
      trigger,
      claimedTestIds,
      resolveBackend,
      now,
    );
  } catch (err) {
    logger.warn(
      `[baseHealthRemediationFiling] failed to file remediation task for base content hash ${trigger.contentHash}: ${(err as Error).message}`,
    );
    setBaseHealthRemediationTestLinkedTask(
      trigger.projectId,
      claimedTestIds,
      null,
      false,
      now(),
    );
    return { filed: false, reason: 'create-task-failed' };
  }
}

async function fileClaimedPartialFailTask(
  trigger: BaseHealthRemediationTrigger,
  claimedTestIds: string[],
  resolveBackend: (projectId: string) => TaskBackend,
  now: () => string,
): Promise<BaseHealthRemediationFilingResult> {
  const release = () =>
    setBaseHealthRemediationTestLinkedTask(
      trigger.projectId,
      claimedTestIds,
      null,
      false,
      now(),
    );

  if (!trigger.triggeringTaskId) {
    logger.warn(
      `[baseHealthRemediationFiling] base content hash ${trigger.contentHash} confirmed unhealthy ` +
        `but has no triggering task id — skipping filing`,
    );
    release();
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
    release();
    return { filed: false, reason: 'no-resolvable-milestone' };
  }

  let databaseId: string;
  try {
    databaseId = resolveMilestoneSourceId(trigger.projectId, milestone);
  } catch (err) {
    if (err instanceof UnknownMilestoneError) {
      logger.warn(
        `[baseHealthRemediationFiling] ${err.message} — skipping filing for content hash ${trigger.contentHash}`,
      );
      release();
      return { filed: false, reason: 'unknown-milestone' };
    }
    throw err;
  }

  const backend = resolveBackend(trigger.projectId);
  if (!backend.createTask) {
    logger.warn(
      `[baseHealthRemediationFiling] task backend for project ${trigger.projectId} does not support createTask`,
    );
    release();
    return { filed: false, reason: 'backend-unsupported' };
  }

  const taskId = await backend.createTask({
    databaseId,
    title: renderPartialFailTitle(trigger.contentHash, trigger.testCounts),
    type: REMEDIATION_TASK_TYPE,
    body: renderPartialFailBody(trigger, claimedTestIds),
  });

  setBaseHealthRemediationTestLinkedTask(
    trigger.projectId,
    claimedTestIds,
    taskId,
    true,
    now(),
  );

  recordEvent({
    event_type: 'base_health_remediation_task_filed',
    actor_type: 'system',
    project_id: trigger.projectId,
    task_id: taskId,
    payload: {
      content_hash: trigger.contentHash,
      outcome: trigger.outcome,
      claimed_test_ids: claimedTestIds,
      triggering_task_id: trigger.triggeringTaskId,
      milestone,
    },
  });

  logger.info(
    `[baseHealthRemediationFiling] filed remediation task ${taskId} for ${claimedTestIds.length} ` +
      `newly-uncovered base-failing test(s) (content hash ${trigger.contentHash})`,
  );

  return { filed: true, taskId };
}

async function recordAndMaybeFileTotalFail(
  trigger: BaseHealthRemediationTrigger,
  resolveBackend: (projectId: string) => TaskBackend,
  now: () => string,
): Promise<BaseHealthRemediationFilingResult> {
  if (!trigger.triggeringTaskId) {
    logger.warn(
      `[baseHealthRemediationFiling] base content hash ${trigger.contentHash} confirmed unhealthy ` +
        `but has no triggering task id — skipping filing`,
    );
    return { filed: false, reason: 'no-triggering-task' };
  }

  // Resolved before the dedupe guard is claimed: a triggeringTaskId that
  // doesn't match any task on any known board (not a formatting issue —
  // e.g. it names no task at all) must never be persisted as a
  // base_health_remediation_reason_counts primary key, or that garbage
  // value would permanently occupy a guard slot for an identity nothing
  // can ever legitimately retry under.
  const milestone = resolveMilestoneForTaskId(
    trigger.projectId,
    trigger.triggeringTaskId,
  );
  if (!milestone) {
    logger.warn(
      `[baseHealthRemediationFiling] triggering task id ${trigger.triggeringTaskId} does not resolve to ` +
        `any known task (project ${trigger.projectId}) — skipping filing for content hash ${trigger.contentHash} ` +
        `without recording a dedupe claim`,
    );
    return { filed: false, reason: 'unresolvable-triggering-task' };
  }

  const nowIso = now();
  const { countedThisTask } = recordBaseHealthTotalFailCount(
    trigger.triggeringTaskId,
    nowIso,
  );
  if (!countedThisTask) {
    // This triggering task already had its one shot at a total_fail claim —
    // a pass-through no-op regardless of whether failure_reason drifted.
    return { filed: false, reason: 'already-counted-for-task' };
  }

  const failureReason = trigger.failureReason ?? 'generic';
  if (
    !tryClaimBaseHealthRemediationReasonFiling(
      trigger.projectId,
      failureReason,
      nowIso,
    )
  ) {
    return { filed: false, reason: 'already-open' };
  }

  try {
    return await fileClaimedTotalFailTask(
      trigger,
      failureReason,
      milestone,
      resolveBackend,
      now,
    );
  } catch (err) {
    logger.warn(
      `[baseHealthRemediationFiling] failed to file remediation task for base content hash ${trigger.contentHash}: ${(err as Error).message}`,
    );
    setBaseHealthRemediationReasonLinkedTask(
      trigger.projectId,
      failureReason,
      null,
      false,
      now(),
    );
    return { filed: false, reason: 'create-task-failed' };
  }
}

async function fileClaimedTotalFailTask(
  trigger: BaseHealthRemediationTrigger,
  failureReason: string,
  milestone: string,
  resolveBackend: (projectId: string) => TaskBackend,
  now: () => string,
): Promise<BaseHealthRemediationFilingResult> {
  const release = () =>
    setBaseHealthRemediationReasonLinkedTask(
      trigger.projectId,
      failureReason,
      null,
      false,
      now(),
    );

  let databaseId: string;
  try {
    databaseId = resolveMilestoneSourceId(trigger.projectId, milestone);
  } catch (err) {
    if (err instanceof UnknownMilestoneError) {
      logger.warn(
        `[baseHealthRemediationFiling] ${err.message} — skipping filing for content hash ${trigger.contentHash}`,
      );
      release();
      return { filed: false, reason: 'unknown-milestone' };
    }
    throw err;
  }

  const backend = resolveBackend(trigger.projectId);
  if (!backend.createTask) {
    logger.warn(
      `[baseHealthRemediationFiling] task backend for project ${trigger.projectId} does not support createTask`,
    );
    release();
    return { filed: false, reason: 'backend-unsupported' };
  }

  const taskId = await backend.createTask({
    databaseId,
    title: renderTotalFailTitle(failureReason),
    type: REMEDIATION_TASK_TYPE,
    body: renderTotalFailBody(trigger, failureReason),
  });

  setBaseHealthRemediationReasonLinkedTask(
    trigger.projectId,
    failureReason,
    taskId,
    true,
    now(),
  );

  recordEvent({
    event_type: 'base_health_remediation_task_filed',
    actor_type: 'system',
    project_id: trigger.projectId,
    task_id: taskId,
    payload: {
      content_hash: trigger.contentHash,
      outcome: trigger.outcome,
      failure_reason: failureReason,
      triggering_task_id: trigger.triggeringTaskId,
      milestone,
    },
  });

  logger.info(
    `[baseHealthRemediationFiling] filed remediation task ${taskId} for confirmed-unhealthy base ` +
      `failure reason ${failureReason} (content hash ${trigger.contentHash})`,
  );

  return { filed: true, taskId };
}

/**
 * Marks the remediation task linked to `taskId`'s tracking rows (if any) as
 * closed — the sole signal that clears the way for a fresh filing on those
 * test ids / that failure reason once a new confirmation occurs. Called from
 * wherever a task reaches a terminal ('✅ Done') status; a no-op if `taskId`
 * isn't currently linked as an open remediation task under either key shape.
 */
export function closeBaseHealthRemediationTaskIfLinked(
  taskId: string,
  nowIso: string,
): void {
  const testRows = getBaseHealthRemediationTestTrackingByOpenTaskId(taskId);
  if (testRows.length > 0) {
    setBaseHealthRemediationTestLinkedTask(
      testRows[0].project_id,
      testRows.map((r) => r.test_id),
      taskId,
      false,
      nowIso,
    );
  }

  const reasonRow = getBaseHealthRemediationReasonTrackingByOpenTaskId(taskId);
  if (reasonRow) {
    setBaseHealthRemediationReasonLinkedTask(
      reasonRow.project_id,
      reasonRow.failure_reason,
      taskId,
      false,
      nowIso,
    );
  }
}
