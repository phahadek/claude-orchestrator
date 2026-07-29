import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MilestoneDrilldown } from '../MilestoneDrilldown';
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

const noop = () => {};

describe('MilestoneDrilldown', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows an empty state when nothing is selected', () => {
    render(
      <MilestoneDrilldown
        selection={null}
        tasks={[]}
        projectId="proj-1"
        sessions={[]}
        send={noop}
        setSessionArchived={noop}
        setSessionFavorited={noop}
      />,
    );
    expect(screen.getByTestId('milestone-drilldown-empty')).toBeTruthy();
  });

  it('drives the task reader + SessionPanel embed from a selected launched task', async () => {
    vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue([]);
    const task = makeTask({
      taskId: 'task-1',
      codeSession: {
        sessionId: 'sess-1',
        status: 'running',
        startedAt: 1,
        endedAt: null,
        lastMessage: '',
        inputTokens: 0,
        outputTokens: 0,
      },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ markdown: '# Spec body' }),
      }),
    );

    render(
      <MilestoneDrilldown
        selection={{ type: 'task', task }}
        tasks={[task]}
        projectId="proj-1"
        sessions={[
          {
            sessionId: 'sess-1',
            taskName: 'Do the thing',
            notionTaskUrl: '',
            status: 'running',
            events: [],
          },
        ]}
        send={noop}
        setSessionArchived={noop}
        setSessionFavorited={noop}
      />,
    );

    await waitFor(() => expect(screen.getByText('Spec body')).toBeTruthy());
    expect(screen.getByText('No events yet.')).toBeTruthy();
  });

  it('handles an unresolvable create-intent gracefully', async () => {
    const intent: StagedIntent = {
      id: 'intent-create',
      kind: 'task.create',
      payload: { title: 'New task' },
      projectId: 'proj-1',
      createdAt: 1,
      sessionId: null,
      milestone: 'M1',
      state: 'staged',
    };

    render(
      <MilestoneDrilldown
        selection={{ type: 'intent', intent }}
        tasks={[]}
        projectId="proj-1"
        sessions={[]}
        send={noop}
        setSessionArchived={noop}
        setSessionFavorited={noop}
      />,
    );

    expect(
      screen.getByTestId('milestone-drilldown-unresolved').textContent,
    ).toContain("doesn't reference an existing task yet");
    expect(screen.getByText('No associated session.')).toBeTruthy();
  });
});
