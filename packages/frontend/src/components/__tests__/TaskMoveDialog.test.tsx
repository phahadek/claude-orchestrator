import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskMoveDialog } from '../TaskMoveDialog';
import { projectsApi, authedFetch } from '../../api/projects';
import { taskMoveApi } from '../../api/taskMove';
import type { TaskView } from '../../types/taskView';
import type { ProjectMilestone } from '../../api/projects';

vi.mock('../../api/projects', async () => {
  const actual = await vi.importActual<typeof import('../../api/projects')>(
    '../../api/projects',
  );
  return {
    ...actual,
    projectsApi: { listMilestones: vi.fn() },
    authedFetch: vi.fn(),
  };
});

vi.mock('../../api/taskMove', () => ({
  taskMoveApi: { preview: vi.fn() },
}));

function makeMilestone(overrides: Partial<ProjectMilestone> = {}): ProjectMilestone {
  return {
    id: 'm1',
    projectId: 'p1',
    name: 'Milestone 1',
    sourceId: 'db-1',
    displayOrder: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeTask(overrides: Partial<TaskView> = {}): TaskView {
  return {
    taskId: 't1',
    taskName: 'Test task',
    notionStatus: 'Backlog',
    displayStatus: 'backlog',
    pauseReason: null,
    priority: 'P2',
    notionUrl: 'https://notion.so/t1',
    taskType: 'feature',
    blocked: false,
    blockerNames: [],
    wave: 0,
    codeSession: null,
    ...overrides,
  } as unknown as TaskView;
}

const milestones = [
  makeMilestone({ id: 'm11', name: 'M11', sourceId: 'db-11' }),
  makeMilestone({ id: 'm12', name: 'M12', sourceId: 'db-12' }),
];

async function selectTarget(targetId: string) {
  const select = await screen.findByRole('combobox');
  const { fireEvent } = await import('@testing-library/react');
  fireEvent.change(select, { target: { value: targetId } });
}

describe('TaskMoveDialog', () => {
  beforeEach(() => {
    vi.mocked(projectsApi.listMilestones).mockResolvedValue(milestones);
    vi.mocked(authedFetch).mockResolvedValue({
      json: async () => ({ markdown: '' }),
    } as Response);
  });

  it('enables Stage Move for a simple archive move with no cascade impact', async () => {
    vi.mocked(taskMoveApi.preview).mockResolvedValue({
      ok: true,
      isLaterMove: false,
      cascadeSet: [],
      droppedEdges: [],
    });

    render(
      <TaskMoveDialog
        task={makeTask()}
        projectId="p1"
        currentBoardId="db-11"
        onClose={vi.fn()}
        onStaged={vi.fn()}
      />,
    );

    await selectTarget('m12');

    const stageButton = await screen.findByRole('button', { name: /stage move/i });
    await waitFor(() => expect(stageButton.hasAttribute('disabled')).toBe(false));
  });

  it('enables Stage Move for a later move with no dependents, without requiring cascade confirm', async () => {
    vi.mocked(taskMoveApi.preview).mockResolvedValue({
      ok: true,
      isLaterMove: true,
      cascadeSet: [],
      droppedEdges: [],
    });

    render(
      <TaskMoveDialog
        task={makeTask()}
        projectId="p1"
        currentBoardId="db-11"
        onClose={vi.fn()}
        onStaged={vi.fn()}
      />,
    );

    await selectTarget('m12');

    const stageButton = await screen.findByRole('button', { name: /stage move/i });
    await waitFor(() => expect(stageButton.hasAttribute('disabled')).toBe(false));
    expect(screen.queryByText(/i confirm moving this whole set/i)).toBeNull();
  });

  it('keeps Stage Move disabled for a later move with dependents until cascade is confirmed', async () => {
    vi.mocked(taskMoveApi.preview).mockResolvedValue({
      ok: true,
      isLaterMove: true,
      cascadeSet: ['t2', 't3'],
      droppedEdges: [],
    });

    render(
      <TaskMoveDialog
        task={makeTask()}
        projectId="p1"
        currentBoardId="db-11"
        onClose={vi.fn()}
        onStaged={vi.fn()}
      />,
    );

    await selectTarget('m12');

    const stageButton = await screen.findByRole('button', { name: /stage move/i });
    await waitFor(() => expect(stageButton.hasAttribute('disabled')).toBe(true));

    const checkbox = await screen.findByRole('checkbox');
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(checkbox);

    await waitFor(() => expect(stageButton.hasAttribute('disabled')).toBe(false));
  });

  it('keeps Stage Move disabled and shows the refusal reason for a refused move', async () => {
    vi.mocked(taskMoveApi.preview).mockRejectedValue(new Error('Move would break dependency order'));

    render(
      <TaskMoveDialog
        task={makeTask()}
        projectId="p1"
        currentBoardId="db-11"
        onClose={vi.fn()}
        onStaged={vi.fn()}
      />,
    );

    await selectTarget('m12');

    const refusal = await screen.findByTestId('move-refusal-reason');
    expect(refusal.textContent).toContain('Move would break dependency order');

    const stageButton = screen.getByRole('button', { name: /stage move/i });
    expect(stageButton.hasAttribute('disabled')).toBe(true);
  });
});
