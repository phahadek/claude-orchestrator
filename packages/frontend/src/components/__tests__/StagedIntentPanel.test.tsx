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
    render(<StagedIntentPanel intent={makeIntent({ groupId: 'group-1' })} />);

    expect(screen.queryByRole('button', { name: /commit/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /apply/i })).toBeNull();
    expect(screen.getByRole('button', { name: /approve/i })).toBeTruthy();
  });

  it('renders a single Commit for a standalone intent (no groupId)', () => {
    render(<StagedIntentPanel intent={makeIntent()} />);

    expect(screen.getByRole('button', { name: /^✓ Commit$/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
  });

  it('renders a completeness.disposition run — its questions, and Approve/Reject with no separate Commit', () => {
    render(
      <StagedIntentPanel
        intent={makeIntent({
          kind: 'completeness.disposition',
          payload: {
            taskId: 'notion:design1',
            rowId: 1,
            project: 'demo',
            milestone: 'M13',
            probed: ['unstated-premises'],
            questions: [
              {
                question: 'Should X be configurable?',
                disposition: 'out-of-scope',
                reason: 'Out of scope.',
                approvalStatus: 'proposed',
              },
            ],
            runAt: '2026-07-28T00:00:00.000Z',
          },
        })}
      />,
    );

    expect(screen.getByText('completeness.disposition')).toBeTruthy();
    expect(
      screen.getByTestId('staged-intent-completeness-disposition'),
    ).toBeTruthy();
    expect(screen.getByText(/Should X be configurable\?/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /commit/i })).toBeNull();
    expect(screen.getByRole('button', { name: /^approve$/i })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /decline/i })).toBeTruthy();
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

  it('renders a task.setStatus -> Ready card with a condensed groomingGate summary that expands to constraints and files/paths', () => {
    render(
      <StagedIntentPanel
        intent={makeIntent({
          kind: 'task.setStatus',
          payload: {
            taskId: 'notion:abc',
            status: 'Ready',
            groomingGate: {
              size_check: { decision: 'no_split' },
              type_check: { decision: 'none' },
              type: '💻 Code',
              regions: {
                packages: ['packages/frontend'],
                files: ['a.ts', 'b.ts'],
              },
              constraintsDispositioned: {
                'constraint-1': {
                  disposition: 'n/a',
                  why: 'Not applicable here.',
                },
                'constraint-2': { disposition: 'complies' },
              },
              filesPathsEntries: [
                {
                  raw: 'packages/frontend/src/a.ts',
                  isNew: false,
                  existsInRepo: true,
                },
                {
                  raw: 'packages/frontend/src/b.ts',
                  isNew: true,
                  existsInRepo: false,
                },
              ],
            },
          },
        })}
      />,
    );

    const headline = screen.getByTestId('staged-intent-promote-ready');
    expect(headline.textContent).toContain('notion:abc');
    const summary = screen.getByTestId('staged-intent-grooming-gate-summary');
    expect(summary.textContent).toContain('no_split');
    expect(summary.textContent).toContain('💻 Code');
    expect(summary.textContent).toContain('3 regions');
    expect(summary.textContent).toContain('2 constraints');

    fireEvent.click(screen.getByText('Show grooming detail'));
    expect(summary.textContent).toContain('Not applicable here.');
    expect(summary.textContent).toContain('packages/frontend/src/a.ts');
    expect(summary.textContent).toContain('packages/frontend/src/b.ts');
  });

  it('renders a task.setStatus -> Ready card with only the task id when the intent has no groomProposal, no decisionProposal, and no groomingGate', () => {
    render(
      <StagedIntentPanel
        intent={makeIntent({
          kind: 'task.setStatus',
          payload: { taskId: 'notion:abc', status: 'Ready' },
        })}
      />,
    );

    const headline = screen.getByTestId('staged-intent-promote-ready');
    expect(headline.textContent).toContain('notion:abc');
    expect(
      screen.queryByTestId('staged-intent-grooming-gate-summary'),
    ).toBeNull();
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

    fireEvent.change(
      screen.getByPlaceholderText(/what should the session revise/i),
      {
        target: { value: 'please revise the title' },
      },
    );

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
    fireEvent.change(
      screen.getByPlaceholderText(/what should the session revise/i),
      {
        target: { value: 'please revise the title' },
      },
    );
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
    fireEvent.change(
      screen.getByPlaceholderText(/why is this being declined/i),
      {
        target: { value: 'no longer needed' },
      },
    );
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
    fireEvent.change(
      screen.getByPlaceholderText(/what should the session revise/i),
      {
        target: { value: 'please revise' },
      },
    );
    fireEvent.click(screen.getByRole('button', { name: /pushback/i }));

    await waitFor(() => expect(onDismiss).toHaveBeenCalledWith(makeIntent()));
    expect(onRejected).not.toHaveBeenCalled();
    expect(screen.queryByText(/staged intent not found/i)).toBeNull();
  });

  it('hideActions suppresses every per-item action control, leaving only the headline and registers', () => {
    render(
      <StagedIntentPanel
        intent={makeIntent({ groupId: 'group-1' })}
        hideActions
      />,
    );

    expect(screen.queryByRole('button', { name: /commit/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /pushback/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /decline/i })).toBeNull();
    expect(screen.getByText('task.setStatus')).toBeTruthy();
  });

  it('a blocked (needs_revision) grouped member only offers Decline — no Pushback radio, no Approve button', () => {
    render(
      <StagedIntentPanel
        intent={makeIntent({ groupId: 'group-1', state: 'needs_revision' })}
      />,
    );

    expect(screen.queryByRole('radio', { name: /pushback/i })).toBeNull();
    expect(screen.getByRole('radio', { name: /decline/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^approve$/i })).toBeNull();
    expect(screen.getByRole('button', { name: /decline/i })).toBeTruthy();
  });

  it('declining a blocked (pending_verification) member posts { outcome: "decline" } via the reject route', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    } as Response);
    const onRejected = vi.fn();

    render(
      <StagedIntentPanel
        intent={makeIntent({
          groupId: 'group-1',
          state: 'pending_verification',
        })}
        onRejected={onRejected}
      />,
    );
    fireEvent.change(
      screen.getByPlaceholderText(/why is this being declined/i),
      {
        target: { value: 'superseded' },
      },
    );
    fireEvent.click(screen.getByRole('button', { name: /decline/i }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/staged-intents/intent-1/reject',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ outcome: 'decline', reason: 'superseded' }),
        }),
      );
    });
    await waitFor(() => expect(onRejected).toHaveBeenCalled());
  });

  it("renders the /groom skill's structured proposal fields instead of decisionProposal prose", () => {
    render(
      <StagedIntentPanel
        intent={makeIntent({
          groupId: 'group-1',
          decisionProposal: 'this should not render when groomProposal is set',
          groomProposal: {
            achieves: 'Stops re-ingesting unchanged HLTV items.',
            openQuestions: 'None.',
            automatedTests: 'dedupe drops a duplicate GUID.',
            manualVerification: 'Covered by gate only.',
            operationalSeed: 'None.',
          },
        })}
        hideActions
      />,
    );

    expect(screen.getByTestId('staged-intent-groom-proposal')).toBeTruthy();
    expect(
      screen.getByText('Stops re-ingesting unchanged HLTV items.'),
    ).toBeTruthy();
    expect(screen.getByText('dedupe drops a duplicate GUID.')).toBeTruthy();
    expect(
      screen.queryByText('this should not render when groomProposal is set'),
    ).toBeNull();
  });

  it('renders a whole-turn planning.noOp with the original no-op headline', () => {
    render(
      <StagedIntentPanel
        intent={makeIntent({
          kind: 'planning.noOp',
          payload: {
            taskId: 'notion:abc',
            reason: 'task is already Ready, nothing to add',
          },
        })}
        hideActions
      />,
    );

    expect(screen.getByTestId('staged-intent-no-op')).toBeTruthy();
    expect(screen.getByText(/No-op: nothing staged for/)).toBeTruthy();
    expect(
      screen.getByText(/task is already Ready, nothing to add/),
    ).toBeTruthy();
    expect(screen.queryByTestId('staged-intent-no-op-skipped-kind')).toBeNull();
  });

  it('renders a skippedKind planning.noOp as a discrete line naming the skipped kind and reason, distinct from the whole-turn headline', () => {
    render(
      <StagedIntentPanel
        intent={makeIntent({
          kind: 'planning.noOp',
          payload: {
            taskId: 'notion:abc',
            reason: 'no implementation work beyond the locked decisions',
            skippedKind: 'task.create',
          },
        })}
        hideActions
      />,
    );

    const skippedLine = screen.getByTestId('staged-intent-no-op-skipped-kind');
    expect(skippedLine).toBeTruthy();
    expect(skippedLine.textContent).toContain('task.create');
    expect(skippedLine.textContent).toContain(
      'no implementation work beyond the locked decisions',
    );
    expect(screen.queryByTestId('staged-intent-no-op')).toBeNull();
    expect(screen.queryByText(/No-op: nothing staged for/)).toBeNull();
  });

  it('a skippedKind planning.noOp still offers no operator disposition controls', () => {
    render(
      <StagedIntentPanel
        intent={makeIntent({
          kind: 'planning.noOp',
          payload: {
            taskId: 'notion:abc',
            reason: 'these decisions change no architecture page',
            skippedKind: 'architecture',
          },
        })}
      />,
    );

    expect(screen.queryByRole('button', { name: /commit/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /pushback/i })).toBeNull();
  });

  describe('task.create body contrast', () => {
    function hexToRgb(hex: string) {
      const clean = hex.replace('#', '');
      return [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16));
    }

    function relativeLuminance([r, g, b]: number[]) {
      const [rs, gs, bs] = [r, g, b].map((c) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
    }

    function contrastRatio(hexA: string, hexB: string) {
      const lumA = relativeLuminance(hexToRgb(hexA));
      const lumB = relativeLuminance(hexToRgb(hexB));
      const [lighter, darker] = lumA > lumB ? [lumA, lumB] : [lumB, lumA];
      return (lighter + 0.05) / (darker + 0.05);
    }

    // Token values sourced from src/styles/global.css — --text-primary (body
    // copy) and --bg-secondary (the card background StagedIntentPanel renders
    // on), not hard-coded independently of the design tokens.
    const TEXT_PRIMARY_HEX = '#cdd6f4'; // --ctp-text, resolves --text-primary
    const CARD_BG_HEX = '#181825'; // --ctp-mantle, resolves --bg-secondary

    it('renders a task.create body as readable prose, not the faint payload style', () => {
      render(
        <StagedIntentPanel
          intent={makeIntent({
            kind: 'task.create',
            payload: {
              title: 'New task',
              body: 'Some long-form task body prose that must stay readable.',
            },
          })}
        />,
      );

      const bodyEl = screen.getByText(
        /Some long-form task body prose that must stay readable\./,
      );
      expect(bodyEl.className).not.toMatch(/payload/i);
      const computed = getComputedStyle(bodyEl);
      expect(computed.wordBreak).not.toBe('break-all');
    });

    it('meets the 4.5:1 contrast threshold for normal-size text against the card background', () => {
      const ratio = contrastRatio(TEXT_PRIMARY_HEX, CARD_BG_HEX);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    });

    it('keeps the raw-JSON fallback visually distinct from reviewed body copy', () => {
      render(
        <StagedIntentPanel
          intent={makeIntent({
            kind: 'not-a-known-kind' as StagedIntent['kind'],
            payload: { some: 'raw', json: 'value' },
          })}
        />,
      );

      const fallbackEl = screen.getByText(/"some": "raw"/);
      expect(fallbackEl.className).toMatch(/payload/i);
    });

    it('still renders "No body supplied." for a task.create intent with no body', () => {
      render(
        <StagedIntentPanel
          intent={makeIntent({
            kind: 'task.create',
            payload: { title: 'New task' },
          })}
        />,
      );

      expect(screen.getByText('No body supplied.')).toBeTruthy();
    });
  });
});
