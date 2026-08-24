/**
 * The remediation-route half of lane-side flaky disposition (see
 * testRequestLane.ts's evaluateF2LaneFlakyDisposition and its
 * PRMergeWatcher.tryF2LaneAutoDisposition caller, the actuation the lane
 * side still reacts to on its own): files an operator-selected group of
 * currently-flagged-flaky tests into a single 🔎 Investigation task at
 * 🔲 Backlog, so a group of chronically flaky tests is routed into the
 * normal grooming pipeline instead of being investigated one at a time.
 *
 * Deliberately operator-driven, not auto-filed on a threshold — the prior
 * per-test auto-filing path (and its per-triggering-PR dedup counter) has
 * been removed; the lane side's f2-only auto-disposition itself is
 * unaffected and keeps re-running clear tests without ever blocking a merge.
 */
import { logger } from '../logger';
import {
  setFlakyRemediationLinkedTask,
  getFlakyRemediationTrackingRowsByOpenTaskId,
  tryClaimFlakyRemediationFilingBatch,
  getFlaggedFlakyTestsRollup,
  getFlakyRemediationTracking,
} from '../db/queries';
import { resolveMilestoneSourceId } from '../projects/milestoneResolver';
import { getTaskBackend } from '../tasks/TaskBackend';
import type { TaskBackend } from '../tasks/TaskBackend';
import { recordEvent } from './AuditLog';

const INVESTIGATION_TASK_TYPE = '🔎 Investigation';

interface FlakyInvestigationTest {
  testId: string;
  name: string;
  transitionCount: number;
  sampleCount: number;
}

export interface FlakyInvestigationRequest {
  projectId: string;
  /** Milestone reference (DB id, display name, or canonical short id) to file the Investigation task against. */
  milestoneId: string;
  testIds: string[];
}

export interface FlakyInvestigationFilingResult {
  taskId: string;
}

/**
 * Thrown for every recognized "can't file this request" condition — the
 * caller (the route) maps `reason` to the appropriate HTTP status.
 */
export class FlakyInvestigationFilingError extends Error {
  constructor(
    public readonly reason:
      | 'no-test-ids'
      | 'not-flagged-flaky'
      | 'already-open'
      | 'claim-conflict'
      | 'unknown-milestone'
      | 'backend-unsupported',
    message: string,
  ) {
    super(message);
    this.name = 'FlakyInvestigationFilingError';
  }
}

function renderInvestigationTaskTitle(testCount: number): string {
  return `Chronically flaky test${testCount === 1 ? '' : 's'}: investigate ${testCount} flagged test${testCount === 1 ? '' : 's'}`;
}

function renderInvestigationTaskBody(tests: FlakyInvestigationTest[]): string {
  const evidenceLines = tests.map(
    (t) =>
      `- \`${t.testId}\` (${t.name}) — ${t.transitionCount} transitions across ${t.sampleCount} samples`,
  );
  return [
    '## Evidence',
    '',
    ...evidenceLines,
    '',
    '## Open question',
    '',
    `The above ${tests.length} test${tests.length === 1 ? '' : 's'} ${tests.length === 1 ? 'is' : 'are'} currently flagged flaky by the lane-side flip-rate ` +
      'mechanism. Investigate and fix (or delete/rewrite) each so it stops needing lane-side ' +
      'auto-disposition — the normal grooming pipeline owns triage from here.',
  ].join('\n');
}

/**
 * Validates every requested test_id is currently flagged flaky for the
 * project and not already tracked open, atomically claims the whole batch,
 * and files one 🔎 Investigation task covering all of them. On any failure
 * past a successful claim (including backend.createTask itself throwing),
 * every claimed test_id is released back to open=0 and the error propagates
 * — filing here is an explicit operator action, not best-effort background
 * work, so unlike the retired auto-filing path this does not swallow errors.
 */
export async function fileFlakyInvestigationTask(
  request: FlakyInvestigationRequest,
  options: {
    resolveBackend?: (projectId: string) => TaskBackend;
    now?: () => string;
  } = {},
): Promise<FlakyInvestigationFilingResult> {
  const resolveBackend = options.resolveBackend ?? getTaskBackend;
  const now = options.now ?? (() => new Date().toISOString());

  const testIds = [...new Set(request.testIds)];
  if (testIds.length === 0) {
    throw new FlakyInvestigationFilingError(
      'no-test-ids',
      'at least one test_id is required',
    );
  }

  const flagged = new Map(
    getFlaggedFlakyTestsRollup(request.projectId).map((t) => [t.testId, t]),
  );
  const notFlagged = testIds.filter((id) => !flagged.has(id));
  if (notFlagged.length > 0) {
    throw new FlakyInvestigationFilingError(
      'not-flagged-flaky',
      `not currently flagged flaky for project "${request.projectId}": ${notFlagged.join(', ')}`,
    );
  }

  const alreadyOpen = testIds.filter(
    (id) => getFlakyRemediationTracking(id)?.remediation_task_open === 1,
  );
  if (alreadyOpen.length > 0) {
    throw new FlakyInvestigationFilingError(
      'already-open',
      `already tracked under an open remediation task: ${alreadyOpen.join(', ')}`,
    );
  }

  const nowIso = now();
  if (!tryClaimFlakyRemediationFilingBatch(testIds, nowIso)) {
    throw new FlakyInvestigationFilingError(
      'claim-conflict',
      `could not claim all of: ${testIds.join(', ')} — a concurrent filing won the race`,
    );
  }

  try {
    return await fileClaimedInvestigationTask(
      request,
      testIds,
      flagged,
      resolveBackend,
      now,
    );
  } catch (err) {
    for (const testId of testIds) {
      setFlakyRemediationLinkedTask(testId, null, false, now());
    }
    throw err;
  }
}

async function fileClaimedInvestigationTask(
  request: FlakyInvestigationRequest,
  testIds: string[],
  flagged: Map<string, FlakyInvestigationTest>,
  resolveBackend: (projectId: string) => TaskBackend,
  now: () => string,
): Promise<FlakyInvestigationFilingResult> {
  let databaseId: string;
  try {
    databaseId = resolveMilestoneSourceId(
      request.projectId,
      request.milestoneId,
    );
  } catch (err) {
    throw new FlakyInvestigationFilingError(
      'unknown-milestone',
      (err as Error).message,
    );
  }

  const backend = resolveBackend(request.projectId);
  if (!backend.createTask) {
    throw new FlakyInvestigationFilingError(
      'backend-unsupported',
      `task backend for project "${request.projectId}" does not support createTask`,
    );
  }

  const tests = testIds.map((id) => flagged.get(id)!);

  const taskId = await backend.createTask({
    databaseId,
    title: renderInvestigationTaskTitle(tests.length),
    type: INVESTIGATION_TASK_TYPE,
    body: renderInvestigationTaskBody(tests),
  });

  const nowIso = now();
  for (const testId of testIds) {
    setFlakyRemediationLinkedTask(testId, taskId, true, nowIso);
  }

  recordEvent({
    event_type: 'flaky_investigation_task_filed',
    actor_type: 'human',
    project_id: request.projectId,
    task_id: taskId,
    payload: {
      test_ids: testIds,
      milestone: request.milestoneId,
    },
  });

  logger.info(
    `[flakyRemediationFiling] filed investigation task ${taskId} covering ${testIds.length} flagged flaky tests`,
  );

  return { taskId };
}

/**
 * Marks every tracking row linked to `taskId`'s remediation task as closed —
 * the sole signal that clears the way for a fresh filing on each test_id
 * once a new operator-driven investigation covers it again. A single task
 * can cover N tests, so this clears all N rows, not just one. Called from
 * wherever a task reaches a terminal status; a no-op if `taskId` isn't
 * currently linked to any open remediation tracking row.
 */
export function closeFlakyRemediationTaskIfLinked(
  taskId: string,
  nowIso: string,
): void {
  const rows = getFlakyRemediationTrackingRowsByOpenTaskId(taskId);
  for (const row of rows) {
    setFlakyRemediationLinkedTask(row.test_id, taskId, false, nowIso);
  }
}
