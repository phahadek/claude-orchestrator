import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ProjectFormModal } from '../ProjectFormModal';
import type { Project } from '../../../api/projects';

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
    createdAt: 1,
    updatedAt: 1,
    milestones: [],
    ...overrides,
  };
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
});
