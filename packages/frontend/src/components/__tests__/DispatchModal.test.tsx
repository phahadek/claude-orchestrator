import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DispatchModal } from '../DispatchModal';
import type { ClientMessage } from '@claude-dashboard/backend/src/ws/types';
import type { ResolvedTask } from '@claude-dashboard/backend/src/notion/types';

const makeTask = (id: string, title: string, overrides: Partial<ResolvedTask> = {}): ResolvedTask => ({
  task: { id, title, status: '🗂️ Ready', type: '💻 Code', dependsOn: [], notionUrl: `https://notion.so/${id}` },
  blocked: false,
  blockers: [],
  nonCode: false,
  ...overrides,
});

const PROJECT_ID = 'test-project-id';

function renderModal(
  tasks: ResolvedTask[],
  tasksReady: boolean,
  send: (msg: ClientMessage) => void,
  onClose = vi.fn(),
) {
  return render(
    <DispatchModal
      tasks={tasks}
      tasksReady={tasksReady}
      send={send}
      projectId={PROJECT_ID}
      onClose={onClose}
    />,
  );
}

describe('DispatchModal', () => {
  let send: ReturnType<typeof vi.fn>;
  let onClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    send = vi.fn();
    onClose = vi.fn();
  });

  it('fires fetch_tasks on mount with the provided projectId', () => {
    renderModal([], false, send, onClose);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({ type: 'fetch_tasks', projectId: PROJECT_ID });
  });

  it('shows loading state before tasksReady', () => {
    renderModal([], false, send, onClose);
    expect(screen.getByText('Fetching tasks from Notion…')).toBeTruthy();
  });

  it('clears loading when tasksReady becomes true (even with empty task list)', () => {
    const { rerender } = renderModal([], false, send, onClose);
    expect(screen.getByText('Fetching tasks from Notion…')).toBeTruthy();
    rerender(
      <DispatchModal tasks={[]} tasksReady={true} send={send} projectId={PROJECT_ID} onClose={onClose} />,
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
    const blockerTask = { id: 'dep1', title: 'Dep Task', status: '🔲 Backlog', type: '💻 Code', dependsOn: [], notionUrl: 'https://notion.so/dep1' };
    const tasks = [
      makeTask('t1', 'Blocked Task', { blocked: true, blockers: [blockerTask] }),
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

  it('Launch button is disabled when no tasks are selected', () => {
    renderModal([makeTask('t1', 'Task One')], true, send, onClose);
    const launchBtn = screen.getByRole('button', { name: /launch/i }) as HTMLButtonElement;
    expect(launchBtn.disabled).toBe(true);
  });

  it('Launch button label reflects selected count', () => {
    const tasks = [makeTask('t1', 'Task One'), makeTask('t2', 'Task Two'), makeTask('t3', 'Task Three')];
    renderModal(tasks, true, send, onClose);

    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);
    expect(screen.getByRole('button', { name: 'Launch (1) session' })).toBeTruthy();

    fireEvent.click(checkboxes[1]);
    fireEvent.click(checkboxes[2]);
    expect(screen.getByRole('button', { name: 'Launch (3) sessions' })).toBeTruthy();
  });

  it('sends dispatch with taskUrl + projectContextUrl for each selected task, then calls onClose', () => {
    const tasks = [makeTask('t1', 'Task One'), makeTask('t2', 'Task Two')];
    renderModal(tasks, true, send, onClose);

    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);

    const launchBtn = screen.getByRole('button', { name: /launch/i });
    fireEvent.click(launchBtn);

    const dispatchCall = send.mock.calls.find((call) => (call[0] as ClientMessage).type === 'dispatch');
    expect(dispatchCall).toBeDefined();
    const dispatchMsg = dispatchCall![0] as Extract<ClientMessage, { type: 'dispatch' }>;
    expect(dispatchMsg.tasks).toHaveLength(2);
    expect(dispatchMsg.tasks[0].taskUrl).toBe('https://notion.so/t1');
    expect(dispatchMsg.tasks[1].taskUrl).toBe('https://notion.so/t2');
    expect(typeof dispatchMsg.tasks[0].projectContextUrl).toBe('string');
    expect(dispatchMsg.tasks[0].projectId).toBe(PROJECT_ID);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not send dispatch or close when no tasks selected', () => {
    renderModal([makeTask('t1', 'Task One')], true, send, onClose);
    const launchBtn = screen.getByRole('button', { name: /launch/i });
    fireEvent.click(launchBtn);
    const dispatchCalls = send.mock.calls.filter((call) => (call[0] as ClientMessage).type === 'dispatch');
    expect(dispatchCalls).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes when overlay is clicked', () => {
    renderModal([], true, send, onClose);
    const overlay = document.querySelector('[class*="modal-overlay"]') as HTMLElement;
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
});
