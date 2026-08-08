import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { GroupCard } from '../GroupCard';
import type { StagedIntent } from '../../api/stagedIntents';

function makeIntent(overrides: Partial<StagedIntent> = {}): StagedIntent {
  return {
    id: 'intent-1',
    kind: 'journal.setState',
    payload: { taskId: 'notion:abc' },
    projectId: 'proj-1',
    createdAt: 0,
    groupId: 'group-1',
    ...overrides,
  };
}

function baseProps(overrides: Partial<Parameters<typeof GroupCard>[0]> = {}) {
  return {
    groupId: 'group-1',
    members: [{ intent: makeIntent() }],
    onApplied: vi.fn(),
    onRejected: vi.fn(),
    onDismiss: vi.fn(),
    onApproved: vi.fn(),
    inFlight: false,
    draft: { outcome: 'pushback' as const, reason: '' },
    onSetDraft: vi.fn(),
    onApproveGroup: vi.fn(),
    onRejectGroup: vi.fn(),
    onRecoverGroup: vi.fn(),
    ...overrides,
  };
}

describe('GroupCard investigation head', () => {
  it('renders a first member investigation payload in the card head without expanding', () => {
    render(
      <GroupCard
        {...baseProps({
          members: [
            {
              intent: makeIntent({ investigation: 'Root cause: file:line.' }),
            },
          ],
        })}
      />,
    );

    expect(
      screen.getByTestId('group-card-investigation').textContent,
    ).toContain('Root cause: file:line.');
  });

  it('pins precedence: groomProposal beats decisionProposal beats investigation', () => {
    render(
      <GroupCard
        {...baseProps({
          members: [
            {
              intent: makeIntent({
                groomProposal: {
                  achieves: 'Achieves text',
                  openQuestions: 'Open qs',
                  automatedTests: 'Tests',
                  manualVerification: 'Manual',
                  operationalSeed: 'Seed',
                },
                decisionProposal: 'Decision rationale',
                investigation: 'Investigation evidence',
              }),
            },
          ],
        })}
      />,
    );

    expect(screen.getByTestId('group-card-groom-proposal')).toBeTruthy();
    expect(screen.queryByTestId('group-card-investigation')).toBeNull();
    expect(screen.queryByText('Decision rationale')).toBeNull();
  });

  it('falls back to decisionProposal over investigation when no groomProposal is present', () => {
    render(
      <GroupCard
        {...baseProps({
          members: [
            {
              intent: makeIntent({
                decisionProposal: 'Decision rationale',
                investigation: 'Investigation evidence',
              }),
            },
          ],
        })}
      />,
    );

    expect(screen.getByText('Decision rationale')).toBeTruthy();
    expect(screen.queryByTestId('group-card-investigation')).toBeNull();
  });

  it('renders a groomProposal group exactly as before — regression, head widened not reordered', () => {
    render(
      <GroupCard
        {...baseProps({
          members: [
            {
              intent: makeIntent({
                groomProposal: {
                  achieves: 'Achieves text',
                  openQuestions: 'Open qs',
                  automatedTests: 'Tests',
                  manualVerification: 'Manual',
                  operationalSeed: 'Seed',
                },
              }),
            },
          ],
        })}
      />,
    );

    expect(screen.getByTestId('group-card-groom-proposal')).toBeTruthy();
    expect(screen.getByText('Achieves text')).toBeTruthy();
    expect(screen.queryByTestId('group-card-investigation')).toBeNull();
  });

  it('renders a decisionProposal group exactly as before — regression, head widened not reordered', () => {
    render(
      <GroupCard
        {...baseProps({
          members: [
            {
              intent: makeIntent({ decisionProposal: 'Decision rationale' }),
            },
          ],
        })}
      />,
    );

    expect(screen.getByText('Decision rationale')).toBeTruthy();
    expect(screen.queryByTestId('group-card-investigation')).toBeNull();
  });

  it('renders the worked single-member investigation-only journal.setState group non-empty', () => {
    render(
      <GroupCard
        {...baseProps({
          members: [
            {
              intent: makeIntent({
                kind: 'journal.setState',
                investigation:
                  'Full report including a correction to the task premise.',
              }),
            },
          ],
        })}
      />,
    );

    const head = screen.getByTestId('group-card-investigation');
    expect(head.textContent).toContain(
      'Full report including a correction to the task premise.',
    );
  });

  it('expanding the head-source member renders the investigation text exactly once, not duplicated', () => {
    render(
      <GroupCard
        {...baseProps({
          members: [
            {
              intent: makeIntent({ investigation: 'Root cause: file:line.' }),
            },
          ],
        })}
      />,
    );

    // Present once, in the head, before expansion.
    expect(screen.getAllByText('Root cause: file:line.')).toHaveLength(1);

    fireEvent.click(screen.getByTestId('group-member-toggle-intent-1'));

    // Still present exactly once after the member expands.
    expect(screen.getAllByText('Root cause: file:line.')).toHaveLength(1);
  });
});
