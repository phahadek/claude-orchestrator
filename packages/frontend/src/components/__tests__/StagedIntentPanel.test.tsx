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

  it("renders the intent's kind, payload, and Commit/Pushback controls", () => {
    render(<StagedIntentPanel intent={makeIntent()} />);

    expect(screen.getByText('task.setStatus')).toBeTruthy();
    expect(screen.getByText(/notion:abc/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /commit/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /pushback/i })).toBeTruthy();
  });

  it('renders no per-item Commit/Apply for a grouped intent, only Approve', () => {
    render(
      <StagedIntentPanel intent={makeIntent({ groupId: 'group-1' })} />,
    );

    expect(screen.queryByRole('button', { name: /commit/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /apply/i })).toBeNull();
    expect(screen.getByRole('button', { name: /approve/i })).toBeTruthy();
  });

  it('renders a single Commit for a standalone intent (no groupId)', () => {
    render(<StagedIntentPanel intent={makeIntent()} />);

    expect(screen.getByRole('button', { name: /^✓ Commit$/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
  });

  it('renders a task.setStatus -> Deferred intent as a distinct discard/defer proposal with its rationale', () => {
    render(
      <StagedIntentPanel
        intent={makeIntent({
          kind: 'task.setStatus',
          payload: { taskId: 'notion:abc', status: 'Deferred' },
          decisionProposal:
            'Superseded by task notion:xyz — defer instead of grooming.',
        })}
      />,
    );

    const headline = screen.getByTestId('staged-intent-discard-defer');
    expect(headline.textContent).toMatch(/discard\/defer/i);
    expect(headline.textContent).toContain('notion:abc');
    expect(
      screen.getByText(
        'Superseded by task notion:xyz — defer instead of grooming.',
      ),
    ).toBeTruthy();
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

  it('renders a staged journal.setState finding/proposal so a parked ops decision is reviewable', () => {
    render(
      <StagedIntentPanel
        intent={makeIntent({
          kind: 'journal.setState',
          payload: {
            taskId: 'notion:abc',
            state: 'staged-proposal',
            fields: {
              findingOrProposal: { summary: 'Stand up off-box backups' },
            },
          },
          decisionProposal: 'Stand up off-box backups',
        })}
      />,
    );

    expect(
      screen.getByTestId('staged-intent-ops-journal-finding'),
    ).toBeTruthy();
    expect(screen.getByText('Stand up off-box backups')).toBeTruthy();
  });

  it('Commit calls the general command-layer route, not a bespoke endpoint', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { ok: true } }),
    } as Response);
    const onApplied = vi.fn();

    render(<StagedIntentPanel intent={makeIntent()} onApplied={onApplied} />);
    fireEvent.click(screen.getByRole('button', { name: /commit/i }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/staged-intents/intent-1/apply',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
  });

  it('the reject submit button is disabled until a reason is entered', () => {
    render(<StagedIntentPanel intent={makeIntent()} />);

    const submit = screen.getByRole('button', { name: /pushback/i });
    expect(submit).toHaveProperty('disabled', true);

    fireEvent.change(screen.getByPlaceholderText(/what should the session revise/i), {
      target: { value: 'please revise the title' },
    });

    expect(submit).toHaveProperty('disabled', false);
  });

  it('Pushback sends { outcome: "pushback", reason } via the reject route', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    } as Response);
    const onRejected = vi.fn();

    render(<StagedIntentPanel intent={makeIntent()} onRejected={onRejected} />);
    fireEvent.change(screen.getByPlaceholderText(/what should the session revise/i), {
      target: { value: 'please revise the title' },
    });
    fireEvent.click(screen.getByRole('button', { name: /pushback/i }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/staged-intents/intent-1/reject',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            outcome: 'pushback',
            reason: 'please revise the title',
          }),
        }),
      );
    });
    await waitFor(() => expect(onRejected).toHaveBeenCalled());
  });

  it('Decline sends { outcome: "decline", reason } via the reject route', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    } as Response);
    const onRejected = vi.fn();

    render(<StagedIntentPanel intent={makeIntent()} onRejected={onRejected} />);
    fireEvent.click(screen.getByRole('radio', { name: /decline/i }));
    fireEvent.change(screen.getByPlaceholderText(/why is this being declined/i), {
      target: { value: 'no longer needed' },
    });
    fireEvent.click(screen.getByRole('button', { name: /decline/i }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/staged-intents/intent-1/reject',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            outcome: 'decline',
            reason: 'no longer needed',
          }),
        }),
      );
    });
    await waitFor(() => expect(onRejected).toHaveBeenCalled());
  });

  it('Commit dismisses the panel (not stuck on error) when the server returns not-found', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: /commit/i }));

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
    fireEvent.change(screen.getByPlaceholderText(/what should the session revise/i), {
      target: { value: 'please revise' },
    });
    fireEvent.click(screen.getByRole('button', { name: /pushback/i }));

    await waitFor(() => expect(onDismiss).toHaveBeenCalledWith(makeIntent()));
    expect(onRejected).not.toHaveBeenCalled();
    expect(screen.queryByText(/staged intent not found/i)).toBeNull();
  });
});
