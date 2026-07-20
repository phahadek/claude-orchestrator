import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { StagedIntentPanel } from '../StagedIntentPanel';
import type { StagedIntent } from '../../api/stagedIntents';

function makeIntent(overrides: Partial<StagedIntent> = {}): StagedIntent {
  return {
    id: 'intent-1',
    kind: 'task.setStatus',
    payload: { taskId: 'notion:abc', status: 'Ready' },
    projectId: 'proj-1',
    createdAt: 0,
    ...overrides,
  };
}

describe('StagedIntentPanel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the intent's kind, payload, and Apply/Reject controls", () => {
    render(<StagedIntentPanel intent={makeIntent()} />);

    expect(screen.getByText('task.setStatus')).toBeTruthy();
    expect(screen.getByText(/notion:abc/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /apply/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /reject/i })).toBeTruthy();
  });

  it('renders ops_journal (journal.setState) as a decision-surface kind with a task/state headline', () => {
    render(
      <StagedIntentPanel
        intent={makeIntent({
          kind: 'journal.setState',
          payload: {
            taskId: 'notion:abc',
            state: 'staged-proposal',
            fields: { disposition: 'pass' },
          },
        })}
      />,
    );

    expect(
      screen.getByTestId('staged-intent-ops-journal-payload'),
    ).toBeTruthy();
    expect(screen.getByText(/notion:abc/)).toBeTruthy();
    expect(screen.getByText(/staged-proposal/)).toBeTruthy();
    expect(screen.getByText(/Disposition: pass/)).toBeTruthy();
  });

  it('Apply calls the general command-layer route, not a bespoke endpoint', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { ok: true } }),
    } as Response);
    const onApplied = vi.fn();

    render(<StagedIntentPanel intent={makeIntent()} onApplied={onApplied} />);
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/staged-intents/intent-1/apply',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
  });

  it('Reject discards the intent via the staged-intents route', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    } as Response);
    const onRejected = vi.fn();

    render(<StagedIntentPanel intent={makeIntent()} onRejected={onRejected} />);
    fireEvent.click(screen.getByRole('button', { name: /reject/i }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/staged-intents/intent-1/reject',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    await waitFor(() => expect(onRejected).toHaveBeenCalled());
  });

  it('Apply dismisses the panel (not stuck on error) when the server returns not-found', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({ error: 'staged intent not found' }),
    } as Response);
    const onApplied = vi.fn();
    const onDismiss = vi.fn();

    render(
      <StagedIntentPanel
        intent={makeIntent()}
        onApplied={onApplied}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));

    await waitFor(() => expect(onDismiss).toHaveBeenCalledWith(makeIntent()));
    expect(onApplied).not.toHaveBeenCalled();
    expect(screen.queryByText(/staged intent not found/i)).toBeNull();
  });

  it('Reject dismisses the panel (not stuck on error) when the server returns not-found', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({ error: 'staged intent not found' }),
    } as Response);
    const onRejected = vi.fn();
    const onDismiss = vi.fn();

    render(
      <StagedIntentPanel
        intent={makeIntent()}
        onRejected={onRejected}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /reject/i }));

    await waitFor(() => expect(onDismiss).toHaveBeenCalledWith(makeIntent()));
    expect(onRejected).not.toHaveBeenCalled();
    expect(screen.queryByText(/staged intent not found/i)).toBeNull();
  });
});
