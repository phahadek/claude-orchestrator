import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { MilestoneProgress } from '../MilestoneProgress';
import type { TaskView } from '../../types/taskView';

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

const mixedTasks = [
  makeTask({ taskId: 't1', notionStatus: '✅ Done' }),
  makeTask({ taskId: 't2', notionStatus: '✅ Done' }),
  makeTask({
    taskId: 't3',
    notionStatus: '🔄 In Progress',
    displayStatus: 'in_progress',
  }),
  makeTask({
    taskId: 't4',
    notionStatus: '🔲 Backlog',
    displayStatus: 'backlog',
  }),
];

describe('MilestoneProgress', () => {
  it('returns null when all tasks are deferred', () => {
    const { container } = render(
      <MilestoneProgress tasks={[makeTask({ notionStatus: '⏭️ Deferred' })]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  describe('default (non-compact) mode', () => {
    it('renders a bar and done/total label', () => {
      render(<MilestoneProgress tasks={mixedTasks} />);
      const btn = screen.getByRole('button', { name: /Toggle wave view/i });
      expect(btn).toBeDefined();
      expect(btn.textContent).toContain('2/4');
    });

    it('toggles wave view on click', () => {
      render(<MilestoneProgress tasks={mixedTasks} />);
      expect(screen.queryByRole('region')).toBeNull();
      fireEvent.click(
        screen.getByRole('button', { name: /Toggle wave view/i }),
      );
      // WaveView should now be rendered
      expect(
        screen
          .getByRole('button', { name: /Toggle wave view/i })
          .getAttribute('aria-expanded'),
      ).toBe('true');
    });
  });

  describe('compact mode', () => {
    it('renders the compact button with done/total label', () => {
      render(<MilestoneProgress tasks={mixedTasks} compact />);
      const btn = screen.getByTestId('compact-milestone-progress');
      expect(btn).toBeDefined();
      expect(btn.textContent).toContain('2/4');
    });

    it('does not show the popover initially', () => {
      render(<MilestoneProgress tasks={mixedTasks} compact />);
      expect(screen.queryByTestId('milestone-popover')).toBeNull();
    });

    it('opens popover on click', () => {
      render(<MilestoneProgress tasks={mixedTasks} compact />);
      fireEvent.click(screen.getByTestId('compact-milestone-progress'));
      expect(screen.getByTestId('milestone-popover')).toBeDefined();
    });

    it('popover contains status count chips', () => {
      render(<MilestoneProgress tasks={mixedTasks} compact />);
      fireEvent.click(screen.getByTestId('compact-milestone-progress'));
      const popover = screen.getByTestId('milestone-popover');
      // Should contain done count chip (✅ 2)
      expect(popover.textContent).toContain('✅');
      expect(popover.textContent).toContain('2');
    });

    it('closes popover on Escape key', () => {
      render(<MilestoneProgress tasks={mixedTasks} compact />);
      fireEvent.click(screen.getByTestId('compact-milestone-progress'));
      expect(screen.getByTestId('milestone-popover')).toBeDefined();

      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByTestId('milestone-popover')).toBeNull();
    });

    it('closes popover on click outside', () => {
      render(
        <div>
          <MilestoneProgress tasks={mixedTasks} compact />
          <button type="button" data-testid="outside">
            Outside
          </button>
        </div>,
      );
      fireEvent.click(screen.getByTestId('compact-milestone-progress'));
      expect(screen.getByTestId('milestone-popover')).toBeDefined();

      fireEvent.mouseDown(screen.getByTestId('outside'));
      expect(screen.queryByTestId('milestone-popover')).toBeNull();
    });

    it('toggling the button closes an open popover', () => {
      render(<MilestoneProgress tasks={mixedTasks} compact />);
      fireEvent.click(screen.getByTestId('compact-milestone-progress'));
      expect(screen.getByTestId('milestone-popover')).toBeDefined();
      fireEvent.click(screen.getByTestId('compact-milestone-progress'));
      expect(screen.queryByTestId('milestone-popover')).toBeNull();
    });
  });
});
