import { render, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MilestoneDecisionStack } from '../MilestoneDecisionStack';
import { stagedIntentsApi } from '../../api/stagedIntents';
import { publishStagedIntentChange } from '../../hooks/stagedIntentBus';
import type { StagedIntent } from '../../api/stagedIntents';

// Deliberately does NOT mock stagedIntentBus (unlike MilestoneDecisionStack.test.tsx)
// — these tests exercise the real live-arrival path a WS `staged_intent_changed`
// event drives, via useDecisionQueue's subscription.

function makeIntent(
  overrides: Partial<StagedIntent> & { id: string },
): StagedIntent {
  return {
    kind: 'task.setStatus',
    payload: { taskId: `task-${overrides.id}`, status: 'Ready' },
    projectId: 'proj-1',
    createdAt: 0,
    milestone: 'M1',
    state: 'staged',
    sessionComplete: true,
    ...overrides,
  };
}

describe('MilestoneDecisionStack scroll compensation on live arrival', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves the previously-topmost-visible card by adjusting scrollTop when a live arrival is inserted above it', async () => {
    const existing: StagedIntent[] = [
      makeIntent({ id: 'c1', createdAt: 3 }),
      makeIntent({ id: 'c2', createdAt: 2 }),
      makeIntent({ id: 'c3', createdAt: 1 }),
    ];
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue(existing);

    const container = document.body.appendChild(document.createElement('div'));
    const scrollContainerRef = { current: container };

    const { findByTestId, rerender } = render(
      <MilestoneDecisionStack
        projectId="proj-1"
        milestone="M1"
        tasks={[]}
        phaseFilter={null}
        selection={null}
        onSelect={vi.fn()}
        scrollContainerRef={scrollContainerRef}
      />,
      { container },
    );

    const card1 = await findByTestId('milestone-decision-card-c1');
    const card2 = await findByTestId('milestone-decision-card-c2');
    const card3 = await findByTestId('milestone-decision-card-c3');

    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
      top: 0,
    } as DOMRect);
    // The operator has scrolled so card c1 is above the viewport and c2 is
    // the topmost visible card.
    vi.spyOn(card1, 'getBoundingClientRect').mockReturnValue({
      top: -50,
    } as DOMRect);
    vi.spyOn(card2, 'getBoundingClientRect').mockReturnValue({
      top: 4,
    } as DOMRect);
    vi.spyOn(card3, 'getBoundingClientRect').mockReturnValue({
      top: 104,
    } as DOMRect);
    container.scrollTop = 150;

    // Re-render (no prop changes) so the compensation effect captures this
    // scrolled layout as its "before" snapshot ahead of the live arrival.
    rerender(
      <MilestoneDecisionStack
        projectId="proj-1"
        milestone="M1"
        tasks={[]}
        phaseFilter={null}
        selection={null}
        onSelect={vi.fn()}
        scrollContainerRef={scrollContainerRef}
      />,
    );

    // Simulate the real DOM shift a 100px-tall inserted card would cause:
    // every existing card moves down by 100px.
    (card1.getBoundingClientRect as any).mockReturnValue({ top: 50 });
    (card2.getBoundingClientRect as any).mockReturnValue({ top: 104 });
    (card3.getBoundingClientRect as any).mockReturnValue({ top: 204 });

    const arrival = makeIntent({
      id: 'live-arrival',
      kind: 'task.setStatus',
      createdAt: 10,
    });
    act(() => {
      publishStagedIntentChange(arrival);
    });

    await findByTestId('milestone-decision-card-live-arrival');

    // scrollTop was nudged by exactly the 100px the topmost-visible card
    // (c2) moved — so c2 stays put relative to the viewport instead of the
    // panel appearing to auto-scroll.
    expect(container.scrollTop).toBe(250);
  });

  it('does not compensate when the inbox held 0 intents before the arrival', async () => {
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([]);

    const container = document.body.appendChild(document.createElement('div'));
    const scrollContainerRef = { current: container };

    const { findByTestId } = render(
      <MilestoneDecisionStack
        projectId="proj-1"
        milestone="M1"
        tasks={[]}
        phaseFilter={null}
        selection={null}
        onSelect={vi.fn()}
        scrollContainerRef={scrollContainerRef}
      />,
      { container },
    );

    // Wait for the initial (empty) fetch to resolve before dispatching the
    // arrival — otherwise the fetch's belated setIntents/setLoaded can land
    // after the live arrival and clobber it back to [].
    await findByTestId('milestone-decision-inbox');

    container.scrollTop = 50;

    const arrival = makeIntent({ id: 'first-arrival', createdAt: 1 });
    act(() => {
      publishStagedIntentChange(arrival);
    });

    await findByTestId('milestone-decision-card-first-arrival');

    // No prior cards to preserve — nothing was adjusted.
    expect(container.scrollTop).toBe(50);
  });
});
