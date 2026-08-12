import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { StagedIntentPanel } from '../StagedIntentPanel';
import { stagedIntentsApi } from '../../api/stagedIntents';
import type { StagedIntent } from '../../api/stagedIntents';
import { gateApi } from '../../api/gate';

function fireKey(key: string, target?: EventTarget) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true });
  if (target) {
    Object.defineProperty(event, 'target', { value: target, writable: false });
  }
  window.dispatchEvent(event);
}

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

  it('renders an "auto-approved" badge for a gate.accrete intent tagged annotation.autoApproved', () => {
    render(
      <StagedIntentPanel
        intent={makeIntent({
          kind: 'gate.accrete',
          state: 'approved',
          annotation: { autoApproved: true },
        })}
      />,
    );

    expect(screen.getByTestId('staged-intent-auto-approved')).toBeTruthy();
  });

  it('does not render the "auto-approved" badge for an ordinary staged intent', () => {
    render(<StagedIntentPanel intent={makeIntent()} />);

    expect(screen.queryByTestId('staged-intent-auto-approved')).toBeNull();
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

  it("renders the recorded LoC and changed-file count on the grooming summary's first line when size_check carries them", () => {
    render(
      <StagedIntentPanel
        intent={makeIntent({
          kind: 'task.setStatus',
          payload: {
            taskId: 'notion:abc',
            status: 'Ready',
            groomingGate: {
              size_check: {
                decision: 'no_split',
                files: 3,
                loc: 120,
                loc_method: 'estimated',
              },
              type_check: { decision: 'none' },
              type: '💻 Code',
            },
          },
        })}
      />,
    );

    const summary = screen.getByTestId('staged-intent-grooming-gate-summary');
    expect(summary.textContent).toContain('no_split');
    expect(summary.textContent).toContain('120 LoC');
    expect(summary.textContent).toContain('estimated');
    expect(summary.textContent).toContain('3 files');
  });

  it('renders a size_check missing the numbers exactly as today — no crash, no invented values', () => {
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
            },
          },
        })}
      />,
    );

    const summary = screen.getByTestId('staged-intent-grooming-gate-summary');
    expect(summary.textContent).toContain('Size: no_split');
    expect(summary.textContent).not.toContain('LoC');
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

  it('renders investigation via CollapsibleField, collapsed by default, alongside decisionProposal', () => {
    const longInvestigation = Array.from(
      { length: 20 },
      (_, i) => `evidence line ${i}: reader.ts:${i}`,
    ).join('\n');
    render(
      <StagedIntentPanel
        intent={makeIntent({
          decisionProposal: 'Stand up off-box backups',
          investigation: longInvestigation,
        })}
      />,
    );

    expect(screen.getByText('Stand up off-box backups')).toBeTruthy();
    const investigation = screen.getByTestId('staged-intent-investigation');
    expect(investigation.textContent).toContain('evidence line 0');
    expect(screen.getByText(/Show all \d+ lines/)).toBeTruthy();
  });

  it('omits the investigation block when the intent carries none — no regression for existing rows', () => {
    render(
      <StagedIntentPanel
        intent={makeIntent({ decisionProposal: 'Stand up off-box backups' })}
      />,
    );

    expect(screen.queryByTestId('staged-intent-investigation')).toBeNull();
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

  describe('gate.verify', () => {
    it('renders disposition, basis, summary as discrete elements and each trace entry on its own line, not escaped JSON', () => {
      render(
        <StagedIntentPanel
          intent={makeIntent({
            kind: 'gate.verify',
            payload: {
              gateItemId: 'ecc8eab1-4e55-4eac-be6b-97237a6aacbb',
              disposition: 'pass',
              evidence: JSON.stringify({
                basis: 'operational',
                summary: 'Task 3a822f91 is no longer stranded.',
                trace: [
                  'audit_log id 164147 ts=1785536074470: human sets task status',
                  'audit_log id 164150 ts=1785536090000: gate item resolved',
                ],
              }),
            },
          })}
        />,
      );

      const card = screen.getByTestId('staged-intent-gate-verify');
      expect(card.textContent).toContain(
        'ecc8eab1-4e55-4eac-be6b-97237a6aacbb',
      );
      expect(card.textContent).toContain('pass');
      expect(screen.getByText(/Basis: operational/)).toBeTruthy();
      expect(
        screen.getByText('Task 3a822f91 is no longer stranded.'),
      ).toBeTruthy();
      expect(card.textContent).not.toMatch(/\\"/);

      expect(
        screen.getByText(
          'audit_log id 164147 ts=1785536074470: human sets task status',
        ),
      ).toBeTruthy();
      expect(
        screen.getByText(
          'audit_log id 164150 ts=1785536090000: gate item resolved',
        ),
      ).toBeTruthy();
    });

    it('renders expected/found/query as the leading lines for a new-shape report', () => {
      render(
        <StagedIntentPanel
          intent={makeIntent({
            kind: 'gate.verify',
            payload: {
              gateItemId: 'gate-6',
              disposition: 'pass',
              evidence: {
                expected: 'The endpoint records an audit_log row on success.',
                found: 'audit_log shows one matching row from the last run.',
                query: 'auditLog.query projectId=proj-1 action=widget_created',
              },
            },
          })}
        />,
      );

      expect(
        screen.getByText(
          /Expected: The endpoint records an audit_log row on success\./,
        ),
      ).toBeTruthy();
      expect(
        screen.getByText(
          /Found: audit_log shows one matching row from the last run\./,
        ),
      ).toBeTruthy();
      expect(
        screen.getByText(
          /Query: auditLog\.query projectId=proj-1 action=widget_created/,
        ),
      ).toBeTruthy();
    });

    it('shows unrecognised extra evidence fields rather than dropping them', () => {
      render(
        <StagedIntentPanel
          intent={makeIntent({
            kind: 'gate.verify',
            payload: {
              gateItemId: 'gate-1',
              disposition: 'needs-setup',
              evidence: JSON.stringify({
                basis: 'source',
                summary: 'Needs config',
                note: 'Blocked on secret rotation.',
                queriesRun: ['SELECT 1'],
              }),
            },
          })}
        />,
      );

      expect(
        screen.getByText(/Note: Blocked on secret rotation\./),
      ).toBeTruthy();
      // queriesRun is a structural (array) value, so it still collapses.
      fireEvent.click(screen.getByText('Other evidence'));
      expect(screen.getByText(/queriesRun/)).toBeTruthy();
      expect(screen.getByText(/SELECT 1/)).toBeTruthy();
    });

    it('renders an off-contract string evidence key as visible text without expanding anything', () => {
      render(
        <StagedIntentPanel
          intent={makeIntent({
            kind: 'gate.verify',
            payload: {
              gateItemId: '03a0a16f-2636-4f9b-9de7-608a3fd1ba06',
              disposition: 'pass',
              evidence: JSON.stringify({
                basis: 'operational',
                sourceOrient: 'Read gateItemVerifier.ts to find the check.',
                operationalCheck: 'audit_log confirms the write landed.',
              }),
            },
          })}
        />,
      );

      expect(screen.getByText(/Basis: operational/)).toBeTruthy();
      expect(
        screen.getByText(/Read gateItemVerifier\.ts to find the check\./),
      ).toBeTruthy();
      expect(
        screen.getByText(/audit_log confirms the write landed\./),
      ).toBeTruthy();
      expect(screen.queryByText('Other evidence')).toBeNull();
    });

    it('falls back to the raw display without throwing when evidence is not valid JSON', () => {
      render(
        <StagedIntentPanel
          intent={makeIntent({
            kind: 'gate.verify',
            payload: {
              gateItemId: 'gate-2',
              disposition: 'fail',
              evidence: '{not valid json',
            },
          })}
        />,
      );

      expect(screen.getByTestId('staged-intent-gate-verify')).toBeTruthy();
      expect(screen.getByText('{not valid json')).toBeTruthy();
    });

    it('renders without error when evidence is a plain string', () => {
      render(
        <StagedIntentPanel
          intent={makeIntent({
            kind: 'gate.verify',
            payload: {
              gateItemId: 'gate-3',
              disposition: 'pass',
              evidence: 'looks fine to me',
            },
          })}
        />,
      );

      expect(screen.getByText('looks fine to me')).toBeTruthy();
    });

    it('renders without error when evidence lacks a trace field', () => {
      render(
        <StagedIntentPanel
          intent={makeIntent({
            kind: 'gate.verify',
            payload: {
              gateItemId: 'gate-4',
              disposition: 'pass',
              evidence: { basis: 'operational', summary: 'All good.' },
            },
          })}
        />,
      );

      expect(screen.getByText('All good.')).toBeTruthy();
    });

    it('renders without error when evidence is entirely absent', () => {
      render(
        <StagedIntentPanel
          intent={makeIntent({
            kind: 'gate.verify',
            payload: { gateItemId: 'gate-5', disposition: 'pass' },
          })}
        />,
      );

      expect(screen.getByTestId('staged-intent-gate-verify')).toBeTruthy();
    });
  });

  describe('gate.verify Human-Observation mirror (operator disposition)', () => {
    function makeMirrorIntent(overrides: Partial<StagedIntent> = {}) {
      return makeIntent({
        kind: 'gate.verify',
        payload: { gateItemId: 'gate-mirror-1', origin: 'mirror' },
        ...overrides,
      });
    }

    it('renders Pass, Fail, Defer, and Park actions', () => {
      render(<StagedIntentPanel intent={makeMirrorIntent()} />);

      expect(
        screen.getByTestId('staged-intent-gate-verify-mirror-pass'),
      ).toBeTruthy();
      expect(
        screen.getByTestId('staged-intent-gate-verify-mirror-fail'),
      ).toBeTruthy();
      expect(
        screen.getByTestId('staged-intent-gate-verify-mirror-defer'),
      ).toBeTruthy();
      expect(
        screen.getByTestId('staged-intent-gate-verify-mirror-park'),
      ).toBeTruthy();
    });

    it("labels Defer as resolving, so it isn't mistaken for a postponement", () => {
      render(<StagedIntentPanel intent={makeMirrorIntent()} />);

      const defer = screen.getByTestId('staged-intent-gate-verify-mirror-defer');
      expect(defer.textContent).toMatch(/resolves/i);
    });

    it('Park is disabled until evidence is entered, then applies with the not-yet-triggerable disposition', async () => {
      const apply = vi
        .spyOn(stagedIntentsApi, 'apply')
        .mockResolvedValue({ ok: true, result: {} });

      render(<StagedIntentPanel intent={makeMirrorIntent()} />);

      const park = screen.getByTestId(
        'staged-intent-gate-verify-mirror-park',
      ) as HTMLButtonElement;
      expect(park.disabled).toBe(true);

      fireEvent.change(
        screen.getByTestId('staged-intent-gate-verify-mirror-park-evidence'),
        { target: { value: 'not triggerable yet — waiting on the real-world event' } },
      );
      expect(park.disabled).toBe(false);

      fireEvent.click(park);

      await waitFor(() =>
        expect(apply).toHaveBeenCalledWith('intent-1', {
          override: false,
          reason: undefined,
          mirrorDisposition: 'not-yet-triggerable',
          mirrorEvidence: 'not triggerable yet — waiting on the real-world event',
        }),
      );
    });

    it('pressing Defer still resolves the item via the deferred mirrorDisposition, unchanged from before Park existed', async () => {
      const apply = vi
        .spyOn(stagedIntentsApi, 'apply')
        .mockResolvedValue({ ok: true, result: {} });

      render(<StagedIntentPanel intent={makeMirrorIntent()} />);
      fireEvent.click(
        screen.getByTestId('staged-intent-gate-verify-mirror-defer'),
      );

      await waitFor(() =>
        expect(apply).toHaveBeenCalledWith('intent-1', {
          override: false,
          reason: undefined,
          mirrorDisposition: 'deferred',
          mirrorEvidence: undefined,
        }),
      );
    });
  });

  describe('gate.verify consent mirror (Prod-Mutating pending-approval)', () => {
    function makeConsentIntent(overrides: Partial<StagedIntent> = {}) {
      return makeIntent({
        kind: 'gate.verify',
        payload: {
          gateItemId: 'gate-consent-1',
          origin: 'consent',
          evidence: {
            basis: 'read-only dry run',
            note: 'no rows would change',
          },
        },
        ...overrides,
      });
    }

    it('renders the pending-approval headline and the evidence behind the held pass', () => {
      render(<StagedIntentPanel intent={makeConsentIntent()} />);

      expect(screen.getByText(/Prod-Mutating — pending approval/)).toBeTruthy();
      expect(screen.getByText(/Basis: read-only dry run/)).toBeTruthy();
      expect(screen.getByText(/no rows would change/)).toBeTruthy();
    });

    it("renders no Pass/Fail/Defer/Park mirror controls — the consent card's Approve/Reject vocabulary is unchanged by the mirror card's Park addition", () => {
      render(<StagedIntentPanel intent={makeConsentIntent()} />);

      expect(
        screen.queryByTestId('staged-intent-gate-verify-mirror-pass'),
      ).toBeNull();
      expect(
        screen.queryByTestId('staged-intent-gate-verify-mirror-fail'),
      ).toBeNull();
      expect(
        screen.queryByTestId('staged-intent-gate-verify-mirror-defer'),
      ).toBeNull();
      expect(
        screen.queryByTestId('staged-intent-gate-verify-mirror-park'),
      ).toBeNull();
    });

    it('renders Approve and Reject controls instead of Commit/Pushback', () => {
      render(<StagedIntentPanel intent={makeConsentIntent()} />);

      expect(
        screen.getByTestId('staged-intent-gate-consent-approve'),
      ).toBeTruthy();
      expect(
        screen.getByTestId('staged-intent-gate-consent-reject'),
      ).toBeTruthy();
      expect(screen.queryByRole('button', { name: /^✓ Commit$/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /pushback/i })).toBeNull();
    });

    it('approving calls gateApi.approveItem for the gate item and removes the card via onApplied', async () => {
      const approve = vi
        .spyOn(gateApi, 'approveItem')
        .mockResolvedValue({ id: 'gate-consent-1', state: 'pass' } as never);
      const onApplied = vi.fn();
      const intent = makeConsentIntent();

      render(<StagedIntentPanel intent={intent} onApplied={onApplied} />);
      fireEvent.click(screen.getByTestId('staged-intent-gate-consent-approve'));

      await waitFor(() =>
        expect(approve).toHaveBeenCalledWith('gate-consent-1'),
      );
      await waitFor(() =>
        expect(onApplied).toHaveBeenCalledWith(
          intent,
          expect.objectContaining({ state: 'pass' }),
        ),
      );
    });

    it('the Reject button stays disabled until a reason is entered, then calls gateApi.rejectItem with it', async () => {
      const reject = vi
        .spyOn(gateApi, 'rejectItem')
        .mockResolvedValue({ id: 'gate-consent-1', state: 'fail' } as never);
      const onApplied = vi.fn();
      const intent = makeConsentIntent();

      render(<StagedIntentPanel intent={intent} onApplied={onApplied} />);
      const rejectButton = screen.getByTestId(
        'staged-intent-gate-consent-reject',
      ) as HTMLButtonElement;
      expect(rejectButton.disabled).toBe(true);

      fireEvent.change(
        screen.getByTestId('staged-intent-gate-consent-reject-reason'),
        { target: { value: 'not comfortable mutating prod yet' } },
      );
      expect(rejectButton.disabled).toBe(false);

      fireEvent.click(rejectButton);

      await waitFor(() =>
        expect(reject).toHaveBeenCalledWith('gate-consent-1', {
          reason: 'not comfortable mutating prod yet',
        }),
      );
      await waitFor(() =>
        expect(onApplied).toHaveBeenCalledWith(
          intent,
          expect.objectContaining({ state: 'fail' }),
        ),
      );
    });
  });

  describe('session.requestCapability file-mutation advisory', () => {
    it('renders the file-write advisory when confersFileMutation is true', () => {
      render(
        <StagedIntentPanel
          intent={makeIntent({
            kind: 'session.requestCapability',
            payload: {
              capability: 'Bash(sed:*)',
              plan: 'edit the workflow file in place',
              evidence: 'operator directed this session to edit the file',
            },
            confersFileMutation: true,
          })}
        />,
      );

      expect(
        screen.getByTestId('staged-intent-capability-file-mutation-warning'),
      ).toBeTruthy();
    });

    it('does not render the advisory when confersFileMutation is false/undefined', () => {
      render(
        <StagedIntentPanel
          intent={makeIntent({
            kind: 'session.requestCapability',
            payload: {
              capability: 'Bash(psql:*)',
              plan: 'inspect prod row counts',
              evidence: 'task asks for a row-count audit',
            },
          })}
        />,
      );

      expect(
        screen.queryByTestId('staged-intent-capability-file-mutation-warning'),
      ).toBeNull();
    });
  });

  describe('keyboard ring bindings', () => {
    it("'a' fires handleApprove for a highlighted grouped intent with no required input", async () => {
      const approve = vi
        .spyOn(stagedIntentsApi, 'approve')
        .mockResolvedValue({ ...makeIntent({ groupId: 'group-1' }) });

      render(
        <StagedIntentPanel
          intent={makeIntent({ groupId: 'group-1' })}
          highlighted
        />,
      );

      act(() => fireKey('a'));

      await waitFor(() => expect(approve).toHaveBeenCalledWith('intent-1'));
    });

    it("'a' is a no-op when the card isn't the ring's highlight", () => {
      const approve = vi.spyOn(stagedIntentsApi, 'approve');

      render(
        <StagedIntentPanel
          intent={makeIntent({ groupId: 'group-1' })}
          highlighted={false}
        />,
      );

      fireKey('a');

      expect(approve).not.toHaveBeenCalled();
    });

    it("'r' focuses the reason field and never submits by itself", () => {
      render(
        <StagedIntentPanel
          intent={makeIntent({ groupId: 'group-1' })}
          highlighted
        />,
      );

      const reasonField = screen.getByPlaceholderText(
        'What should the session revise?',
      ) as HTMLTextAreaElement;
      expect(document.activeElement).not.toBe(reasonField);

      fireKey('r');

      expect(document.activeElement).toBe(reasonField);
      expect(
        screen.getByRole('button', { name: /pushback|decline/i }),
      ).toBeTruthy();
      // Focusing the field alone must never fire a network call.
      expect(reasonField.value).toBe('');
    });

    it("'a' fires the same Commit handler as clicking the primary button for a standalone (non-grouped) card", async () => {
      const apply = vi
        .spyOn(stagedIntentsApi, 'apply')
        .mockResolvedValue({ ok: true, result: {} });

      render(<StagedIntentPanel intent={makeIntent()} highlighted />);

      act(() => fireKey('a'));

      await waitFor(() =>
        expect(apply).toHaveBeenCalledWith('intent-1', {
          override: false,
          reason: undefined,
          mirrorDisposition: undefined,
        }),
      );
    });

    it('renders a distinct keyboard-highlight class when highlighted, absent otherwise', () => {
      const { container, rerender } = render(
        <StagedIntentPanel intent={makeIntent()} highlighted={false} />,
      );
      const panel = container.querySelector(
        '[data-testid="staged-intent-panel"]',
      ) as HTMLElement;
      expect(panel.className).not.toMatch(/keyboardHighlighted/);

      rerender(<StagedIntentPanel intent={makeIntent()} highlighted />);
      expect(panel.className).toMatch(/keyboardHighlighted/);
    });
  });
});
