import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { GroupCard } from '../GroupCard';
import type { StagedIntent } from '../../api/stagedIntents';

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
    groupId: 'group-1',
    ...overrides,
  };
}

function baseProps(overrides: Partial<Parameters<typeof GroupCard>[0]> = {}) {
  return {
    groupId: 'group-1',
    members: [{ intent: makeIntent(), hideActions: true }],
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

describe('GroupCard keyboard ring bindings', () => {
  it("'a' fires onApproveGroup for a highlighted group card with no required input", () => {
    const onApproveGroup = vi.fn();
    render(<GroupCard {...baseProps({ onApproveGroup, highlighted: true })} />);

    fireKey('a');

    expect(onApproveGroup).toHaveBeenCalledTimes(1);
  });

  it("'a' is a no-op when the group card isn't the ring's highlight", () => {
    const onApproveGroup = vi.fn();
    render(
      <GroupCard {...baseProps({ onApproveGroup, highlighted: false })} />,
    );

    fireKey('a');

    expect(onApproveGroup).not.toHaveBeenCalled();
  });

  it("'a' is a no-op while the group is in flight", () => {
    const onApproveGroup = vi.fn();
    render(
      <GroupCard
        {...baseProps({ onApproveGroup, highlighted: true, inFlight: true })}
      />,
    );

    fireKey('a');

    expect(onApproveGroup).not.toHaveBeenCalled();
  });

  it("'r' focuses the group's reason field and never triggers reject by itself", () => {
    const onRejectGroup = vi.fn();
    render(<GroupCard {...baseProps({ onRejectGroup, highlighted: true })} />);

    const reasonField = screen.getByPlaceholderText(
      'What should the session revise?',
    ) as HTMLTextAreaElement;
    expect(document.activeElement).not.toBe(reasonField);

    fireKey('r');

    expect(document.activeElement).toBe(reasonField);
    expect(onRejectGroup).not.toHaveBeenCalled();
  });

  it('renders a distinct keyboard-highlight class when highlighted, absent otherwise', () => {
    const { rerender } = render(
      <GroupCard {...baseProps({ highlighted: false })} />,
    );
    const card = screen.getByTestId('group-card-group-1');
    expect(card.className).not.toMatch(/keyboardHighlighted/);

    rerender(<GroupCard {...baseProps({ highlighted: true })} />);
    expect(card.className).toMatch(/keyboardHighlighted/);
  });
});

describe('GroupCard size estimate in collapsed head', () => {
  it('renders LoC and file count from a member groomingGate.size_check without expanding any member', () => {
    render(
      <GroupCard
        {...baseProps({
          members: [
            {
              intent: makeIntent({
                payload: {
                  taskId: 'notion:abc',
                  status: 'Ready',
                  groomingGate: {
                    size_check: { decision: 'pass', loc: 123, files: 4 },
                  },
                },
              }),
              hideActions: true,
            },
          ],
        })}
      />,
    );

    expect(screen.getByTestId('group-card-size-estimate').textContent).toBe(
      '123 LoC, 4 files',
    );
  });

  it('renders no size estimate when no member carries a size_check with loc/files, without throwing', () => {
    render(<GroupCard {...baseProps()} />);

    expect(screen.queryByTestId('group-card-size-estimate')).toBeNull();
  });

  it('renders no size estimate when the size_check is missing loc/files', () => {
    render(
      <GroupCard
        {...baseProps({
          members: [
            {
              intent: makeIntent({
                payload: {
                  taskId: 'notion:abc',
                  status: 'Ready',
                  groomingGate: {
                    size_check: { decision: 'pass' },
                  },
                },
              }),
              hideActions: true,
            },
          ],
        })}
      />,
    );

    expect(screen.queryByTestId('group-card-size-estimate')).toBeNull();
  });
});

describe('GroupCard recovery affordance', () => {
  it('renders neither the banner nor a control for a committable group', () => {
    render(<GroupCard {...baseProps()} />);

    expect(screen.queryByTestId('recovery-banner-group-1')).toBeNull();
  });

  it('renders a blocked-member banner and control exactly as today when this group has a visible blocked member', () => {
    render(
      <GroupCard
        {...baseProps({
          members: [
            {
              intent: makeIntent({ state: 'needs_revision' }),
              hideActions: true,
            },
          ],
        })}
      />,
    );

    const banner = screen.getByTestId('recovery-banner-group-1');
    expect(banner.textContent).toMatch(/1 blocked member/);
    expect(screen.getByTestId('recover-group-group-1')).toBeTruthy();
  });

  it('renders a recovery control for a group with groupBlocked true and zero visible blocked members', () => {
    const onRecoverGroup = vi.fn();
    render(
      <GroupCard
        {...baseProps({
          members: [
            {
              intent: makeIntent({ groupBlocked: true }),
              hideActions: true,
            },
          ],
          onRecoverGroup,
        })}
      />,
    );

    expect(screen.getByTestId('recovery-banner-group-1')).toBeTruthy();
  });

  it('names the blocking group and targets it in the Recover control when the blocker is a sibling group', () => {
    const onRecoverGroup = vi.fn();
    render(
      <GroupCard
        {...baseProps({
          members: [
            {
              intent: makeIntent({
                groupBlocked: true,
                blockingGroupId: 'group-99',
                blockingGroupBlockedMemberCount: 3,
              }),
              hideActions: true,
            },
          ],
          onRecoverGroup,
        })}
      />,
    );

    const banner = screen.getByTestId('recovery-banner-group-1');
    expect(banner.textContent).toMatch(/Blocked by group group-99/);
    expect(banner.textContent).toMatch(/3 blocked member/);
    expect(banner.textContent).not.toMatch(/awaiting session/i);

    fireEvent.click(screen.getByTestId('recover-group-group-99'));
    expect(onRecoverGroup).toHaveBeenCalledWith('group-99');
  });

  it('shows a non-actionable message with no control when session-blocked but blockingGroupId is null', () => {
    render(
      <GroupCard
        {...baseProps({
          members: [
            {
              intent: makeIntent({
                groupBlocked: true,
                blockingGroupId: null,
                blockingGroupBlockedMemberCount: null,
              }),
              hideActions: true,
            },
          ],
        })}
      />,
    );

    const banner = screen.getByTestId('recovery-banner-group-1');
    expect(banner.textContent).toMatch(
      /blocked by an unresolved proposal from this session/i,
    );
    expect(screen.queryByTestId('recover-group-group-1')).toBeNull();
  });

  it('keeps Approve disabled for a session-blocked group with zero visible blocked members', () => {
    render(
      <GroupCard
        {...baseProps({
          members: [
            {
              intent: makeIntent({ groupBlocked: true }),
              hideActions: true,
            },
          ],
        })}
      />,
    );

    expect(
      screen
        .getByRole('button', { name: /Approve/i })
        .hasAttribute('disabled'),
    ).toBe(true);
  });
});

describe('GroupCard reject-outcome default', () => {
  it('defaults to pushback and enables reject once a reason is entered, with no blocked members', () => {
    const onRejectGroup = vi.fn();
    render(
      <GroupCard
        {...baseProps({
          draft: { outcome: null, reason: 'looks off' },
          onRejectGroup,
        })}
      />,
    );

    screen.getByPlaceholderText('What should the session revise?');
    const rejectButton = screen.getByRole('button', {
      name: /Pushback/,
    }) as HTMLButtonElement;
    expect(rejectButton.disabled).toBe(false);
  });

  it('defaults to decline once a member is blocked, and still only gates on the reason', () => {
    const onRejectGroup = vi.fn();
    render(
      <GroupCard
        {...baseProps({
          members: [
            {
              intent: {
                id: 'intent-1',
                kind: 'task.setStatus',
                payload: {},
                projectId: 'proj-1',
                createdAt: 0,
                groupId: 'group-1',
                state: 'needs_revision',
              },
              hideActions: true,
            },
          ],
          draft: { outcome: null, reason: 'out of scope' },
          onRejectGroup,
        })}
      />,
    );

    screen.getByPlaceholderText('Why is this being declined?');
    const rejectButton = screen.getByRole('button', {
      name: /Decline/,
    }) as HTMLButtonElement;
    expect(rejectButton.disabled).toBe(false);
  });

  it('disables reject while the reason is empty, regardless of the resolved outcome', () => {
    render(
      <GroupCard {...baseProps({ draft: { outcome: null, reason: '' } })} />,
    );

    const rejectButton = screen.getByRole('button', {
      name: /Pushback/,
    }) as HTMLButtonElement;
    expect(rejectButton.disabled).toBe(true);
  });
});
