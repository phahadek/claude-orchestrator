import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReconciliationPill } from '../ReconciliationPill';
import type { BootReconciliationState } from '../../../hooks/useBootReconciliation';

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

describe('ReconciliationPill', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders nothing when phase is idle', () => {
    render(<ReconciliationPill state={makeState()} />);
    expect(screen.queryByTestId('reconciliation-pill')).toBeNull();
  });

  it('renders the pill when phase is in_progress', () => {
    const state = makeState({
      phase: 'in_progress',
      steps: ['jsonl_import'],
      currentStep: 'jsonl_import',
      startedAt: new Date().toISOString(),
    });
    render(<ReconciliationPill state={state} />);
    expect(screen.getByTestId('reconciliation-pill')).toBeDefined();
    expect(screen.getByText(/Reconciling/)).toBeDefined();
  });

  it('shows current step name in the pill label', () => {
    const state = makeState({
      phase: 'in_progress',
      steps: ['worktree_reconciliation'],
      currentStep: 'worktree_reconciliation',
      startedAt: new Date().toISOString(),
    });
    render(<ReconciliationPill state={state} />);
    expect(screen.getByText(/worktree reconciliation/i)).toBeDefined();
  });

  it('shows spinner when in_progress', () => {
    const state = makeState({
      phase: 'in_progress',
      steps: ['jsonl_import'],
      currentStep: 'jsonl_import',
      startedAt: new Date().toISOString(),
    });
    render(<ReconciliationPill state={state} />);
    const pill = screen.getByTestId('reconciliation-pill');
    // spinner is aria-hidden span
    const spinner = pill.querySelector('[aria-hidden="true"]');
    expect(spinner).not.toBeNull();
  });

  it('expands to show per-step history on click', () => {
    const state = makeState({
      phase: 'in_progress',
      steps: ['jsonl_import', 'resume_orphan_sessions'],
      currentStep: 'resume_orphan_sessions',
      startedAt: new Date().toISOString(),
      stepEntries: [
        { name: 'jsonl_import', status: 'completed', duration_ms: 120 },
        { name: 'resume_orphan_sessions', status: 'started' },
      ],
    });
    render(<ReconciliationPill state={state} />);

    expect(screen.queryByTestId('reconciliation-dropdown')).toBeNull();

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByTestId('reconciliation-dropdown')).toBeDefined();
    expect(screen.getByText(/jsonl import/i)).toBeDefined();
    expect(screen.getByText(/120ms/)).toBeDefined();
  });

  it('collapses dropdown on second click', () => {
    const state = makeState({
      phase: 'in_progress',
      steps: ['jsonl_import'],
      currentStep: 'jsonl_import',
      startedAt: new Date().toISOString(),
      stepEntries: [{ name: 'jsonl_import', status: 'started' }],
    });
    render(<ReconciliationPill state={state} />);

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByTestId('reconciliation-dropdown')).toBeDefined();

    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByTestId('reconciliation-dropdown')).toBeNull();
  });

  it('shows "Boot complete" label when phase is completed', () => {
    const state = makeState({
      phase: 'completed',
      steps: ['jsonl_import'],
      stepEntries: [{ name: 'jsonl_import', status: 'completed', duration_ms: 50 }],
      currentStep: null,
      startedAt: new Date().toISOString(),
      totalDurationMs: 5000,
    });
    render(<ReconciliationPill state={state} />);
    expect(screen.getByText('Boot complete')).toBeDefined();
  });

  it('shows total duration in expanded view', () => {
    const state = makeState({
      phase: 'completed',
      steps: ['jsonl_import'],
      stepEntries: [{ name: 'jsonl_import', status: 'completed', duration_ms: 5000 }],
      currentStep: null,
      startedAt: new Date().toISOString(),
      totalDurationMs: 5000,
    });
    render(<ReconciliationPill state={state} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/5\.0s/)).toBeDefined();
  });

  it('renders nothing for idle after completed', () => {
    const idleState = makeState({ phase: 'idle' });
    render(<ReconciliationPill state={idleState} />);
    expect(screen.queryByTestId('reconciliation-pill')).toBeNull();
  });
});

describe('useBootReconciliation', () => {
  it('transitions from idle to in_progress on boot_reconciliation_started', async () => {
    const { useBootReconciliation } = await import('../../../hooks/useBootReconciliation');
    const { renderHook, act } = await import('@testing-library/react');

    const { result } = renderHook(() => useBootReconciliation());
    expect(result.current.state.phase).toBe('idle');

    act(() => {
      result.current.dispatch({
        type: 'boot_reconciliation_started',
        steps: ['jsonl_import', 'resume_orphan_sessions'],
        started_at: new Date().toISOString(),
      });
    });

    expect(result.current.state.phase).toBe('in_progress');
    expect(result.current.state.steps).toEqual(['jsonl_import', 'resume_orphan_sessions']);
  });

  it('tracks currentStep from boot_reconciliation_step started events', async () => {
    const { useBootReconciliation } = await import('../../../hooks/useBootReconciliation');
    const { renderHook, act } = await import('@testing-library/react');

    const { result } = renderHook(() => useBootReconciliation());

    act(() => {
      result.current.dispatch({
        type: 'boot_reconciliation_started',
        steps: ['jsonl_import'],
        started_at: new Date().toISOString(),
      });
      result.current.dispatch({
        type: 'boot_reconciliation_step',
        step: 'jsonl_import',
        status: 'started',
      });
    });

    expect(result.current.state.currentStep).toBe('jsonl_import');
  });

  it('transitions to completed and resets after 2s', async () => {
    vi.useFakeTimers();
    const { useBootReconciliation } = await import('../../../hooks/useBootReconciliation');
    const { renderHook, act } = await import('@testing-library/react');

    const { result } = renderHook(() => useBootReconciliation());

    act(() => {
      result.current.dispatch({
        type: 'boot_reconciliation_started',
        steps: ['jsonl_import'],
        started_at: new Date().toISOString(),
      });
    });

    act(() => {
      result.current.dispatch({
        type: 'boot_reconciliation_completed',
        duration_ms: 1000,
        completed_at: new Date().toISOString(),
      });
    });

    expect(result.current.state.phase).toBe('completed');

    act(() => {
      vi.advanceTimersByTime(2001);
    });

    expect(result.current.state.phase).toBe('idle');
    vi.useRealTimers();
  });
});
