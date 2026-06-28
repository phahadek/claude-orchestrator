import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { BootLoadingBanner } from '../BootLoadingBanner';
import type { BootReconciliationState } from '../../hooks/useBootReconciliation';

function makeState(
  overrides: Partial<BootReconciliationState> = {},
): BootReconciliationState {
  return {
    phase: 'idle',
    steps: [],
    stepEntries: [],
    currentStep: null,
    startedAt: null,
    totalDurationMs: null,
    ...overrides,
  };
}

describe('BootLoadingBanner', () => {
  it('renders nothing when phase is idle', () => {
    render(<BootLoadingBanner state={makeState()} />);
    expect(screen.queryByTestId('boot-loading-banner')).toBeNull();
  });

  it('renders nothing when phase is completed', () => {
    render(
      <BootLoadingBanner
        state={makeState({ phase: 'completed', totalDurationMs: 1000 })}
      />,
    );
    expect(screen.queryByTestId('boot-loading-banner')).toBeNull();
  });

  it('renders the banner when phase is in_progress', () => {
    const state = makeState({
      phase: 'in_progress',
      steps: ['jsonl_import', 'worktree_reconciliation'],
      currentStep: 'jsonl_import',
      startedAt: new Date().toISOString(),
    });
    render(<BootLoadingBanner state={state} />);
    expect(screen.getByTestId('boot-loading-banner')).toBeDefined();
    expect(screen.getByText(/Backend booting/)).toBeDefined();
  });

  it('shows the current step name when in_progress', () => {
    const state = makeState({
      phase: 'in_progress',
      steps: ['worktree_reconciliation'],
      currentStep: 'worktree_reconciliation',
      startedAt: new Date().toISOString(),
    });
    render(<BootLoadingBanner state={state} />);
    expect(screen.getByTestId('boot-current-step')).toBeDefined();
    expect(screen.getByText(/worktree reconciliation/i)).toBeDefined();
  });

  it('shows X of Y progress derived from steps and currentStep', () => {
    const state = makeState({
      phase: 'in_progress',
      steps: ['jsonl_import', 'resume_orphan_sessions', 'worktree_reconciliation'],
      stepEntries: [
        { name: 'jsonl_import', status: 'completed', duration_ms: 120 },
        { name: 'resume_orphan_sessions', status: 'started' },
      ],
      currentStep: 'resume_orphan_sessions',
      startedAt: new Date().toISOString(),
    });
    render(<BootLoadingBanner state={state} />);
    const progress = screen.getByTestId('boot-progress');
    expect(progress.textContent).toBe('Step 2 of 3');
  });

  it('shows X of Y using first step index (step 1 of N)', () => {
    const state = makeState({
      phase: 'in_progress',
      steps: ['jsonl_import', 'worktree_reconciliation'],
      stepEntries: [{ name: 'jsonl_import', status: 'started' }],
      currentStep: 'jsonl_import',
      startedAt: new Date().toISOString(),
    });
    render(<BootLoadingBanner state={state} />);
    const progress = screen.getByTestId('boot-progress');
    expect(progress.textContent).toBe('Step 1 of 2');
  });

  it('shows completed count as X when currentStep is null (between steps)', () => {
    const state = makeState({
      phase: 'in_progress',
      steps: ['jsonl_import', 'worktree_reconciliation'],
      stepEntries: [
        { name: 'jsonl_import', status: 'completed', duration_ms: 80 },
      ],
      currentStep: null,
      startedAt: new Date().toISOString(),
    });
    render(<BootLoadingBanner state={state} />);
    const progress = screen.getByTestId('boot-progress');
    expect(progress.textContent).toBe('Step 1 of 2');
  });

  it('hides progress when steps list is empty', () => {
    const state = makeState({
      phase: 'in_progress',
      steps: [],
      currentStep: null,
      startedAt: new Date().toISOString(),
    });
    render(<BootLoadingBanner state={state} />);
    expect(screen.queryByTestId('boot-progress')).toBeNull();
  });

  it('clears (renders nothing) once phase transitions to completed', () => {
    const inProgressState = makeState({
      phase: 'in_progress',
      steps: ['jsonl_import'],
      currentStep: 'jsonl_import',
      startedAt: new Date().toISOString(),
    });
    const { rerender } = render(<BootLoadingBanner state={inProgressState} />);
    expect(screen.getByTestId('boot-loading-banner')).toBeDefined();

    const completedState = makeState({
      phase: 'completed',
      steps: ['jsonl_import'],
      stepEntries: [{ name: 'jsonl_import', status: 'completed', duration_ms: 500 }],
      totalDurationMs: 500,
    });
    rerender(<BootLoadingBanner state={completedState} />);
    expect(screen.queryByTestId('boot-loading-banner')).toBeNull();
  });
});
