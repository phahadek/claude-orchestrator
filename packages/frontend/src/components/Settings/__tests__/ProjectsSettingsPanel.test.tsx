import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProjectsSettingsPanel } from '../ProjectsSettingsPanel';
import type { Project } from '../../../api/projects';

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

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Project Alpha',
    projectDir: '/abs/alpha',
    contextUrl: null,
    githubRepo: 'owner/alpha',
    taskSource: 'notion',
    autoLaunchEnabled: false,
    autoLaunchMilestoneId: null,
    autoMergeEnabled: false,
    createdAt: 1,
    updatedAt: 1,
    milestones: [],
    ...overrides,
  };
}

describe('ProjectsSettingsPanel', () => {
  it('shows empty-state message when no projects exist', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    render(<ProjectsSettingsPanel />);
    await waitFor(() =>
      expect(screen.getByText(/No projects configured yet/)).toBeTruthy(),
    );
  });

  it('renders a row per project with name, dir, taskSource, milestone count, and repo', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        makeProject({
          id: 'p1',
          name: 'Alpha',
          projectDir: '/abs/alpha',
          githubRepo: 'owner/alpha',
          milestones: [
            {
              id: 'm1',
              projectId: 'p1',
              name: 'M1',
              sourceId: 'src',
              displayOrder: 0,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        }),
      ]),
    );
    render(<ProjectsSettingsPanel />);
    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());
    expect(screen.getByText('/abs/alpha')).toBeTruthy();
    expect(screen.getByText('owner/alpha')).toBeTruthy();
    expect(screen.getByText('notion')).toBeTruthy();
    expect(screen.getByText('1')).toBeTruthy();
  });

  it('POSTs /api/projects on add and the new project appears in the list', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([])) // initial list
      .mockResolvedValueOnce(
        jsonResponse(makeProject({ id: 'new-1', name: 'Brand New' }), 201),
      ) // POST
      .mockResolvedValueOnce(
        jsonResponse([makeProject({ id: 'new-1', name: 'Brand New' })]),
      ); // reload

    render(<ProjectsSettingsPanel />);
    await waitFor(() =>
      expect(screen.getByText(/No projects configured yet/)).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole('button', { name: '+ Add project' }));
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Brand New' },
    });
    fireEvent.change(screen.getByLabelText('Project Dir'), {
      target: { value: '/abs/new' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(screen.getByText('Brand New')).toBeTruthy());

    const postCall = fetchMock.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect(postCall).toBeDefined();
    expect(postCall?.[0]).toBe('/api/projects');
    const postBody = JSON.parse((postCall?.[1] as RequestInit).body as string);
    expect(postBody.name).toBe('Brand New');
    expect(postBody.projectDir).toBe('/abs/new');
  });

  it('Delete shows a confirmation dialog and calls DELETE /api/projects/:id on confirm', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse([makeProject({ id: 'p1', name: 'Alpha' })]),
      ) // initial list
      .mockResolvedValueOnce(emptyResponse(204)) // DELETE
      .mockResolvedValueOnce(jsonResponse([])); // reload

    render(<ProjectsSettingsPanel />);
    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(
      screen.getByRole('heading', { name: 'Delete project?' }),
    ).toBeTruthy();

    const dialog = screen.getByRole('dialog', {
      name: 'Confirm delete project',
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(screen.getByText(/No projects configured yet/)).toBeTruthy(),
    );

    const deleteCall = fetchMock.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === 'DELETE',
    );
    expect(deleteCall).toBeDefined();
    expect(deleteCall?.[0]).toBe('/api/projects/p1');
  });

  it('clicking a project name drills into its milestones sub-panel', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse([
          makeProject({
            id: 'p1',
            name: 'Alpha',
            milestones: [
              {
                id: 'm1',
                projectId: 'p1',
                name: 'Milestone One',
                sourceId: 'src-1',
                displayOrder: 0,
                createdAt: 1,
                updatedAt: 1,
              },
            ],
          }),
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: 'm1',
            projectId: 'p1',
            name: 'Milestone One',
            sourceId: 'src-1',
            displayOrder: 0,
            createdAt: 1,
            updatedAt: 1,
          },
        ]),
      );

    render(<ProjectsSettingsPanel />);
    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());

    fireEvent.click(
      screen.getByRole('button', { name: 'Open milestones for Alpha' }),
    );

    await waitFor(() => expect(screen.getByText('Milestone One')).toBeTruthy());
    expect(screen.getByText(/Alpha — Milestones/)).toBeTruthy();
  });

  it('shows error message when initial list fetch fails', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500));
    render(<ProjectsSettingsPanel />);
    await waitFor(() => expect(screen.getByText('boom')).toBeTruthy());
  });
});
