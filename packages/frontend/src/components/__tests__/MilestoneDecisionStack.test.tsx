import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MilestoneDecisionStack } from '../MilestoneDecisionStack';
import { stagedIntentsApi } from '../../api/stagedIntents';
import type { StagedIntent } from '../../api/stagedIntents';
import type { TaskView } from '../../types/taskView';

vi.mock('../../hooks/stagedIntentBus', () => ({
  subscribeStagedIntentChange: () => () => {},
}));

function makeTask(overrides: Partial<TaskView>): TaskView {
  return {
    taskId: 'task-1',
    taskName: 'Do the thing',
    notionStatus: '🔄 In Progress',
    displayStatus: 'in_progress',
    pauseReason: null,
    priority: '🟡 Medium',
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
    ...overrides,
  };
}

describe('MilestoneDecisionStack', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sorts tasks into not-yet-launched vs done, honouring the phase filter', async () => {
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([]);
    const tasks: TaskView[] = [
      makeTask({ taskId: 'wave1-open', taskName: 'Wave 1 open', wave: 1 }),
      makeTask({
        taskId: 'wave1-launched',
        taskName: 'Wave 1 launched',
        wave: 1,
        codeSession: {
          sessionId: 'sess-1',
          status: 'running',
          startedAt: 1,
          endedAt: null,
          lastMessage: '',
          inputTokens: 0,
          outputTokens: 0,
        },
      }),
      makeTask({
        taskId: 'wave1-done',
        taskName: 'Wave 1 done',
        wave: 1,
        displayStatus: 'done',
        notionStatus: '✅ Done',
      }),
      makeTask({ taskId: 'wave2-open', taskName: 'Wave 2 open', wave: 2 }),
    ];

    const onSelect = vi.fn();
    render(
      <MilestoneDecisionStack
        projectId="proj-1"
        milestone="M1"
        tasks={tasks}
        phaseFilter="1"
        selection={null}
        onSelect={onSelect}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId('milestone-decision-stack')).toBeTruthy(),
    );

    expect(screen.getByTestId('milestone-task-row-wave1-open')).toBeTruthy();
    expect(screen.getByTestId('milestone-task-row-wave1-done')).toBeTruthy();
    expect(
      screen.queryByTestId('milestone-task-row-wave1-launched'),
    ).toBeNull();
    expect(screen.queryByTestId('milestone-task-row-wave2-open')).toBeNull();

    fireEvent.click(screen.getByTestId('milestone-task-row-wave1-open'));
    expect(onSelect).toHaveBeenCalledWith({
      type: 'task',
      task: tasks[0],
    });
  });

  it('drives selection from a pending intent card in the composed MilestoneDecisionInbox', async () => {
    const intents: StagedIntent[] = [
      {
        id: 'intent-1',
        kind: 'task.setStatus',
        payload: { taskId: 'task-1', status: 'Ready' },
        projectId: 'proj-1',
        createdAt: 100,
        sessionId: 'session-1',
        milestone: 'M1',
        state: 'staged',
      },
    ];
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue(intents);

    const onSelect = vi.fn();
    render(
      <MilestoneDecisionStack
        projectId="proj-1"
        milestone="M1"
        tasks={[]}
        phaseFilter={null}
        selection={null}
        onSelect={onSelect}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByTestId('milestone-decision-card-intent-1'),
      ).toBeTruthy(),
    );

    fireEvent.click(screen.getByTestId('milestone-decision-card-intent-1'));
    expect(onSelect).toHaveBeenCalledWith({
      type: 'intent',
      intent: intents[0],
    });
  });
});
