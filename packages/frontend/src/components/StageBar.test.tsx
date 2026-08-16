import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { StageBar } from './StageBar';
import type { StageInfo } from '../utils/stageSelection';

function makeStages(overrides?: Partial<Record<StageInfo['id'], Partial<StageInfo>>>): StageInfo[] {
  const base: StageInfo[] = [
    { id: 'planning', label: 'Planning', status: 'done', demand: false },
    { id: 'implementation', label: 'Implementation', status: 'active', demand: false },
    { id: 'tests', label: 'Tests', status: 'not_started', demand: false },
    { id: 'review', label: 'Review', status: 'not_started', demand: false },
    { id: 'pr', label: 'PR', status: 'not_started', demand: false },
  ];
  if (!overrides) return base;
  return base.map((s) => ({ ...s, ...overrides[s.id] }));
}

describe('StageBar', () => {
  it('renders all five fixed stage chips, even before they have content', () => {
    render(
      <StageBar stages={makeStages()} selected="implementation" onSelect={vi.fn()} />,
    );
    expect(screen.getByTestId('stage-chip-planning')).toBeTruthy();
    expect(screen.getByTestId('stage-chip-implementation')).toBeTruthy();
    expect(screen.getByTestId('stage-chip-tests')).toBeTruthy();
    expect(screen.getByTestId('stage-chip-review')).toBeTruthy();
    expect(screen.getByTestId('stage-chip-pr')).toBeTruthy();
  });

  it('marks exactly the selected stage chip as selected', () => {
    render(<StageBar stages={makeStages()} selected="implementation" onSelect={vi.fn()} />);
    expect(
      screen.getByTestId('stage-chip-implementation').getAttribute('aria-selected'),
    ).toBe('true');
    expect(
      screen.getByTestId('stage-chip-planning').getAttribute('aria-selected'),
    ).toBe('false');
  });

  it('calls onSelect with the clicked stage id', () => {
    const onSelect = vi.fn();
    render(<StageBar stages={makeStages()} selected="implementation" onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId('stage-chip-review'));
    expect(onSelect).toHaveBeenCalledWith('review');
  });

  it('renders a demand badge on an unselected stage chip', () => {
    const stages = makeStages({ review: { demand: true } });
    render(<StageBar stages={stages} selected="implementation" onSelect={vi.fn()} />);
    expect(screen.getByTestId('stage-demand-review')).toBeTruthy();
  });

  it('does not render a demand badge for a stage without demand', () => {
    render(<StageBar stages={makeStages()} selected="implementation" onSelect={vi.fn()} />);
    expect(screen.queryByTestId('stage-demand-implementation')).toBeNull();
  });
});
