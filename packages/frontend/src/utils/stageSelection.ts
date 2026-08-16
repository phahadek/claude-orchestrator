import type { TaskView } from '@claude-orchestrator/backend/src/routes/tasks';

export type StageId = 'planning' | 'implementation' | 'tests' | 'review' | 'pr';

type StageStatus = 'not_started' | 'active' | 'waiting' | 'done' | 'error';

export interface StageInfo {
  id: StageId;
  label: string;
  status: StageStatus;
  /** True when this stage currently needs an operator decision/action. */
  demand: boolean;
}

/** Fixed left-to-right stage order — also the earliest-stage-first tie-break order. */
export const STAGE_ORDER: StageId[] = [
  'planning',
  'implementation',
  'tests',
  'review',
  'pr',
];

const STAGE_LABELS: Record<StageId, string> = {
  planning: 'Planning',
  implementation: 'Implementation',
  tests: 'Tests',
  review: 'Review',
  pr: 'PR',
};

const ACTIVE_SESSION_STATUSES = new Set(['starting', 'running', 'idle']);

function planningStage(task: TaskView): StageInfo {
  const session = task.planningSession;
  if (!session) {
    return {
      id: 'planning',
      label: STAGE_LABELS.planning,
      status: 'not_started',
      demand: false,
    };
  }
  if (session.status === 'needs_permission') {
    return {
      id: 'planning',
      label: STAGE_LABELS.planning,
      status: 'waiting',
      demand: true,
    };
  }
  if (session.status === 'done') {
    return {
      id: 'planning',
      label: STAGE_LABELS.planning,
      status: 'done',
      demand: false,
    };
  }
  if (session.status === 'error' || session.status === 'killed') {
    return {
      id: 'planning',
      label: STAGE_LABELS.planning,
      status: 'error',
      demand: true,
    };
  }
  if (ACTIVE_SESSION_STATUSES.has(session.status)) {
    return {
      id: 'planning',
      label: STAGE_LABELS.planning,
      status: 'active',
      demand: false,
    };
  }
  return {
    id: 'planning',
    label: STAGE_LABELS.planning,
    status: 'active',
    demand: false,
  };
}

function implementationStage(task: TaskView): StageInfo {
  const session = task.codeSession;
  if (!session) {
    return {
      id: 'implementation',
      label: STAGE_LABELS.implementation,
      status: 'not_started',
      demand: false,
    };
  }
  if (session.status === 'needs_permission') {
    return {
      id: 'implementation',
      label: STAGE_LABELS.implementation,
      status: 'waiting',
      demand: true,
    };
  }
  if (session.status === 'error' || session.status === 'killed') {
    return {
      id: 'implementation',
      label: STAGE_LABELS.implementation,
      status: 'error',
      demand: true,
    };
  }
  if (session.status === 'done') {
    return {
      id: 'implementation',
      label: STAGE_LABELS.implementation,
      status: 'done',
      demand: false,
    };
  }
  return {
    id: 'implementation',
    label: STAGE_LABELS.implementation,
    status: 'active',
    demand: false,
  };
}

function testsStage(): StageInfo {
  // No test-result data source exists yet — the Tests tab follow-on task wires this up.
  return {
    id: 'tests',
    label: STAGE_LABELS.tests,
    status: 'not_started',
    demand: false,
  };
}

function reviewStage(task: TaskView): StageInfo {
  const review = task.review;
  if (!review) {
    return {
      id: 'review',
      label: STAGE_LABELS.review,
      status: 'not_started',
      demand: false,
    };
  }
  if (review.verdict === 'approved') {
    return {
      id: 'review',
      label: STAGE_LABELS.review,
      status: 'done',
      demand: false,
    };
  }
  if (review.verdict === 'needs_changes' || review.verdict === 'incomplete') {
    return {
      id: 'review',
      label: STAGE_LABELS.review,
      status: 'error',
      demand: true,
    };
  }
  if (review.status === 'running' || review.status === 'starting') {
    return {
      id: 'review',
      label: STAGE_LABELS.review,
      status: 'active',
      demand: false,
    };
  }
  return {
    id: 'review',
    label: STAGE_LABELS.review,
    status: 'active',
    demand: false,
  };
}

function prStage(task: TaskView): StageInfo {
  const pr = task.pr;
  if (!pr) {
    return {
      id: 'pr',
      label: STAGE_LABELS.pr,
      status: 'not_started',
      demand: false,
    };
  }
  if (pr.state === 'merged') {
    return { id: 'pr', label: STAGE_LABELS.pr, status: 'done', demand: false };
  }
  if (pr.state === 'closed') {
    return { id: 'pr', label: STAGE_LABELS.pr, status: 'error', demand: false };
  }
  if (pr.mergeState === 'dirty') {
    return { id: 'pr', label: STAGE_LABELS.pr, status: 'error', demand: true };
  }
  if (!pr.draft && task.review?.verdict === 'approved') {
    // Approved and open — ready to merge, waiting on the operator.
    return {
      id: 'pr',
      label: STAGE_LABELS.pr,
      status: 'waiting',
      demand: true,
    };
  }
  return { id: 'pr', label: STAGE_LABELS.pr, status: 'active', demand: false };
}

/**
 * Derives the five fixed stage chips for a task. Task-level signals that
 * aren't owned by any single stage's own session/PR data (a pending staged
 * intent, a pause_reason stall) are attributed to the furthest-progressed
 * stage with content, since that's where the operator would look for them.
 */
export function computeStages(task: TaskView): StageInfo[] {
  const stages = [
    planningStage(task),
    implementationStage(task),
    testsStage(),
    reviewStage(task),
    prStage(task),
  ];

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
 * earliest-stage-first within the waiting-on-you tier.
 */
export function selectAutoStage(stages: StageInfo[]): StageId {
  const byId = new Map(stages.map((s) => [s.id, s]));

  for (const id of STAGE_ORDER) {
    if (byId.get(id)?.demand) return id;
  }

  for (const id of STAGE_ORDER) {
    if (byId.get(id)?.status === 'active') return id;
  }

  let furthest: StageId = STAGE_ORDER[0];
  for (const id of STAGE_ORDER) {
    if (byId.get(id)?.status !== 'not_started') furthest = id;
  }
  return furthest;
}
