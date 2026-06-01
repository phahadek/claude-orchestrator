import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Header } from '../Header';
import type { ProjectConfig } from '@claude-orchestrator/backend/src/config';
import type { TaskView } from '../../types/taskView';

function mockMatchMedia(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function makeTask(overrides: Partial<TaskView> = {}): TaskView {
  return {
    taskId: 't1',
    taskName: 'Task 1',
    notionStatus: '✅ Done',
    displayStatus: 'done',
    pauseReason: null,
    priority: 'P2',
    notionUrl: '',
    taskType: 'Code',
    blocked: false,
    blockerNames: [],
    wave: 1,
    codeSession: null,
    pr: null,
    review: null,
    totalTokens: { input: 0, output: 0 },
    ...overrides,
  };
}

describe('Header', () => {
  beforeEach(() => {
    // Default to desktop viewport
    mockMatchMedia(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  describe('desktop layout regression', () => {
    it('shows app name on desktop', () => {
      render(<Header {...defaultProps} />);
      expect(screen.getByText('Claude Code Orchestrator')).toBeDefined();
    });

    it('renders all 5 nav tabs on desktop', () => {
      render(<Header {...defaultProps} />);
      expect(screen.getByRole('button', { name: 'Tasks' })).toBeDefined();
      expect(screen.getByRole('button', { name: 'Sessions' })).toBeDefined();
      expect(screen.getByRole('button', { name: 'PRs' })).toBeDefined();
      expect(screen.getByRole('button', { name: 'Analytics' })).toBeDefined();
      expect(screen.getByRole('button', { name: 'Settings' })).toBeDefined();
    });

    it('does not render mobile rows on desktop', () => {
      render(<Header {...defaultProps} />);
      expect(screen.queryByTestId('mobile-row1')).toBeNull();
      expect(screen.queryByTestId('mobile-row2')).toBeNull();
    });
  });

  describe('mobile layout (<768px)', () => {
    beforeEach(() => {
      mockMatchMedia(true);
    });

    it('hides the app name on mobile', () => {
      render(<Header {...defaultProps} />);
      expect(screen.queryByText('Claude Code Orchestrator')).toBeNull();
    });

    it('renders nav tabs in mobile-row1', () => {
      render(<Header {...defaultProps} />);
      const row1 = screen.getByTestId('mobile-row1');
      expect(row1).toBeDefined();
      // All nav tabs are present inside row1
      expect(row1.querySelector('nav')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Tasks' })).toBeDefined();
      expect(screen.getByRole('button', { name: 'Sessions' })).toBeDefined();
      expect(screen.getByRole('button', { name: 'PRs' })).toBeDefined();
      expect(screen.getByRole('button', { name: 'Analytics' })).toBeDefined();
      expect(screen.getByRole('button', { name: 'Settings' })).toBeDefined();
    });

    it('renders controls in mobile-row2', () => {
      render(<Header {...defaultProps} />);
      const row2 = screen.getByTestId('mobile-row2');
      expect(row2).toBeDefined();
    });

    it('renders compact MilestoneProgress in mobile-row2 when tasks are provided', () => {
      const tasks = [
        makeTask({ notionStatus: '✅ Done' }),
        makeTask({ taskId: 't2', notionStatus: '🔄 In Progress' }),
      ];
      render(<Header {...defaultProps} tasks={tasks} />);
      const row2 = screen.getByTestId('mobile-row2');
      const compactProgress = row2.querySelector(
        '[data-testid="compact-milestone-progress"]',
      );
      expect(compactProgress).toBeTruthy();
    });

    it('renders token summary in mobile-row2 when tokens are provided', () => {
      render(<Header {...defaultProps} totalTokens={50000} totalCost={0.5} />);
      const row2 = screen.getByTestId('mobile-row2');
      expect(row2.textContent).toContain('tokens');
    });

    it('renders milestone select in mobile-row2 when multiple boards exist', () => {
      const project: ProjectConfig = {
        id: 'proj1',
        name: 'Project 1',
        projectDir: '/tmp/proj1',
        contextUrl: '',
        boardId: 'm1',
        boards: [
          { id: 'm1', sourceId: 'src1', name: 'M1' },
          { id: 'm2', sourceId: 'src2', name: 'M2' },
        ],
        taskSource: 'notion',
        gitMode: 'github',
        autoLaunchEnabled: false,
        autoLaunchMilestoneId: null,
        autoMergeEnabled: false,
        dataResidencyConfirmed: false,
        baseBranch: 'dev',
      };
      render(
        <Header
          {...defaultProps}
          projects={[project]}
          activeProjectId="proj1"
          activeBoardId="m1"
        />,
      );
      const row2 = screen.getByTestId('mobile-row2');
      expect(row2.querySelector('select')).toBeTruthy();
    });

    it('renders auto-launch toggle in mobile-row2 for eligible projects', () => {
      const project: ProjectConfig = {
        id: 'proj1',
        name: 'Project 1',
        projectDir: '/tmp/proj1',
        contextUrl: '',
        boardId: 'm1',
        boards: [{ id: 'm1', sourceId: 'src1', name: 'M1' }],
        taskSource: 'notion',
        gitMode: 'github',
        autoLaunchEnabled: false,
        autoLaunchMilestoneId: null,
        autoMergeEnabled: false,
        dataResidencyConfirmed: false,
        baseBranch: 'dev',
      };
      render(
        <Header
          {...defaultProps}
          projects={[project]}
          activeProjectId="proj1"
          activeBoardId="m1"
          onAutoLaunchToggle={vi.fn()}
        />,
      );
      const row2 = screen.getByTestId('mobile-row2');
      expect(row2.querySelector('[aria-label*="Auto-launch"]')).toBeTruthy();
    });
  });

  describe('auto-launch toggle', () => {
    function makeProject(
      overrides: Partial<ProjectConfig> = {},
    ): ProjectConfig {
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
        gitMode: 'github',
        autoLaunchEnabled: false,
        autoLaunchMilestoneId: null,
        autoMergeEnabled: false,
        dataResidencyConfirmed: false,
        baseBranch: 'dev',
        ...overrides,
      } as ProjectConfig;
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

  describe('auto-launch counter', () => {
    function makeProject(
      overrides: Partial<ProjectConfig> = {},
    ): ProjectConfig {
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
        gitMode: 'github',
        autoLaunchEnabled: true,
        autoLaunchMilestoneId: 'm1',
        autoMergeEnabled: false,
        dataResidencyConfirmed: false,
        baseBranch: 'dev',
        ...overrides,
      } as ProjectConfig;
    }

    const onProject = makeProject();

    it('renders 1/1 when one session is running with cap 1', () => {
      render(
        <Header
          {...defaultProps}
          projects={[onProject]}
          activeProjectId="proj1"
          activeBoardId="m1"
          onAutoLaunchToggle={vi.fn()}
          autoLaunchRunningCount={1}
          autoLaunchCap={1}
          autoLaunchQueuedCount={0}
          autoLaunchPollIntervalMs={60000}
        />,
      );
      const counter = screen.getByTestId('auto-launch-counter');
      expect(counter.textContent).toContain('1/1');
    });

    it('renders 2/3 when two sessions are running with cap 3', () => {
      render(
        <Header
          {...defaultProps}
          projects={[onProject]}
          activeProjectId="proj1"
          activeBoardId="m1"
          onAutoLaunchToggle={vi.fn()}
          autoLaunchRunningCount={2}
          autoLaunchCap={3}
          autoLaunchQueuedCount={0}
          autoLaunchPollIntervalMs={60000}
        />,
      );
      const counter = screen.getByTestId('auto-launch-counter');
      expect(counter.textContent).toContain('2/3');
    });

    it('tooltip text includes running count, queued count, and cap', () => {
      render(
        <Header
          {...defaultProps}
          projects={[onProject]}
          activeProjectId="proj1"
          activeBoardId="m1"
          onAutoLaunchToggle={vi.fn()}
          autoLaunchRunningCount={2}
          autoLaunchCap={3}
          autoLaunchQueuedCount={4}
          autoLaunchPollIntervalMs={60000}
        />,
      );
      const counter = screen.getByTestId('auto-launch-counter');
      const title = counter.getAttribute('title') ?? '';
      expect(title).toContain('2 running');
      expect(title).toContain('4 queued');
      expect(title).toContain('cap 3');
    });

    it('queued indicator appears when there are eligible-but-deferred Ready tasks', () => {
      render(
        <Header
          {...defaultProps}
          projects={[onProject]}
          activeProjectId="proj1"
          activeBoardId="m1"
          onAutoLaunchToggle={vi.fn()}
          autoLaunchRunningCount={1}
          autoLaunchCap={1}
          autoLaunchQueuedCount={3}
          autoLaunchPollIntervalMs={60000}
        />,
      );
      const counter = screen.getByTestId('auto-launch-counter');
      expect(counter.textContent).toContain('+3 queued');
    });

    it('counter is hidden when the auto-launch toggle is OFF for the active project', () => {
      const offProject = makeProject({
        autoLaunchEnabled: false,
        autoLaunchMilestoneId: null,
      });
      render(
        <Header
          {...defaultProps}
          projects={[offProject]}
          activeProjectId="proj1"
          activeBoardId="m1"
          onAutoLaunchToggle={vi.fn()}
          autoLaunchRunningCount={1}
          autoLaunchCap={1}
          autoLaunchQueuedCount={0}
          autoLaunchPollIntervalMs={60000}
        />,
      );
      expect(screen.queryByTestId('auto-launch-counter')).toBeNull();
    });

    it('counter is hidden when the project has no boards', () => {
      const noBoardProject = makeProject({ boards: [] });
      render(
        <Header
          {...defaultProps}
          projects={[noBoardProject]}
          activeProjectId="proj1"
          activeBoardId={null}
          onAutoLaunchToggle={vi.fn()}
          autoLaunchRunningCount={1}
          autoLaunchCap={1}
          autoLaunchQueuedCount={0}
          autoLaunchPollIntervalMs={60000}
        />,
      );
      expect(screen.queryByTestId('auto-launch-counter')).toBeNull();
    });

    it('counter is hidden when the task source is YAML', () => {
      const yamlProject = makeProject({ taskSource: 'yaml' });
      render(
        <Header
          {...defaultProps}
          projects={[yamlProject]}
          activeProjectId="proj1"
          activeBoardId="m1"
          onAutoLaunchToggle={vi.fn()}
          autoLaunchRunningCount={1}
          autoLaunchCap={1}
          autoLaunchQueuedCount={0}
          autoLaunchPollIntervalMs={60000}
        />,
      );
      expect(screen.queryByTestId('auto-launch-counter')).toBeNull();
    });
  });
});
