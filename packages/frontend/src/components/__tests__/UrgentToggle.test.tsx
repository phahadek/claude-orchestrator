import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UrgentToggle } from '../UrgentToggle';
import { CompactTaskCard } from '../CompactTaskCard';
import { TaskCard } from '../TaskCard';
import type { TaskView } from '../../types/taskView';
import type { ProjectConfig } from '@claude-orchestrator/backend/src/config';

const authedFetch = vi.fn();
vi.mock('../../api/projects', () => ({
  authedFetch: (...args: unknown[]) => authedFetch(...args),
}));

function makeTask(overrides: Partial<TaskView> = {}): TaskView {
  return {
    taskId: 'task-1',
    taskName: 'My Task',
    notionStatus: '🗂️ Ready',
    displayStatus: 'ready',
    pauseReason: null,
    priority: '🟡 Medium',
    notionUrl: 'https://notion.so/task-1',
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

const inherited = {
  group: 'urgent' as const,
  urgent: true,
  urgentInherited: true,
  urgentVia: ['other'],
  blocksCount: 0,
};

beforeEach(() => {
  authedFetch.mockReset();
  authedFetch.mockResolvedValue({ ok: true });
});

describe('UrgentToggle', () => {
  it('renders distinct off / on / inherited states', () => {
    const labels = new Set<string>();
    for (const [task, state, pressed] of [
      [makeTask(), 'off', 'false'],
      [makeTask({ urgent: true }), 'on', 'true'],
      [makeTask({ executionRank: inherited }), 'inherited', 'false'],
    ] as const) {
      const { unmount } = render(<UrgentToggle task={task} projectId="p1" />);
      const btn = screen.getByTestId('urgent-toggle');
      expect(btn.getAttribute('data-state')).toBe(state);
      expect(btn.getAttribute('aria-pressed')).toBe(pressed);
      labels.add(btn.getAttribute('aria-label')!);
      unmount();
    }
    expect(labels.size).toBe(3);
  });

  it('POSTs the negated flag and does not trigger the card click', async () => {
    const onClick = vi.fn();
    render(
      <CompactTaskCard
        task={makeTask({ taskId: 'abc', urgent: false })}
        showCheckbox={false}
        checked={false}
        onCheckChange={vi.fn()}
        onClick={onClick}
        projectId="p1"
      />,
    );
    fireEvent.click(screen.getByTestId('urgent-toggle'));
    await waitFor(() => expect(authedFetch).toHaveBeenCalledTimes(1));
    const [url, init] = authedFetch.mock.calls[0];
    expect(url).toBe('/api/tasks/abc/urgent?projectId=p1');
    expect(JSON.parse(init.body)).toEqual({ urgent: true });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('unflags a directly urgent task', async () => {
    render(<UrgentToggle task={makeTask({ urgent: true })} projectId="p1" />);
    fireEvent.click(screen.getByTestId('urgent-toggle'));
    await waitFor(() => expect(authedFetch).toHaveBeenCalled());
    expect(JSON.parse(authedFetch.mock.calls[0][1].body)).toEqual({
      urgent: false,
    });
  });

  it('shows the error in the tooltip and re-enables on failure', async () => {
    authedFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'x',
      json: async () => ({ error: 'boom' }),
    });
    render(<UrgentToggle task={makeTask()} projectId="p1" />);
    fireEvent.click(screen.getByTestId('urgent-toggle'));
    await waitFor(() =>
      expect(screen.getByTestId('urgent-toggle').title).toContain('boom'),
    );
    expect(
      (screen.getByTestId('urgent-toggle') as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('is absent for Backlog, non-Code and Done tasks, present for Ready and In Review Code', () => {
    const cases: [Partial<TaskView>, boolean][] = [
      [{ notionStatus: '🔲 Backlog', displayStatus: 'backlog' }, false],
      [{ taskType: '🔧 Operational' }, false],
      [{ notionStatus: '✅ Done', displayStatus: 'done' }, false],
      [{}, true],
      [{ notionStatus: '👀 In Review', displayStatus: 'in_review' }, true],
    ];
    for (const [overrides, present] of cases) {
      const task = makeTask(overrides);
      const compact = render(
        <CompactTaskCard
          task={task}
          showCheckbox={false}
          checked={false}
          onCheckChange={vi.fn()}
          onClick={vi.fn()}
          projectId="p1"
        />,
      );
      expect(screen.queryByTestId('urgent-toggle') !== null).toBe(present);
      compact.unmount();
      const full = render(
        <TaskCard
          task={task}
          selected={false}
          onClick={vi.fn()}
          send={vi.fn()}
          project={{ id: 'p1' } as ProjectConfig}
        />,
      );
      expect(screen.queryByTestId('urgent-toggle') !== null).toBe(present);
      full.unmount();
    }
  });
});
