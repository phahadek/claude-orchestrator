import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DispatchModal } from '../DispatchModal';
import type { ClientMessage } from '@claude-orchestrator/backend/src/ws/types';
import type { ResolvedTask } from '@claude-orchestrator/backend/src/notion/types';
import type { ProjectConfig } from '@claude-orchestrator/backend/src/config';

const makeTask = (
  id: string,
  title: string,
  overrides: Partial<ResolvedTask> = {},
): ResolvedTask => ({
  task: {
    id,
    title,
    status: '🗂️ Ready',
    type: '💻 Code',
    dependsOn: [],
    notionUrl: `https://notion.so/${id}`,
  },
  blocked: false,
  blockers: [],
  nonCode: false,
  wave: 1,
  ...overrides,
});

const PROJECT_ID = 'test-project-id';
const TEST_PROJECT: ProjectConfig = {
  id: PROJECT_ID,
  name: 'Test Project',
  projectDir: '/test/project',
  contextUrl: 'https://notion.so/context',
  boardId: 'test-board-id',
  taskSource: 'notion',
  autoLaunchEnabled: false,
  autoLaunchMilestoneId: null,
  autoMergeEnabled: false,
};

function renderModal(
  tasks: ResolvedTask[],
  tasksReady: boolean,
  send: (msg: ClientMessage) => void,
  onClose = vi.fn(),
  resetTasks = vi.fn(),
  milestoneId: string = 'test-milestone-id',
) {
  return render(
    <DispatchModal
      tasks={tasks}
      tasksReady={tasksReady}
      send={send}
      resetTasks={resetTasks}
      project={TEST_PROJECT}
      milestoneId={milestoneId}
      onClose={onClose}
    />,
  );
}

describe('DispatchModal', () => {
  let send: ReturnType<typeof vi.fn>;
  let onClose: ReturnType<typeof vi.fn>;
  let resetTasks: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    send = vi.fn();
    onClose = vi.fn();
    resetTasks = vi.fn();
  });

  it('fires fetch_tasks on mount with projectId and the default milestoneId', () => {
    renderModal([], false, send, onClose, resetTasks);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      type: 'fetch_tasks',
      projectId: PROJECT_ID,
      milestoneId: 'test-milestone-id',
      skipCache: true,
    });
  });

  it('fires fetch_tasks on mount with the milestoneId prop value when provided', () => {
    renderModal([], false, send, onClose, resetTasks, 'custom-milestone-id');
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      type: 'fetch_tasks',
      projectId: PROJECT_ID,
      milestoneId: 'custom-milestone-id',
      skipCache: true,
    });
  });

  it('calls resetTasks before fetch_tasks on mount', () => {
    const callOrder: string[] = [];
    const orderedResetTasks = vi.fn(() => {
      callOrder.push('resetTasks');
    });
    const orderedSend = vi.fn(() => {
      callOrder.push('send');
    });
    renderModal([], false, orderedSend, onClose, orderedResetTasks);
    expect(orderedResetTasks).toHaveBeenCalledOnce();
    expect(callOrder).toEqual(['resetTasks', 'send']);
  });

  it('shows loading state before tasksReady', () => {
    renderModal([], false, send, onClose);
    expect(screen.getByText('Fetching tasks from Notion…')).toBeTruthy();
  });

  it('clears loading when tasksReady becomes true (even with empty task list)', () => {
    const { rerender } = renderModal([], false, send, onClose, resetTasks);
    expect(screen.getByText('Fetching tasks from Notion…')).toBeTruthy();
    rerender(
      <DispatchModal
        tasks={[]}
        tasksReady={true}
        send={send}
        resetTasks={resetTasks}
        project={TEST_PROJECT}
        milestoneId="test-milestone-id"
        onClose={onClose}
      />,
    );
    expect(screen.queryByText('Fetching tasks from Notion…')).toBeNull();
    expect(screen.getByText('No unblocked tasks.')).toBeTruthy();
  });

  it('renders ready tasks with checkboxes', () => {
    const tasks = [makeTask('t1', 'Task Alpha'), makeTask('t2', 'Task Beta')];
    renderModal(tasks, true, send, onClose);
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(2);
    expect(screen.getByText('Task Alpha')).toBeTruthy();
    expect(screen.getByText('Task Beta')).toBeTruthy();
  });

  it('renders blocked tasks without checkboxes (read-only)', () => {
    const blockerTask = {
      id: 'dep1',
      title: 'Dep Task',
      status: '🔲 Backlog',
      type: '💻 Code',
      dependsOn: [],
      notionUrl: 'https://notion.so/dep1',
    };
    const tasks = [
      makeTask('t1', 'Blocked Task', {
        blocked: true,
        blockers: [blockerTask],
      }),
    ];
    renderModal(tasks, true, send, onClose);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText('Blocked Task')).toBeTruthy();
    expect(screen.getByText(/blocked by: Dep Task/)).toBeTruthy();
  });

  it('renders non-Code tasks in blocked section with non-code tag', () => {
    const tasks = [makeTask('t1', 'Planning Task', { nonCode: true })];
    renderModal(tasks, true, send, onClose);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText('non-code')).toBeTruthy();
  });

  it('ready filter requires task.type === "💻 Code" — Planning and Testing tasks are excluded even if nonCode is false', () => {
    const planningTask = makeTask('p1', 'Planning Task', {
      task: {
        id: 'p1',
        title: 'Planning Task',
        status: '🗂️ Ready',
        type: '📋 Planning',
        dependsOn: [],
        notionUrl: 'https://notion.so/p1',
      },
      nonCode: false,
    });
    const testingTask = makeTask('q1', 'Testing Task', {
      task: {
        id: 'q1',
        title: 'Testing Task',
        status: '🗂️ Ready',
        type: '🧪 Testing',
        dependsOn: [],
        notionUrl: 'https://notion.so/q1',
      },
      nonCode: false,
    });
    const codeTask = makeTask('c1', 'Code Task');
    renderModal([planningTask, testingTask, codeTask], true, send, onClose);
    // Only the Code task should have a checkbox (i.e., appear in the ready section)
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(1);
    // Code Task is in ready section
    expect(screen.getByText('Code Task')).toBeTruthy();
    // Ready count shows only 1
    expect(screen.getByRole('button', { name: /✅ Ready \(1\)/ })).toBeTruthy();
    // Planning and Testing tasks are not in the ready section (no checkbox for them)
    expect(screen.queryByText('Planning Task')).toBeNull();
    expect(screen.queryByText('Testing Task')).toBeNull();
  });

  it('Launch button is disabled when no tasks are selected', () => {
    renderModal([makeTask('t1', 'Task One')], true, send, onClose);
    const launchBtn = screen.getByRole('button', {
      name: /launch/i,
    }) as HTMLButtonElement;
    expect(launchBtn.disabled).toBe(true);
  });

  it('Launch button label reflects selected count', () => {
    const tasks = [
      makeTask('t1', 'Task One'),
      makeTask('t2', 'Task Two'),
      makeTask('t3', 'Task Three'),
    ];
    renderModal(tasks, true, send, onClose);

    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);
    expect(
      screen.getByRole('button', { name: 'Launch (1) session' }),
    ).toBeTruthy();

    fireEvent.click(checkboxes[1]);
    fireEvent.click(checkboxes[2]);
    expect(
      screen.getByRole('button', { name: 'Launch (3) sessions' }),
    ).toBeTruthy();
  });

  it('sends dispatch with taskUrl + projectContextUrl for each selected task, then calls onClose', () => {
    const tasks = [makeTask('t1', 'Task One'), makeTask('t2', 'Task Two')];
    renderModal(tasks, true, send, onClose);

    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);

    const launchBtn = screen.getByRole('button', { name: /launch/i });
    fireEvent.click(launchBtn);

    const dispatchCall = send.mock.calls.find(
      (call) => (call[0] as ClientMessage).type === 'dispatch',
    );
    expect(dispatchCall).toBeDefined();
    const dispatchMsg = dispatchCall![0] as Extract<
      ClientMessage,
      { type: 'dispatch' }
    >;
    expect(dispatchMsg.tasks).toHaveLength(2);
    expect(dispatchMsg.tasks[0].taskUrl).toBe('t1');
    expect(dispatchMsg.tasks[1].taskUrl).toBe('t2');
    expect(typeof dispatchMsg.tasks[0].projectContextUrl).toBe('string');
    expect(dispatchMsg.tasks[0].projectId).toBe(PROJECT_ID);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('dispatches t.task.id (not t.task.notionUrl) as taskUrl', () => {
    const task = makeTask('yaml-task-id', 'YAML Task');
    renderModal([task], true, send, onClose);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /launch/i }));

    const dispatchMsg = send.mock.calls
      .map((c) => c[0] as ClientMessage)
      .find((m) => m.type === 'dispatch') as Extract<
      ClientMessage,
      { type: 'dispatch' }
    >;
    expect(dispatchMsg).toBeDefined();
    expect(dispatchMsg.tasks[0].taskUrl).toBe('yaml-task-id');
    expect(dispatchMsg.tasks[0].taskUrl).not.toBe(
      'https://notion.so/yaml-task-id',
    );
  });

  it('does not send dispatch or close when no tasks selected', () => {
    renderModal([makeTask('t1', 'Task One')], true, send, onClose);
    const launchBtn = screen.getByRole('button', { name: /launch/i });
    fireEvent.click(launchBtn);
    const dispatchCalls = send.mock.calls.filter(
      (call) => (call[0] as ClientMessage).type === 'dispatch',
    );
    expect(dispatchCalls).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes when overlay is clicked', () => {
    renderModal([], true, send, onClose);
    const overlay = document.querySelector(
      '[class*="modal-overlay"]',
    ) as HTMLElement;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not close when modal content is clicked', () => {
    renderModal([], true, send, onClose);
    // Click on the heading inside the modal — stopPropagation prevents overlay close
    const heading = screen.getByRole('heading', { name: 'Launch Sessions' });
    fireEvent.click(heading);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('all groups are expanded by default', () => {
    const tasks = [
      makeTask('t1', 'Ready Task'),
      makeTask('t2', 'In Progress Task', {
        task: {
          id: 't2',
          title: 'In Progress Task',
          status: '🔄 In Progress',
          type: '💻 Code',
          dependsOn: [],
          notionUrl: 'https://notion.so/t2',
        },
      }),
    ];
    renderModal(tasks, true, send, onClose);
    expect(screen.getByText('Ready Task')).toBeTruthy();
    expect(screen.getByText('In Progress Task')).toBeTruthy();
  });

  it('clicking a group header collapses its task list', () => {
    const tasks = [
      makeTask('t1', 'Ready Task One'),
      makeTask('t2', 'Ready Task Two'),
    ];
    renderModal(tasks, true, send, onClose);
    // Initially visible
    expect(screen.getByText('Ready Task One')).toBeTruthy();
    // Click the Ready group header
    const readyHeader = screen.getByRole('button', { name: /ready/i });
    fireEvent.click(readyHeader);
    // Tasks should no longer be in the DOM
    expect(screen.queryByText('Ready Task One')).toBeNull();
    expect(screen.queryByText('Ready Task Two')).toBeNull();
  });

  it('clicking a collapsed group header expands it again', () => {
    const tasks = [makeTask('t1', 'Ready Task')];
    renderModal(tasks, true, send, onClose);
    const readyHeader = screen.getByRole('button', { name: /ready/i });
    // Collapse
    fireEvent.click(readyHeader);
    expect(screen.queryByText('Ready Task')).toBeNull();
    // Expand
    fireEvent.click(readyHeader);
    expect(screen.getByText('Ready Task')).toBeTruthy();
  });

  it('chevron has collapsed class when group is collapsed', () => {
    const tasks = [makeTask('t1', 'Ready Task')];
    renderModal(tasks, true, send, onClose);
    const readyHeader = screen.getByRole('button', { name: /ready/i });
    // Before collapse — chevron should not have the collapsed class
    const chevronBefore = readyHeader.querySelector(
      '[aria-hidden="true"]',
    ) as HTMLElement;
    expect(chevronBefore.className).not.toMatch(/chevronCollapsed/);
    // After collapse — chevron should have the collapsed class
    fireEvent.click(readyHeader);
    const chevronAfter = readyHeader.querySelector(
      '[aria-hidden="true"]',
    ) as HTMLElement;
    expect(chevronAfter.className).toMatch(/chevronCollapsed/);
  });

  it('collapsing one group does not affect other groups', () => {
    const tasks = [
      makeTask('t1', 'Ready Task'),
      makeTask('t2', 'In Progress Task', {
        task: {
          id: 't2',
          title: 'In Progress Task',
          status: '🔄 In Progress',
          type: '💻 Code',
          dependsOn: [],
          notionUrl: 'https://notion.so/t2',
        },
      }),
    ];
    renderModal(tasks, true, send, onClose);
    // Collapse only the Ready group
    const readyHeader = screen.getByRole('button', { name: /✅ ready/i });
    fireEvent.click(readyHeader);
    expect(screen.queryByText('Ready Task')).toBeNull();
    // In Progress group still visible
    expect(screen.getByText('In Progress Task')).toBeTruthy();
  });
});
