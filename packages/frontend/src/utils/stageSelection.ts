import type { TaskView } from '@claude-orchestrator/backend/src/routes/tasks';
import type { TestLaneRunStatus } from '../hooks/useTestLaneRunStatus';

/** `implementation` | `tests` | `review` | `pr` | `planning:<kind>`. */
export type StageId = string;

type StageStatus = 'not_started' | 'active' | 'waiting' | 'done' | 'error';

export interface StageInfo {
  id: StageId;
  label: string;
  status: StageStatus;
  /** True when this stage currently needs an operator decision/action. */
  demand: boolean;
}

const STAGE_LABELS = {
  implementation: 'Implementation',
  tests: 'Tests',
  review: 'Review',
  pr: 'PR',
};

const PLANNING_KIND_LABELS: Record<string, string> = {
  groom: 'Grooming',
  design: 'Design',
  ops: 'Ops',
  docs: 'Docs',
  split: 'Split',
};

export function planningKindLabel(kind: string): string {
  return PLANNING_KIND_LABELS[kind] ?? kind;
}

function planningStageId(kind: string): StageId {
  return `planning:${kind}`;
}

/** One planning session kind's latest session, as served by detail-fields. */
export interface PlanningKindSession {
  sessionId: string;
  sessionType: string;
  status: string;
}

export type TypeFamily = 'code' | 'planning' | 'ops' | 'docs';

// Mirrors sessionPredicates.ts isTaskTypeCompatibleWithSessionType's families
// without importing it; a test pins the two together.
export function taskTypeFamily(taskType: string | undefined): TypeFamily {
  const t = taskType ?? '';
  if (/design|planning/i.test(t)) return 'planning';
  if (/operational|investigation|testing/i.test(t)) return 'ops';
  if (/docs|assets/i.test(t)) return 'docs';
  return 'code';
}

function planningStage(
  kind: string,
  session: { status: string } | null,
): StageInfo {
  const base = { id: planningStageId(kind), label: planningKindLabel(kind) };
  if (!session) {
    return { ...base, status: 'not_started', demand: false };
  }
  if (session.status === 'needs_permission') {
    return { ...base, status: 'waiting', demand: true };
  }
  if (session.status === 'done') {
    return { ...base, status: 'done', demand: false };
  }
  if (session.status === 'error' || session.status === 'killed') {
    return { ...base, status: 'error', demand: true };
  }
  return { ...base, status: 'active', demand: false };
}

function implementationStage(task: TaskView): StageInfo {
  const session = task.codeSession;
  const base = { id: 'implementation', label: STAGE_LABELS.implementation };
  if (!session) {
    return { ...base, status: 'not_started', demand: false };
  }
  if (session.status === 'needs_permission') {
    return { ...base, status: 'waiting', demand: true };
  }
  if (session.status === 'error' || session.status === 'killed') {
    return { ...base, status: 'error', demand: true };
  }
  if (session.status === 'done') {
    return { ...base, status: 'done', demand: false };
  }
  return { ...base, status: 'active', demand: false };
}

function testsStage(runStatus?: TestLaneRunStatus | null): StageInfo {
  const base = { id: 'tests' as const, label: STAGE_LABELS.tests };
  switch (runStatus) {
    case 'running':
    case 'queued':
      return { ...base, status: 'active', demand: false };
    case 'passed':
      return { ...base, status: 'done', demand: false };
    case 'failed-with-cause':
      return { ...base, status: 'error', demand: true };
    default:
      return { ...base, status: 'not_started', demand: false };
  }
}

function reviewStage(task: TaskView): StageInfo {
  const review = task.review;
  const base = { id: 'review', label: STAGE_LABELS.review };
  if (task.pauseReason === 'depth_review_escalation') {
    return { ...base, status: 'error', demand: true };
  }
  if (!review) {
    return { ...base, status: 'not_started', demand: false };
  }
  if (review.verdict === 'approved') {
    return { ...base, status: 'done', demand: false };
  }
  if (review.verdict === 'needs_changes' || review.verdict === 'incomplete') {
    return { ...base, status: 'error', demand: true };
  }
  return { ...base, status: 'active', demand: false };
}

function prStage(task: TaskView): StageInfo {
  const pr = task.pr;
  const base = { id: 'pr', label: STAGE_LABELS.pr };
  if (!pr) {
    return { ...base, status: 'not_started', demand: false };
  }
  if (pr.state === 'merged') {
    return { ...base, status: 'done', demand: false };
  }
  if (pr.state === 'closed') {
    return { ...base, status: 'error', demand: false };
  }
  if (pr.mergeState === 'dirty') {
    return { ...base, status: 'error', demand: true };
  }
  if (!pr.draft && task.review?.verdict === 'approved') {
    // Approved and open — ready to merge, waiting on the operator.
    return { ...base, status: 'waiting', demand: true };
  }
  return { ...base, status: 'active', demand: false };
}

function planningStages(
  task: TaskView,
  planningSessions: PlanningKindSession[],
): StageInfo[] {
  const live = task.planningSession;
  const stages = planningSessions.map((p) =>
    planningStage(
      p.sessionType,
      live && live.sessionType === p.sessionType ? live : p,
    ),
  );
  if (
    live &&
    !planningSessions.some((p) => p.sessionType === live.sessionType)
  ) {
    stages.push(planningStage(live.sessionType, live));
  }
  if (stages.length === 0) stages.push(planningStage('groom', null));
  return stages;
}

/**
 * Derives the stage chips for a task: one planning chip per planning session
 * kind (first-start order) followed by the stages its Type family has.
 * Task-level signals that aren't owned by any single stage (a pending staged
 * intent, a pause_reason stall) are attributed to the furthest-progressed
 * stage with content, since that's where the operator would look for them.
 */
export function computeStages(
  task: TaskView,
  planningSessions: PlanningKindSession[] = [],
  testRunStatus?: TestLaneRunStatus | null,
): StageInfo[] {
  const family = taskTypeFamily(task.taskType);
  const stages = planningStages(task, planningSessions);
  if (family === 'code') {
    stages.push(
      implementationStage(task),
      testsStage(testRunStatus),
      reviewStage(task),
      prStage(task),
    );
  } else if ((family === 'ops' || family === 'docs') && task.pr) {
    stages.push(prStage(task));
  }

  const startedIndexes = stages
    .map((s, i) => (s.status !== 'not_started' ? i : -1))
    .filter((i) => i >= 0);
  const currentIndex =
    startedIndexes.length > 0 ? startedIndexes[startedIndexes.length - 1] : 0;

  if (task.hasAwaitingDispositionIntent || task.pauseReason) {
    const current = stages[currentIndex];
    stages[currentIndex] = { ...current, demand: true };
  }

  return stages;
}

/**
 * Resolves which stage should be auto-selected, per the
 * waiting-on-you → live → furthest-progressed precedence, tie-broken
 * earliest-stage-first in rendered order.
 */
export function selectAutoStage(stages: StageInfo[]): StageId {
  const demand = stages.find((s) => s.demand);
  if (demand) return demand.id;
  const active = stages.find((s) => s.status === 'active');
  if (active) return active.id;
  let furthest = stages[0];
  for (const s of stages) {
    if (s.status !== 'not_started') furthest = s;
  }
  return furthest.id;
}
