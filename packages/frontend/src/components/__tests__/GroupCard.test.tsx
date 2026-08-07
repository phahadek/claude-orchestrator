import { render, screen } from '@testing-library/react';
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
