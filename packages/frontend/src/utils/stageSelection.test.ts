import { describe, it, expect } from 'vitest';
import {
  computeStages,
  selectAutoStage,
  taskTypeFamily,
  type PlanningKindSession,
  type TypeFamily,
} from './stageSelection';
import { isTaskTypeCompatibleWithSessionType } from '@claude-orchestrator/backend/src/session/sessionPredicates';
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
    state: 'open',
    draft: false,
    mergeState: null,
    ...overrides,
  };
}

const ids = (task: TaskView, planning: PlanningKindSession[] = []) =>
  computeStages(task, planning).map((s) => s.id);

describe('computeStages — stage set per Type', () => {
  const CODE_SET = [
    'planning:groom',
    'implementation',
    'tests',
    'review',
    'pr',
  ];

  it('Code: not-started grooming chip, then the four code stages', () => {
    const stages = computeStages(makeTask());
    expect(stages.map((s) => s.id)).toEqual(CODE_SET);
    expect(stages.every((s) => s.status === 'not_started')).toBe(true);
  });

  it('unknown or missing Type falls back to Code', () => {
    expect(ids(makeTask({ taskType: 'Mystery' }))).toEqual(CODE_SET);
    expect(ids(makeTask({ taskType: undefined as unknown as string }))).toEqual(
      CODE_SET,
    );
  });

  it('Design and Planning: planning chips only', () => {
    expect(ids(makeTask({ taskType: '📐 Design' }))).toEqual([
      'planning:groom',
    ]);
    expect(ids(makeTask({ taskType: '📋 Planning' }))).toEqual([
      'planning:groom',
    ]);
  });

  it('Docs: PR chip only when the task has a PR', () => {
    expect(ids(makeTask({ taskType: '📝 Docs' }))).toEqual(['planning:groom']);
    expect(ids(makeTask({ taskType: '📝 Docs', pr: makePr() }))).toEqual([
      'planning:groom',
      'pr',
    ]);
  });

  it('Testing is ops family: no Implementation/Review', () => {
    expect(ids(makeTask({ taskType: '🧪 Testing', pr: makePr() }))).toEqual([
      'planning:groom',
      'pr',
    ]);
    expect(ids(makeTask({ taskType: '🧪 Testing' }))).toEqual([
      'planning:groom',
    ]);
  });

  it('one chip per planning kind in given order, labelled by kind', () => {
    const stages = computeStages(makeTask(), [
      { sessionId: 'a', sessionType: 'groom', status: 'done' },
      { sessionId: 'b', sessionType: 'design', status: 'running' },
      { sessionId: 'c', sessionType: 'split', status: 'done' },
      { sessionId: 'd', sessionType: 'docs', status: 'done' },
    ]);
    expect(stages.slice(0, 4).map((s) => [s.id, s.label, s.status])).toEqual([
      ['planning:groom', 'Grooming', 'done'],
      ['planning:design', 'Design', 'active'],
      ['planning:split', 'Split', 'done'],
      ['planning:docs', 'Docs', 'done'],
    ]);
  });

  it('task.planningSession overrides its own kind chip status', () => {
    const stages = computeStages(
      makeTask({
        planningSession: makePlanningSession({
          sessionType: 'design',
          status: 'needs_permission',
        }),
      }),
      [
        { sessionId: 'a', sessionType: 'groom', status: 'done' },
        { sessionId: 'b', sessionType: 'design', status: 'done' },
      ],
    );
    expect(stages[0].status).toBe('done');
    expect(stages[1].status).toBe('waiting');
    expect(stages[1].demand).toBe(true);
  });

  it('agrees with isTaskTypeCompatibleWithSessionType families', () => {
    const samples: Record<TypeFamily, string[]> = {
      code: ['💻 Code'],
      planning: ['📐 Design', '📋 Planning'],
      ops: ['🔧 Operational', '🔎 Investigation', '🧪 Testing'],
      docs: ['📝 Docs', '🎨 Assets'],
    };
    const sessionTypeFor: Record<TypeFamily, string> = {
      code: 'standard',
      planning: 'design',
      ops: 'ops',
      docs: 'docs',
    };
    const families = Object.keys(samples) as TypeFamily[];
    for (const family of families) {
      for (const type of samples[family]) {
        expect(taskTypeFamily(type)).toBe(family);
        for (const other of families) {
          expect(
            isTaskTypeCompatibleWithSessionType(type, sessionTypeFor[other]),
          ).toBe(other === family);
        }
      }
    }
  });

  it('marks tests as not_started — no test data source exists yet', () => {
    const stages = computeStages(
      makeTask({
        codeSession: makeCodeSession(),
        pr: makePr(),
        review: makeReview(),
      }),
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
      expect.arrayContaining([
        'planning:design',
        'implementation',
        'review',
        'pr',
      ]),
    );
    expect(selectAutoStage(stages)).toBe('planning:design');
  });

  it('picks the earliest demand chip in rendered order among planning chips', () => {
    const stages = computeStages(makeTask({ taskType: '📐 Design' }), [
      { sessionId: 'a', sessionType: 'groom', status: 'error' },
      { sessionId: 'b', sessionType: 'design', status: 'needs_permission' },
    ]);
    expect(selectAutoStage(stages)).toBe('planning:groom');
  });

  it('defaults to the first planning chip for a brand-new task', () => {
    const stages = computeStages(makeTask());
    expect(selectAutoStage(stages)).toBe('planning:groom');
  });
});
