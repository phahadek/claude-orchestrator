import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { DecisionPickOnePanel } from '../DecisionPickOnePanel';
import { stagedIntentsApi } from '../../api/stagedIntents';
import type { StagedIntent } from '../../api/stagedIntents';

describe('DecisionPickOnePanel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function singleOptionIntent(): StagedIntent {
    return {
      id: 'intent-1',
      kind: 'decision.pickOne',
      payload: {
        prompt: 'Should we cap the reader at 10MB?',
        options: [
          {
            label: 'Cap at 10MB',
            description: 'Error above the cap instead of streaming.',
          },
        ],
        allowFreeForm: true,
      },
      projectId: 'proj-1',
      createdAt: 0,
      sessionId: 'design-session-1',
      state: 'staged',
      decisionProposal: 'A confident recommendation — the simplest safe bound.',
    };
  }

  it('renders a 1-option pickOne (recommendation + accept + free-form pushback) without error', () => {
    render(<DecisionPickOnePanel intent={singleOptionIntent()} />);

    expect(screen.getByTestId('decision-pick-one-panel')).toBeTruthy();
    expect(screen.getByText('Should we cap the reader at 10MB?')).toBeTruthy();
    expect(
      screen.getByText('A confident recommendation — the simplest safe bound.'),
    ).toBeTruthy();
    expect(screen.getByText('Cap at 10MB')).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(1);
    expect(
      screen.getByPlaceholderText('Write in your own answer…'),
    ).toBeTruthy();
  });

  it('accepts the single recommendation, optionally carrying free-form pushback text', async () => {
    const answer = vi
      .spyOn(stagedIntentsApi, 'answer')
      .mockResolvedValue({ ok: true, intent: singleOptionIntent() });
    const onAnswered = vi.fn();

    render(
      <DecisionPickOnePanel
        intent={singleOptionIntent()}
        onAnswered={onAnswered}
      />,
    );

    fireEvent.click(screen.getByRole('radio'));
    fireEvent.change(
      screen.getByPlaceholderText('Write in your own answer…'),
      { target: { value: 'Agreed, but log when the cap is hit.' } },
    );
    fireEvent.click(screen.getByText('✓ Submit'));

    await waitFor(() => {
      expect(answer).toHaveBeenCalledWith('intent-1', {
        chosenLabel: 'Cap at 10MB',
        freeForm: 'Agreed, but log when the cap is hit.',
      });
    });
    await waitFor(() => expect(onAnswered).toHaveBeenCalled());
  });

  it('disables Submit until a radio is picked or free-form text is entered', () => {
    render(<DecisionPickOnePanel intent={singleOptionIntent()} />);

    const submit = screen.getByText('✓ Submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(
      screen.getByPlaceholderText('Write in your own answer…'),
      { target: { value: 'None of these — do something else.' } },
    );
    expect(submit.disabled).toBe(false);
  });

  it('submits a free-form-only answer with no option selected', async () => {
    const answer = vi
      .spyOn(stagedIntentsApi, 'answer')
      .mockResolvedValue({ ok: true, intent: singleOptionIntent() });
    const onAnswered = vi.fn();

    render(
      <DecisionPickOnePanel
        intent={singleOptionIntent()}
        onAnswered={onAnswered}
      />,
    );

    fireEvent.change(
      screen.getByPlaceholderText('Write in your own answer…'),
      { target: { value: 'None of these — do something else.' } },
    );
    fireEvent.click(screen.getByText('✓ Submit'));

    await waitFor(() => {
      expect(answer).toHaveBeenCalledWith('intent-1', {
        chosenLabel: null,
        freeForm: 'None of these — do something else.',
      });
    });
    await waitFor(() => expect(onAnswered).toHaveBeenCalled());
  });

  it('clicking a selected radio again deselects it', () => {
    render(<DecisionPickOnePanel intent={singleOptionIntent()} />);

    const radio = screen.getByRole('radio') as HTMLInputElement;
    fireEvent.click(radio);
    expect(radio.checked).toBe(true);

    fireEvent.click(radio);
    expect(radio.checked).toBe(false);
  });
});
