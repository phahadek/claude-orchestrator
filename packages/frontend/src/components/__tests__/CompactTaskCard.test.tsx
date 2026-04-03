import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { CompactTaskCard } from '../CompactTaskCard';
import type { TaskView } from '../../types/taskView';

function makeTask(overrides: Partial<TaskView> = {}): TaskView {
  return {
    taskId: 'task-1',
    taskName: 'My Task',
    notionStatus: '🗂️ Ready',
    displayStatus: 'ready',
    priority: '🟡 Medium',
    notionUrl: 'https://notion.so/task-1',
    taskType: '💻 Code',
    blocked: false,
    blockerNames: [],
    wave: 1,
    codeSession: null,
    pr: null,
    review: null,
    ...overrides,
  };
}

describe('CompactTaskCard', () => {
  it('renders the task name', () => {
    render(
      <CompactTaskCard
        task={makeTask({ taskName: 'Fix the bug' })}
        showCheckbox={true}
        checked={false}
        onCheckChange={vi.fn()}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText('Fix the bug')).toBeDefined();
  });

  it('renders a checkbox when showCheckbox is true', () => {
    render(
      <CompactTaskCard
        task={makeTask()}
        showCheckbox={true}
        checked={false}
        onCheckChange={vi.fn()}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByRole('checkbox')).toBeDefined();
  });

  it('does not render a checkbox when showCheckbox is false', () => {
    render(
      <CompactTaskCard
        task={makeTask()}
        showCheckbox={false}
        checked={false}
        onCheckChange={vi.fn()}
        onClick={vi.fn()}
      />,
    );
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('reflects checked state on the checkbox', () => {
    render(
      <CompactTaskCard
        task={makeTask()}
        showCheckbox={true}
        checked={true}
        onCheckChange={vi.fn()}
        onClick={vi.fn()}
      />,
    );
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it('calls onCheckChange when checkbox is toggled', () => {
    const onCheckChange = vi.fn();
    render(
      <CompactTaskCard
        task={makeTask({ taskId: 'task-abc' })}
        showCheckbox={true}
        checked={false}
        onCheckChange={onCheckChange}
        onClick={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onCheckChange).toHaveBeenCalledWith('task-abc', true);
  });

  it('calls onClick when the row is clicked', () => {
    const onClick = vi.fn();
    render(
      <CompactTaskCard
        task={makeTask({ taskName: 'Clickable' })}
        showCheckbox={false}
        checked={false}
        onCheckChange={vi.fn()}
        onClick={onClick}
      />,
    );
    fireEvent.click(screen.getByText('Clickable'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('applies blocked CSS class to a blocked task', () => {
    render(
      <CompactTaskCard
        task={makeTask({ blocked: true, blockerNames: ['Other Task'] })}
        showCheckbox={false}
        checked={false}
        onCheckChange={vi.fn()}
        onClick={vi.fn()}
      />,
    );
    const card = screen.getByTestId('compact-task-card');
    expect(card.className).toContain('blocked');
  });

  it('does not apply blocked CSS class to an unblocked task', () => {
    render(
      <CompactTaskCard
        task={makeTask({ blocked: false })}
        showCheckbox={true}
        checked={false}
        onCheckChange={vi.fn()}
        onClick={vi.fn()}
      />,
    );
    const card = screen.getByTestId('compact-task-card');
    expect(card.className).not.toContain('blocked');
  });

  it('shows blocker names for blocked tasks', () => {
    render(
      <CompactTaskCard
        task={makeTask({ blocked: true, blockerNames: ['Task A', 'Task B'] })}
        showCheckbox={false}
        checked={false}
        onCheckChange={vi.fn()}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByTestId('blocker-names').textContent).toContain('Task A');
    expect(screen.getByTestId('blocker-names').textContent).toContain('Task B');
  });

  it('does not show blocker section for unblocked tasks', () => {
    render(
      <CompactTaskCard
        task={makeTask({ blocked: false, blockerNames: [] })}
        showCheckbox={true}
        checked={false}
        onCheckChange={vi.fn()}
        onClick={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('blocker-names')).toBeNull();
  });

  it('has data-status attribute matching the task displayStatus', () => {
    render(
      <CompactTaskCard
        task={makeTask({ displayStatus: 'ready' })}
        showCheckbox={false}
        checked={false}
        onCheckChange={vi.fn()}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByTestId('compact-task-card').getAttribute('data-status')).toBe('ready');
  });
});
