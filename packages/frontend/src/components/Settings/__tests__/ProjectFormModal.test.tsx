import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ProjectFormModal } from '../ProjectFormModal';
import type { Project } from '../../../api/projects';

vi.mock('../../../api/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/projects')>();
  return {
    ...actual,
    projectsApi: {
      ...actual.projectsApi,
      listGithubMilestones: vi.fn().mockResolvedValue([]),
    },
  };
});

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Project One',
    projectDir: '/abs/p1',
    contextUrl: 'https://notion.so/ctx',
    githubRepo: 'owner/repo',
    taskSource: 'notion',
    gitMode: 'github',
    autoLaunchEnabled: false,
    autoLaunchMilestoneId: null,
    autoMergeEnabled: false,
    nonMilestoneSourceConfig: null,
    taskSourceConfig: null,
    dataResidencyConfirmed: false,
    baseBranch: 'dev',
    createdAt: 1,
    updatedAt: 1,
    milestones: [],
    ...overrides,
  } as Project;
}

describe('ProjectFormModal', () => {
  it('renders create form with empty fields by default', () => {
    render(<ProjectFormModal onCancel={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Add project' })).toBeTruthy();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('');
    expect(
      (screen.getByLabelText('Project Dir') as HTMLInputElement).value,
    ).toBe('');
  });

  it('renders edit form pre-populated from initialProject', () => {
    render(
      <ProjectFormModal
        initialProject={makeProject()}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Edit project' })).toBeTruthy();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(
      'Project One',
    );
    expect(
      (screen.getByLabelText('Project Dir') as HTMLInputElement).value,
    ).toBe('/abs/p1');
  });

  it('shows client-side validation errors for missing required fields and does not call onSubmit', () => {
    const onSubmit = vi.fn();
    render(<ProjectFormModal onCancel={vi.fn()} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(screen.getByText('Name is required')).toBeTruthy();
    expect(screen.getByText('Project Dir is required')).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('calls onSubmit with trimmed values when valid', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ProjectFormModal onCancel={vi.fn()} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'My Project' },
    });
    fireEvent.change(screen.getByLabelText('Project Dir'), {
      target: { value: '/abs/path' },
    });
    fireEvent.change(screen.getByLabelText('Task Source'), {
      target: { value: 'yaml' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    const arg = onSubmit.mock.calls[0][0];
    expect(arg.name).toBe('My Project');
    expect(arg.projectDir).toBe('/abs/path');
    expect(arg.taskSource).toBe('yaml');
  });

  it('surfaces server error message when onSubmit rejects', async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValue(new Error('projectDir does not exist on disk'));
    render(<ProjectFormModal onCancel={vi.fn()} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText('Project Dir'), {
      target: { value: '/missing' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(
        screen.getByText('projectDir does not exist on disk'),
      ).toBeTruthy(),
    );
  });

  it('calls onCancel when Cancel button clicked', () => {
    const onCancel = vi.fn();
    render(<ProjectFormModal onCancel={onCancel} onSubmit={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('renders non-milestone source field and pre-populates from initialProject', () => {
    render(
      <ProjectFormModal
        initialProject={makeProject({
          nonMilestoneSourceConfig: { notionDatabaseId: 'db-abc' },
        })}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    const input = screen.getByLabelText(
      'Non-milestone task source (optional)',
    ) as HTMLInputElement;
    expect(input.value).toBe('{"notionDatabaseId":"db-abc"}');
  });

  it('submits nonMilestoneSourceConfigRaw when field is filled', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<ProjectFormModal onCancel={vi.fn()} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'P' } });
    fireEvent.change(screen.getByLabelText('Project Dir'), {
      target: { value: '/dir' },
    });
    fireEvent.change(
      screen.getByLabelText('Non-milestone task source (optional)'),
      { target: { value: '{"milestoneId":"backlog"}' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    const arg = onSubmit.mock.calls[0][0];
    expect(arg.nonMilestoneSourceConfigRaw).toBe('{"milestoneId":"backlog"}');
  });

  it('shows validation error for invalid JSON in non-milestone source field', () => {
    render(<ProjectFormModal onCancel={vi.fn()} onSubmit={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'P' } });
    fireEvent.change(screen.getByLabelText('Project Dir'), {
      target: { value: '/dir' },
    });
    fireEvent.change(
      screen.getByLabelText('Non-milestone task source (optional)'),
      { target: { value: 'not-json' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(screen.getByText('Invalid JSON')).toBeTruthy();
  });

  it('shows validation error when non-milestone source has wrong shape', () => {
    render(<ProjectFormModal onCancel={vi.fn()} onSubmit={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'P' } });
    fireEvent.change(screen.getByLabelText('Project Dir'), {
      target: { value: '/dir' },
    });
    fireEvent.change(
      screen.getByLabelText('Non-milestone task source (optional)'),
      { target: { value: '{"notionDatabaseId":123}' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(screen.getByText(/shape/)).toBeTruthy();
  });

  it('applies modal container class to the inner dialog box for responsive padding', () => {
    const { container } = render(
      <ProjectFormModal onCancel={vi.fn()} onSubmit={vi.fn()} />,
    );
    const overlay = screen.getByRole('dialog');
    const modalBox = overlay.firstElementChild as HTMLElement;
    expect(modalBox).toBeTruthy();
    expect(modalBox.className).toContain('modal');
    expect(container.querySelector('h3')).toBeTruthy();
  });

  describe('GitHub task source', () => {
    it('shows Repository and Default Milestone fields when GitHub is selected', async () => {
      render(<ProjectFormModal onCancel={vi.fn()} onSubmit={vi.fn()} />);
      fireEvent.change(screen.getByLabelText('Task Source'), {
        target: { value: 'github' },
      });
      expect(screen.getByLabelText('Repository')).toBeTruthy();
      // On new project form, milestone field is replaced by helper text
      expect(screen.getByText(/Save the project first/)).toBeTruthy();
    });

    it('shows milestone dropdown when editing an existing GitHub project', () => {
      render(
        <ProjectFormModal
          initialProject={makeProject({
            taskSource: 'github',
            taskSourceConfig: JSON.stringify({ owner: 'acme', repo: 'myapp' }),
          })}
          onCancel={vi.fn()}
          onSubmit={vi.fn()}
        />,
      );
      expect(screen.getByLabelText('Default Milestone')).toBeTruthy();
      expect(screen.getByText(/Leave empty/)).toBeTruthy();
    });

    it('pre-populates owner/repo from taskSourceConfig', () => {
      render(
        <ProjectFormModal
          initialProject={makeProject({
            taskSource: 'github',
            taskSourceConfig: JSON.stringify({ owner: 'acme', repo: 'myapp' }),
          })}
          onCancel={vi.fn()}
          onSubmit={vi.fn()}
        />,
      );
      const input = screen.getByLabelText('Repository') as HTMLInputElement;
      expect(input.value).toBe('acme/myapp');
    });

    it('blocks submit when Repository is empty for GitHub source', async () => {
      const onSubmit = vi.fn();
      render(<ProjectFormModal onCancel={vi.fn()} onSubmit={onSubmit} />);
      fireEvent.change(screen.getByLabelText('Name'), {
        target: { value: 'My Project' },
      });
      fireEvent.change(screen.getByLabelText('Project Dir'), {
        target: { value: '/some/dir' },
      });
      fireEvent.change(screen.getByLabelText('Task Source'), {
        target: { value: 'github' },
      });
      // Leave Repository empty
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
      expect(screen.getByText(/Repository is required/)).toBeTruthy();
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('blocks submit when Repository has invalid format', async () => {
      const onSubmit = vi.fn();
      render(<ProjectFormModal onCancel={vi.fn()} onSubmit={onSubmit} />);
      fireEvent.change(screen.getByLabelText('Name'), {
        target: { value: 'My Project' },
      });
      fireEvent.change(screen.getByLabelText('Project Dir'), {
        target: { value: '/some/dir' },
      });
      fireEvent.change(screen.getByLabelText('Task Source'), {
        target: { value: 'github' },
      });
      fireEvent.change(screen.getByLabelText('Repository'), {
        target: { value: 'no-slash-here' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
      expect(screen.getByText(/owner\/repo format/)).toBeTruthy();
      expect(onSubmit).not.toHaveBeenCalled();
    });
  });
});
