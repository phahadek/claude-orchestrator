import { describe, it, expect } from 'vitest';
import { computeStages, selectAutoStage, STAGE_ORDER } from './stageSelection';
import type { TaskView } from '@claude-orchestrator/backend/src/routes/tasks';

function makeTask(overrides?: Partial<TaskView>): TaskView {
  return {
    taskId: 'task-1',
    taskName: 'Task',
    notionStatus: '🔄 In Progress',
    displayStatus: 'in_progress',
    pauseReason: null,
    priority: '',
    notionUrl: '',
    taskType: '💻 Code',
    blocked: false,
    blockerNames: [],
    wave: 1,
    codeSession: null,
    planningSession: null,
    pr: null,
    review: null,
    totalTokens: { input: 0, output: 0 },
    assignedRepo: null,
    hasAwaitingDispositionIntent: false,
    ...overrides,
  };
}

function makeCodeSession(
  overrides?: Partial<NonNullable<TaskView['codeSession']>>,
): NonNullable<TaskView['codeSession']> {
  return {
    sessionId: 'code-1',
    status: 'running',
    startedAt: 0,
    endedAt: null,
    lastMessage: '',
    inputTokens: 0,
    outputTokens: 0,
    ...overrides,
  };
}

function makePlanningSession(
  overrides?: Partial<NonNullable<TaskView['planningSession']>>,
): NonNullable<TaskView['planningSession']> {
  return {
    sessionId: 'plan-1',
    status: 'running',
    sessionType: 'design',
    startedAt: 0,
    endedAt: null,
    inputTokens: 0,
    outputTokens: 0,
    ...overrides,
  };
}

function makeReview(
  overrides?: Partial<NonNullable<TaskView['review']>>,
): NonNullable<TaskView['review']> {
  return {
    sessionId: 'review-1',
    status: 'done',
    verdict: null,
    summary: null,
    iterationCount: 1,
    inputTokens: 0,
    outputTokens: 0,
    ...overrides,
  };
}

function makePr(
  overrides?: Partial<NonNullable<TaskView['pr']>>,
): NonNullable<TaskView['pr']> {
  return {
    prNumber: 1,
    prUrl: 'https://github.com/o/r/pull/1',
    title: 'PR',
    headBranch: 'feature',
    baseBranch: 'dev',
    state: 'open',
    draft: false,
    mergeState: null,
    ...overrides,
  };
}

describe('computeStages', () => {
  it('always returns all five fixed stages, even with no content', () => {
    const stages = computeStages(makeTask());
    expect(stages.map((s) => s.id)).toEqual(STAGE_ORDER);
    expect(stages.every((s) => s.status === 'not_started')).toBe(true);
  });

  it('marks tests as not_started — no test data source exists yet', () => {
    const stages = computeStages(
      makeTask({ codeSession: makeCodeSession(), pr: makePr(), review: makeReview() }),
    );
    expect(stages.find((s) => s.id === 'tests')?.status).toBe('not_started');
  });
});

describe('selectAutoStage — precedence', () => {
  it('picks the stage with a pending decision on an otherwise-idle task', () => {
    // Otherwise idle: single done code session, no other live signal — the pending
    // staged intent is the only thing that should pull the operator's attention.
    const task = makeTask({
      codeSession: makeCodeSession({ status: 'done' }),
      hasAwaitingDispositionIntent: true,
    });
    const stages = computeStages(task);
    expect(selectAutoStage(stages)).toBe('implementation');
  });

  it('picks the furthest-progressed stage with content when there are no live signals', () => {
    const task = makeTask({
      planningSession: makePlanningSession({ status: 'done' }),
      codeSession: makeCodeSession({ status: 'done' }),
      review: makeReview({ verdict: 'approved' }),
    });
    const stages = computeStages(task);
    // review is the furthest stage (in STAGE_ORDER) that has content.
    expect(selectAutoStage(stages)).toBe('review');
  });

  it('prefers a live (active) stage over a merely furthest-progressed one', () => {
    const task = makeTask({
      planningSession: makePlanningSession({ status: 'done' }),
      codeSession: makeCodeSession({ status: 'running' }),
    });
    const stages = computeStages(task);
    expect(selectAutoStage(stages)).toBe('implementation');
  });

  it('prefers a waiting-on-you stage over a live stage', () => {
    const task = makeTask({
      codeSession: makeCodeSession({ status: 'running' }),
      review: makeReview({ verdict: 'needs_changes' }),
    });
    const stages = computeStages(task);
    expect(selectAutoStage(stages)).toBe('review');
  });

  it('four-way tie in the waiting-on-you tier resolves to the earliest stage', () => {
    // planning, implementation, review, and pr all independently qualify as
    // waiting-on-you; the earliest stage in STAGE_ORDER must win.
    const task = makeTask({
      planningSession: makePlanningSession({ status: 'needs_permission' }),
      codeSession: makeCodeSession({ status: 'needs_permission' }),
      review: makeReview({ verdict: 'needs_changes' }),
      pr: makePr({ mergeState: 'dirty' }),
    });
    const stages = computeStages(task);
    const demandStages = stages.filter((s) => s.demand).map((s) => s.id);
    expect(demandStages).toEqual(
      expect.arrayContaining(['planning', 'implementation', 'review', 'pr']),
    );
    expect(selectAutoStage(stages)).toBe('planning');
  });

  it('defaults to planning for a brand-new task with no content anywhere', () => {
    const stages = computeStages(makeTask());
    expect(selectAutoStage(stages)).toBe('planning');
  });
});
