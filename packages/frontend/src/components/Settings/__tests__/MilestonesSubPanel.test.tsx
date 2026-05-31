import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MilestonesSubPanel } from '../MilestonesSubPanel';
import type { Project, ProjectMilestone } from '../../../api/projects';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  delete (globalThis as { fetch?: typeof fetch }).fetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function emptyResponse(status = 204): Response {
  return new Response(null, { status });
}

const PROJECT: Project = {
  id: 'p1',
  name: 'Alpha',
  projectDir: '/abs/alpha',
  contextUrl: null,
  githubRepo: null,
  taskSource: 'notion',
  gitMode: 'github',
  autoLaunchEnabled: false,
  autoLaunchMilestoneId: null,
  autoMergeEnabled: false,
  nonMilestoneSourceConfig: null,
  dataResidencyConfirmed: false,
  createdAt: 1,
  updatedAt: 1,
  milestones: [],
};

function makeMilestone(
  overrides: Partial<ProjectMilestone> = {},
): ProjectMilestone {
  return {
    id: 'm1',
    projectId: 'p1',
    name: 'M1',
    sourceId: 'src-1',
    displayOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('MilestonesSubPanel', () => {
  it('lists milestones returned by GET /api/projects/:id/milestones', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        makeMilestone({
          id: 'm1',
          name: 'Wave A',
          sourceId: 'data-src-A',
          displayOrder: 0,
        }),
        makeMilestone({
          id: 'm2',
          name: 'Wave B',
          sourceId: 'data-src-B',
          displayOrder: 1,
        }),
      ]),
    );
    render(<MilestonesSubPanel project={PROJECT} onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Wave A')).toBeTruthy());
    expect(screen.getByText('Wave B')).toBeTruthy();
    expect(screen.getByText('data-src-A')).toBeTruthy();
    expect(screen.getByText('data-src-B')).toBeTruthy();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/p1/milestones',
      undefined,
    );
  });

  it('Add milestone POSTs to /api/projects/:id/milestones', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([])) // initial list
      .mockResolvedValueOnce(
        jsonResponse(makeMilestone({ id: 'm-new', name: 'New One' }), 201),
      )
      .mockResolvedValueOnce(
        jsonResponse([makeMilestone({ id: 'm-new', name: 'New One' })]),
      ); // reload

    render(<MilestonesSubPanel project={PROJECT} onBack={vi.fn()} />);
    await waitFor(() =>
      expect(
        screen.getByText(/No milestones yet for this project/),
      ).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole('button', { name: '+ Add milestone' }));
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'New One' },
    });
    fireEvent.change(screen.getByLabelText('Notion data source ID'), {
      target: { value: 'data-src-new' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(screen.getByText('New One')).toBeTruthy());

    const postCall = fetchMock.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect(postCall).toBeDefined();
    expect(postCall?.[0]).toBe('/api/projects/p1/milestones');
    const body = JSON.parse((postCall?.[1] as RequestInit).body as string);
    expect(body.name).toBe('New One');
    expect(body.sourceId).toBe('data-src-new');
  });

  it('Edit milestone PATCHes to /api/milestones/:id', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse([makeMilestone({ id: 'm1', name: 'Old name' })]),
      )
      .mockResolvedValueOnce(
        jsonResponse(makeMilestone({ id: 'm1', name: 'New name' })),
      )
      .mockResolvedValueOnce(
        jsonResponse([makeMilestone({ id: 'm1', name: 'New name' })]),
      );

    render(<MilestonesSubPanel project={PROJECT} onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Old name')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const nameInput = screen.getByLabelText('Name') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'New name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByText('New name')).toBeTruthy());

    const patchCall = fetchMock.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === 'PATCH',
    );
    expect(patchCall).toBeDefined();
    expect(patchCall?.[0]).toBe('/api/milestones/m1');
  });

  it('Delete shows confirm dialog and DELETEs /api/milestones/:id on confirm', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse([makeMilestone({ id: 'm1', name: 'Doomed' })]),
      )
      .mockResolvedValueOnce(emptyResponse(204))
      .mockResolvedValueOnce(jsonResponse([]));

    render(<MilestonesSubPanel project={PROJECT} onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Doomed')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(
      screen.getByRole('heading', { name: 'Delete milestone?' }),
    ).toBeTruthy();

    const dialog = screen.getByRole('dialog', {
      name: 'Confirm delete milestone',
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(
        screen.getByText(/No milestones yet for this project/),
      ).toBeTruthy(),
    );

    const deleteCall = fetchMock.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === 'DELETE',
    );
    expect(deleteCall).toBeDefined();
    expect(deleteCall?.[0]).toBe('/api/milestones/m1');
  });

  it('shows YAML-specific source label when project.taskSource is yaml', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    const yamlProject: Project = { ...PROJECT, taskSource: 'yaml' };
    render(<MilestonesSubPanel project={yamlProject} onBack={vi.fn()} />);
    await waitFor(() =>
      expect(
        screen.getByText(/No milestones yet for this project/),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: '+ Add milestone' }));
    expect(screen.getByLabelText('YAML milestone id')).toBeTruthy();
  });

  it('calls onBack when ← Projects clicked', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    const onBack = vi.fn();
    render(<MilestonesSubPanel project={PROJECT} onBack={onBack} />);
    await waitFor(() =>
      expect(
        screen.getByText(/No milestones yet for this project/),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: '← Projects' }));
    expect(onBack).toHaveBeenCalledOnce();
  });
});
