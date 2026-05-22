import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Header } from '../Header';
import type { ProjectConfig } from '@claude-orchestrator/backend/src/config';

describe('Header', () => {
  const defaultProps = {
    projects: [],
    activeProjectId: null,
    onProjectChange: vi.fn(),
    activeBoardId: null,
    onBoardChange: vi.fn(),
    activeView: 'sessions' as const,
    onViewChange: vi.fn(),
  };

  it('renders Tasks, Sessions, PRs, and Settings nav buttons', () => {
    render(<Header {...defaultProps} />);
    expect(screen.getByRole('button', { name: 'Tasks' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Sessions' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'PRs' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeDefined();
  });

  it('calls onViewChange with "tasks" when Tasks button is clicked', () => {
    const onViewChange = vi.fn();
    render(<Header {...defaultProps} onViewChange={onViewChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));
    expect(onViewChange).toHaveBeenCalledWith('tasks');
  });

  it('calls onViewChange with "prs" when PRs button is clicked', () => {
    const onViewChange = vi.fn();
    render(<Header {...defaultProps} onViewChange={onViewChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'PRs' }));
    expect(onViewChange).toHaveBeenCalledWith('prs');
  });

  it('calls onViewChange with "settings" when Settings button is clicked', () => {
    const onViewChange = vi.fn();
    render(<Header {...defaultProps} onViewChange={onViewChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(onViewChange).toHaveBeenCalledWith('settings');
  });

  describe('auto-launch toggle', () => {
    function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
      return {
        id: 'proj1',
        name: 'Project 1',
        projectDir: '/tmp/proj1',
        contextUrl: '',
        boardId: 'm1',
        boards: [
          { id: 'm1', sourceId: 'src1', name: 'Milestone 1' },
          { id: 'm2', sourceId: 'src2', name: 'Milestone 2' },
        ],
        taskSource: 'notion',
        autoLaunchEnabled: false,
        autoLaunchMilestoneId: null,
        autoMergeEnabled: false,
        ...overrides,
      };
    }

    it('renders ON when enabled and bound to the current milestone', () => {
      const project = makeProject({
        autoLaunchEnabled: true,
        autoLaunchMilestoneId: 'm1',
      });
      render(
        <Header
          {...defaultProps}
          projects={[project]}
          activeProjectId="proj1"
          activeBoardId="m1"
          onAutoLaunchToggle={vi.fn()}
        />,
      );
      const pill = screen.getByRole('button', {
        name: /Auto-launch ON for this milestone/i,
      });
      expect(pill.getAttribute('aria-pressed')).toBe('true');
      expect(pill.textContent).toContain('ON');
    });

    it('renders OFF when the project has auto-launch disabled', () => {
      const project = makeProject({
        autoLaunchEnabled: false,
        autoLaunchMilestoneId: 'm1',
      });
      render(
        <Header
          {...defaultProps}
          projects={[project]}
          activeProjectId="proj1"
          activeBoardId="m1"
          onAutoLaunchToggle={vi.fn()}
        />,
      );
      const pill = screen.getByRole('button', { name: /Auto-launch OFF/i });
      expect(pill.getAttribute('aria-pressed')).toBe('false');
      expect(pill.textContent).toContain('OFF');
    });

    it('renders OFF with a tooltip naming the bound milestone when bound elsewhere', () => {
      const project = makeProject({
        autoLaunchEnabled: true,
        autoLaunchMilestoneId: 'm2',
      });
      render(
        <Header
          {...defaultProps}
          projects={[project]}
          activeProjectId="proj1"
          activeBoardId="m1"
          onAutoLaunchToggle={vi.fn()}
        />,
      );
      const pill = screen.getByRole('button', {
        name: /Auto-launch active on Milestone 2/i,
      });
      expect(pill.getAttribute('aria-pressed')).toBe('false');
      expect(pill.textContent).toContain('OFF');
      expect(pill.getAttribute('title')).toContain('Milestone 2');
    });

    it('OFF → ON click sends autoLaunchEnabled:true and the current board id', () => {
      const onAutoLaunchToggle = vi.fn();
      const project = makeProject({
        autoLaunchEnabled: false,
        autoLaunchMilestoneId: null,
      });
      render(
        <Header
          {...defaultProps}
          projects={[project]}
          activeProjectId="proj1"
          activeBoardId="m1"
          onAutoLaunchToggle={onAutoLaunchToggle}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /Auto-launch OFF/i }));
      expect(onAutoLaunchToggle).toHaveBeenCalledWith({
        autoLaunchEnabled: true,
        autoLaunchMilestoneId: 'm1',
      });
    });

    it('ON → OFF click sends autoLaunchEnabled:false without touching the milestone id', () => {
      const onAutoLaunchToggle = vi.fn();
      const project = makeProject({
        autoLaunchEnabled: true,
        autoLaunchMilestoneId: 'm1',
      });
      render(
        <Header
          {...defaultProps}
          projects={[project]}
          activeProjectId="proj1"
          activeBoardId="m1"
          onAutoLaunchToggle={onAutoLaunchToggle}
        />,
      );
      fireEvent.click(
        screen.getByRole('button', {
          name: /Auto-launch ON for this milestone/i,
        }),
      );
      expect(onAutoLaunchToggle).toHaveBeenCalledWith({
        autoLaunchEnabled: false,
      });
      const payload = onAutoLaunchToggle.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect('autoLaunchMilestoneId' in payload).toBe(false);
    });

    it('clicking when another milestone holds the target reassigns to the current board', () => {
      const onAutoLaunchToggle = vi.fn();
      const project = makeProject({
        autoLaunchEnabled: true,
        autoLaunchMilestoneId: 'm2',
      });
      render(
        <Header
          {...defaultProps}
          projects={[project]}
          activeProjectId="proj1"
          activeBoardId="m1"
          onAutoLaunchToggle={onAutoLaunchToggle}
        />,
      );
      fireEvent.click(
        screen.getByRole('button', {
          name: /Auto-launch active on Milestone 2/i,
        }),
      );
      expect(onAutoLaunchToggle).toHaveBeenCalledWith({
        autoLaunchEnabled: true,
        autoLaunchMilestoneId: 'm1',
      });
    });

    it('hides the toggle for YAML-source projects', () => {
      const project = makeProject({ taskSource: 'yaml' });
      render(
        <Header
          {...defaultProps}
          projects={[project]}
          activeProjectId="proj1"
          activeBoardId="m1"
          onAutoLaunchToggle={vi.fn()}
        />,
      );
      expect(screen.queryByRole('button', { name: /Auto-launch/i })).toBeNull();
    });

    it('hides the toggle when the project has zero boards', () => {
      const project = makeProject({ boards: [] });
      render(
        <Header
          {...defaultProps}
          projects={[project]}
          activeProjectId="proj1"
          activeBoardId={null}
          onAutoLaunchToggle={vi.fn()}
        />,
      );
      expect(screen.queryByRole('button', { name: /Auto-launch/i })).toBeNull();
    });

    it('shows the toggle when the project has a single board', () => {
      const project = makeProject({
        boards: [{ id: 'm1', sourceId: 'src1', name: 'Only Milestone' }],
      });
      render(
        <Header
          {...defaultProps}
          projects={[project]}
          activeProjectId="proj1"
          activeBoardId="m1"
          onAutoLaunchToggle={vi.fn()}
        />,
      );
      expect(
        screen.getByRole('button', { name: /Auto-launch/i }),
      ).toBeDefined();
    });
  });
});
