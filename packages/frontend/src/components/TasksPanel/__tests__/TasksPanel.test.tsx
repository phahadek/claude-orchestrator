import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TasksPanel } from '../TasksPanel';
import type { ResolvedTask } from '@claude-orchestrator/backend/src/notion/types';
import type { SessionState } from '../../../hooks/useSessionStore';

function makeResolvedTask(id: string, overrides: Partial<ResolvedTask['task']> = {}): ResolvedTask {
  return {
    task: {
      id,
      title: `Task ${id}`,
      status: '🗂️ Ready',
      type: '💻 Code',
      dependsOn: [],
      notionUrl: `https://notion.so/${id}`,
      priority: '🟡 Medium',
      ...overrides,
    },
    blocked: false,
    blockers: [],
    nonCode: false,
    wave: 1,
  };
}

function makeSession(sessionId: string, notionTaskUrl: string, overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionId,
    taskName: 'Some task',
    notionTaskUrl,
    status: 'running',
    events: [],
    archived: false,
    ...overrides,
  };
}

const noopSend = vi.fn().mockReturnValue(true);

describe('TasksPanel', () => {
  it('renders every task returned from fetch_tasks, including ones not linked to any session', () => {
    const tasks: ResolvedTask[] = [
      makeResolvedTask('t1', { title: 'Linked Task', status: '🔄 In Progress' }),
      makeResolvedTask('t2', { title: 'Unlinked Task', status: '🗂️ Ready' }),
      makeResolvedTask('t3', { title: 'Backlog Task', status: '🔲 Backlog' }),
    ];
    const sessions: SessionState[] = [
      makeSession('s1', 'https://notion.so/t1'),
    ];

    render(
      <TasksPanel
        projectId="p1"
        milestoneId="m1"
        milestoneName="Milestone 1"
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={noopSend}
        tasks={tasks}
        sessions={sessions}
      />,
    );

    expect(screen.getByText('Linked Task')).toBeDefined();
    expect(screen.getByText('Unlinked Task')).toBeDefined();
    expect(screen.getByText('Backlog Task')).toBeDefined();
  });

  it('switching active project triggers a refetch with the new projectId', () => {
    const send = vi.fn().mockReturnValue(true);

    const { rerender } = render(
      <TasksPanel
        projectId="p1"
        milestoneId="m1"
        milestoneName="M1"
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={send}
        tasks={[]}
        sessions={[]}
      />,
    );

    expect(send).toHaveBeenCalledWith({ type: 'fetch_tasks', projectId: 'p1', milestoneId: 'm1' });
    send.mockClear();

    rerender(
      <TasksPanel
        projectId="p2"
        milestoneId="m1"
        milestoneName="M1"
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={send}
        tasks={[]}
        sessions={[]}
      />,
    );

    expect(send).toHaveBeenCalledWith({ type: 'fetch_tasks', projectId: 'p2', milestoneId: 'm1' });
  });

  it('switching active milestone triggers a refetch with the new milestoneId', () => {
    const send = vi.fn().mockReturnValue(true);

    const { rerender } = render(
      <TasksPanel
        projectId="p1"
        milestoneId="m1"
        milestoneName="M1"
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={send}
        tasks={[]}
        sessions={[]}
      />,
    );
    send.mockClear();

    rerender(
      <TasksPanel
        projectId="p1"
        milestoneId="m2"
        milestoneName="M2"
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={send}
        tasks={[]}
        sessions={[]}
      />,
    );

    expect(send).toHaveBeenCalledWith({ type: 'fetch_tasks', projectId: 'p1', milestoneId: 'm2' });
  });

  it('renders the empty state with the milestone name when fetch_tasks returns []', () => {
    // After mount the hook flips loading=true. A subsequent tasks_ready (modeled as a new
    // empty array reference) lands and clears loading — only then does the empty state show.
    const empty1: ResolvedTask[] = [];
    const empty2: ResolvedTask[] = [];
    const { rerender, getByTestId } = render(
      <TasksPanel
        projectId="p1"
        milestoneId="m1"
        milestoneName="Sprint Q2"
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={noopSend}
        tasks={empty1}
        sessions={[]}
      />,
    );
    rerender(
      <TasksPanel
        projectId="p1"
        milestoneId="m1"
        milestoneName="Sprint Q2"
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={noopSend}
        tasks={empty2}
        sessions={[]}
      />,
    );
    const empty = getByTestId('tasks-panel-empty');
    expect(empty.textContent).toContain('No tasks in Sprint Q2');
  });

  it('a row with a linked session shows the session badge and is clickable', () => {
    const tasks: ResolvedTask[] = [
      makeResolvedTask('t1', { title: 'Linked Task', notionUrl: 'https://notion.so/t1' }),
      makeResolvedTask('t2', { title: 'Unlinked Task', notionUrl: 'https://notion.so/t2' }),
    ];
    const sessions: SessionState[] = [makeSession('session-abc', 'https://notion.so/t1')];
    const onSelectSession = vi.fn();

    render(
      <TasksPanel
        projectId="p1"
        milestoneId="m1"
        milestoneName="M1"
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        onSelectSession={onSelectSession}
        send={noopSend}
        tasks={tasks}
        sessions={sessions}
      />,
    );

    const badges = screen.getAllByTestId('tasks-panel-session-badge');
    expect(badges).toHaveLength(1);

    fireEvent.click(badges[0]);
    expect(onSelectSession).toHaveBeenCalledWith('session-abc');
  });

  it('renders a PR badge for tasks that already have a pr_url', () => {
    const tasks: ResolvedTask[] = [
      makeResolvedTask('t1', { prUrl: 'https://github.com/owner/repo/pull/42' }),
      makeResolvedTask('t2'),
    ];

    render(
      <TasksPanel
        projectId="p1"
        milestoneId="m1"
        milestoneName="M1"
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={noopSend}
        tasks={tasks}
        sessions={[]}
      />,
    );

    const prBadges = screen.getAllByTestId('tasks-panel-pr-badge');
    expect(prBadges).toHaveLength(1);
    expect(prBadges[0].getAttribute('href')).toBe('https://github.com/owner/repo/pull/42');
  });

  it('clicking a row calls onSelectTask with the task id', () => {
    const onSelectTask = vi.fn();
    const tasks: ResolvedTask[] = [makeResolvedTask('t1')];

    render(
      <TasksPanel
        projectId="p1"
        milestoneId="m1"
        milestoneName="M1"
        selectedTaskId={null}
        onSelectTask={onSelectTask}
        send={noopSend}
        tasks={tasks}
        sessions={[]}
      />,
    );

    const rows = screen.getAllByTestId('tasks-panel-row');
    fireEvent.click(rows[0]);
    expect(onSelectTask).toHaveBeenCalledWith('t1');
  });

  it('YAML repro: renders all 10 tasks regardless of status when fetch_tasks returns the full milestone', () => {
    // Mirrors the YAML integration AC — the panel must surface every task in the milestone,
    // not only the ones linked to a live session.
    const statuses = ['🔄 In Progress', '🗂️ Ready', '🔲 Backlog', '✅ Done', '👀 In Review'];
    const tasks: ResolvedTask[] = Array.from({ length: 10 }, (_, i) =>
      makeResolvedTask(`yaml-${i}`, {
        title: `YAML Task ${i}`,
        status: statuses[i % statuses.length],
      }),
    );

    render(
      <TasksPanel
        projectId="p-yaml"
        milestoneId="m-yaml"
        milestoneName="YAML Milestone"
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={noopSend}
        tasks={tasks}
        sessions={[]}
      />,
    );

    const rows = screen.getAllByTestId('tasks-panel-row');
    expect(rows).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      expect(screen.getByText(`YAML Task ${i}`)).toBeDefined();
    }
  });

  it('groups tasks by status (In Progress → Ready → Backlog → Done) and orders priorities within each group', () => {
    const tasks: ResolvedTask[] = [
      makeResolvedTask('done-low', { status: '✅ Done', priority: '🟢 Low' }),
      makeResolvedTask('ready-low', { status: '🗂️ Ready', priority: '🟢 Low' }),
      makeResolvedTask('ready-high', { status: '🗂️ Ready', priority: '🔴 High' }),
      makeResolvedTask('inprogress-medium', { status: '🔄 In Progress', priority: '🟡 Medium' }),
      makeResolvedTask('backlog-medium', { status: '🔲 Backlog', priority: '🟡 Medium' }),
    ];

    render(
      <TasksPanel
        projectId="p1"
        milestoneId="m1"
        milestoneName="M1"
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={noopSend}
        tasks={tasks}
        sessions={[]}
      />,
    );

    const rows = screen.getAllByTestId('tasks-panel-row');
    const orderedIds = rows.map((r) => r.getAttribute('data-task-id'));
    expect(orderedIds).toEqual([
      'inprogress-medium',
      'ready-high',
      'ready-low',
      'backlog-medium',
      'done-low',
    ]);
  });
});
