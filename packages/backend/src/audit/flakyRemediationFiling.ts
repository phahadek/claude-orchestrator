/**
 * The remediation-route half of lane-side flaky disposition (see
 * testRequestLane.ts's evaluateF2LaneFlakyDisposition and its
 * PRMergeWatcher.tryF2LaneAutoDisposition caller, the actuation this module
 * counts and reacts to): once a test's distinct-triggering-PR auto-
 * disposition count crosses flaky_remediation_file_threshold, files a
 * 💻 Code task at 🔲 Backlog against the triggering PR's own task's
 * milestone, so a chronically auto-excused test is routed into the normal
 * grooming pipeline instead of being excused indefinitely.
 *
 * Deliberately never blocks or refuses further auto-disposition — the filed
 * task and the normal grooming pipeline are the entire remediation path, per
 * the locked design's "no merge-blocking ceiling" clause.
 */
import { logger } from '../logger';
import { typedGetSetting } from '../config/settings';
import {
  recordFlakyLaneAutoDisposition,
  setFlakyRemediationLinkedTask,
  getFlakyRemediationTrackingByOpenTaskId,
  tryClaimFlakyRemediationFiling,
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

export interface FlakyRemediationTrigger {
  projectId: string;
  testId: string;
  testName: string;
  prNumber: number;
  repo: string;
  /** The triggering PR's own task id — the filed task lands on this task's milestone. */
  triggeringTaskId: string | null;
}

export interface FlakyRemediationFilingResult {
  filed: boolean;
  taskId?: string;
  reason?: string;
}

function renderRemediationTaskTitle(testId: string): string {
  return `Chronically auto-excused flaky test: ${testId}`;
}

function renderRemediationTaskBody(
  testId: string,
  testName: string,
  autoDispositionCount: number,
): string {
  return [
    '## Evidence',
    '',
    `- Test: \`${testId}\` (${testName})`,
    `- Auto-disposed by the lane-side f2-only flaky mechanism across ${autoDispositionCount} distinct triggering PRs`,
    '',
    '## Open question',
    '',
    'This test has repeatedly been auto-excused as flaky rather than blocking merges. ' +
      'Investigate and fix (or delete/rewrite) the test so it stops needing lane-side ' +
      'auto-disposition — the normal grooming pipeline owns triage from here.',
  ].join('\n');
}

/**
 * Records one lane-side f2-only auto-disposition of `trigger.testId` and, if
 * that push crosses the threshold with no currently-open linked task, files
 * a fresh 💻 Code remediation task. Non-transactional: the tracking-row
 * write and the task.create call are sibling operations, consistent with
 * this codebase's existing convention for this class of state (see
 * capability_disqualification's recordDisqualification/upsertCapabilityDisqualification).
 *
 * The "no open task yet" check and the eventual task.create call are
 * separated by an await (milestone resolution + a network call), so the
 * dedup check alone can't prevent two concurrent threshold-crossing callers
 * for the same test_id from both filing. tryClaimFlakyRemediationFiling
 * closes that race with a single atomic UPDATE ... WHERE remediation_task_open
 * = 0 — only one caller's claim can ever succeed; the loser returns
 * immediately. Never throws: every failure past the claim (including
 * backend.createTask itself) is caught, logged, and releases the claim so a
 * later threshold-crossing can retry — filing is best-effort and must never
 * block or delay the flaky rerun it's attached to.
 */
export async function recordAndMaybeFileFlakyRemediation(
  trigger: FlakyRemediationTrigger,
  options: {
    resolveBackend?: (projectId: string) => TaskBackend;
    now?: () => string;
  } = {},
): Promise<FlakyRemediationFilingResult> {
  const resolveBackend = options.resolveBackend ?? getTaskBackend;
  const now = options.now ?? (() => new Date().toISOString());
  const nowIso = now();

  const { countedThisPr, autoDispositionCount } =
    recordFlakyLaneAutoDisposition(
      trigger.testId,
      trigger.prNumber,
      trigger.repo,
      nowIso,
    );
  if (!countedThisPr) {
    return { filed: false, reason: 'already-counted-for-pr' };
  }

  const threshold = typedGetSetting('flaky_remediation_file_threshold');
  if (autoDispositionCount < threshold) {
    return { filed: false, reason: 'below-threshold' };
  }

  if (!tryClaimFlakyRemediationFiling(trigger.testId, nowIso)) {
    return { filed: false, reason: 'already-open' };
  }

  try {
    return await fileClaimedRemediationTask(
      trigger,
      autoDispositionCount,
      resolveBackend,
      now,
    );
  } catch (err) {
    logger.warn(
      `[flakyRemediationFiling] failed to file remediation task for test ${trigger.testId}: ${(err as Error).message}`,
    );
    setFlakyRemediationLinkedTask(trigger.testId, null, false, now());
    return { filed: false, reason: 'create-task-failed' };
  }
}

/**
 * The claimed tail of recordAndMaybeFileFlakyRemediation: resolves the
 * triggering task's milestone and files the task, or releases the claim
 * (returning filed: false) for every recognized "can't file right now"
 * condition — a missing triggering task, an unresolvable milestone, or a
 * backend without createTask support. Any other error (including
 * backend.createTask itself throwing) propagates to the caller's catch,
 * which releases the claim the same way.
 */
async function fileClaimedRemediationTask(
  trigger: FlakyRemediationTrigger,
  autoDispositionCount: number,
  resolveBackend: (projectId: string) => TaskBackend,
  now: () => string,
): Promise<FlakyRemediationFilingResult> {
  if (!trigger.triggeringTaskId) {
    logger.warn(
      `[flakyRemediationFiling] test ${trigger.testId} crossed threshold but the triggering PR ` +
        `(#${trigger.prNumber} ${trigger.repo}) has no task_id — skipping filing`,
    );
    setFlakyRemediationLinkedTask(trigger.testId, null, false, now());
    return { filed: false, reason: 'no-triggering-task' };
  }

  const milestone = resolveMilestoneForTaskId(
    trigger.projectId,
    trigger.triggeringTaskId,
  );
  if (!milestone) {
    logger.warn(
      `[flakyRemediationFiling] could not resolve milestone for triggering task ` +
        `${trigger.triggeringTaskId} (project ${trigger.projectId}) — skipping filing for test ${trigger.testId}`,
    );
    setFlakyRemediationLinkedTask(trigger.testId, null, false, now());
    return { filed: false, reason: 'no-resolvable-milestone' };
  }

  let databaseId: string;
  try {
    databaseId = resolveMilestoneDatabaseId(trigger.projectId, milestone);
  } catch (err) {
    if (err instanceof UnknownMilestoneError) {
      logger.warn(
        `[flakyRemediationFiling] ${err.message} — skipping filing for test ${trigger.testId}`,
      );
      setFlakyRemediationLinkedTask(trigger.testId, null, false, now());
      return { filed: false, reason: 'unknown-milestone' };
    }
    throw err;
  }

  const backend = resolveBackend(trigger.projectId);
  if (!backend.createTask) {
    logger.warn(
      `[flakyRemediationFiling] task backend for project ${trigger.projectId} does not support createTask`,
    );
    setFlakyRemediationLinkedTask(trigger.testId, null, false, now());
    return { filed: false, reason: 'backend-unsupported' };
  }

  const taskId = await backend.createTask({
    databaseId,
    title: renderRemediationTaskTitle(trigger.testId),
    type: REMEDIATION_TASK_TYPE,
    body: renderRemediationTaskBody(
      trigger.testId,
      trigger.testName,
      autoDispositionCount,
    ),
  });

  setFlakyRemediationLinkedTask(trigger.testId, taskId, true, now());

  recordEvent({
    event_type: 'flaky_remediation_task_filed',
    actor_type: 'system',
    project_id: trigger.projectId,
    task_id: taskId,
    payload: {
      test_id: trigger.testId,
      auto_disposition_count: autoDispositionCount,
      triggering_pr_number: trigger.prNumber,
      triggering_repo: trigger.repo,
      milestone,
    },
  });

  logger.info(
    `[flakyRemediationFiling] filed remediation task ${taskId} for chronically auto-excused ` +
      `test ${trigger.testId} (${autoDispositionCount} distinct triggering PRs)`,
  );

  return { filed: true, taskId };
}

/**
 * Marks the remediation task linked to `taskId`'s tracking row (if any) as
 * closed — the sole signal that clears the way for a fresh filing on that
 * test_id once a new threshold-crossing occurs. Called from wherever a task
 * reaches a terminal ('✅ Done') status; a no-op if `taskId` isn't currently
 * linked as an open remediation task.
 */
export function closeFlakyRemediationTaskIfLinked(
  taskId: string,
  nowIso: string,
): void {
  const tracking = getFlakyRemediationTrackingByOpenTaskId(taskId);
  if (!tracking) return;
  setFlakyRemediationLinkedTask(tracking.test_id, taskId, false, nowIso);
}
