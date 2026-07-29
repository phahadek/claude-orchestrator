import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MilestoneDecisionInbox } from '../MilestoneDecisionInbox';
import { stagedIntentsApi } from '../../api/stagedIntents';
import type { StagedIntent } from '../../api/stagedIntents';

vi.mock('../../hooks/stagedIntentBus', () => ({
  subscribeStagedIntentChange: () => () => {},
}));

describe('MilestoneDecisionInbox', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders every decision in the order the backend ranked them, tagged with a provenance badge', async () => {
    const intents: StagedIntent[] = [
      {
        id: 'top-ranked',
        kind: 'task.setStatus',
        payload: { taskId: 'notion:1', status: 'Ready' },
        projectId: 'proj-1',
        createdAt: 100,
        sessionId: 'session-groom',
        milestone: 'M1',
        state: 'staged',
        decisionProposal: 'Promote task 1',
      },
      {
        id: 'lower-ranked',
        kind: 'task.updateBody',
        payload: { taskId: 'notion:2', sections: {} },
        projectId: 'proj-1',
        createdAt: 1,
        sessionId: 'session-ops',
        milestone: 'M1',
        state: 'staged',
      },
    ];
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue(intents);

    render(<MilestoneDecisionInbox projectId="proj-1" milestone="M1" />);

    await waitFor(() =>
      expect(screen.getByTestId('milestone-decision-inbox')).toBeTruthy(),
    );

    const badges = screen
      .getAllByTestId(/^provenance-badge-/)
      .map((el) => el.getAttribute('data-testid'));
    expect(badges).toEqual([
      'provenance-badge-top-ranked',
      'provenance-badge-lower-ranked',
    ]);

    expect(screen.getByTestId('provenance-badge-top-ranked').textContent).toBe(
      'session-groom',
    );
    expect(
      screen.getByTestId('provenance-badge-lower-ranked').textContent,
    ).toBe('session-ops');
  });

  it('renders an unanswered decision.pickOne first when the backend floats it to the top', async () => {
    const intents: StagedIntent[] = [
      {
        id: 'pickone-unanswered',
        kind: 'decision.pickOne',
        payload: {
          prompt: 'Which approach?',
          options: [
            { label: 'A', description: 'Option A' },
            { label: 'B', description: 'Option B' },
          ],
          allowFreeForm: false,
        },
        projectId: 'proj-1',
        createdAt: 1,
        sessionId: 'session-groom',
        milestone: 'M1',
        state: 'staged',
        decisionProposal: 'Need a call on the approach',
      },
      {
        id: 'ordinary-intent',
        kind: 'task.updateBody',
        payload: { taskId: 'notion:2', sections: {} },
        projectId: 'proj-1',
        createdAt: 999,
        sessionId: 'session-ops',
        milestone: 'M1',
        state: 'staged',
      },
    ];
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue(intents);

    render(<MilestoneDecisionInbox projectId="proj-1" milestone="M1" />);

    await waitFor(() =>
      expect(screen.getByTestId('milestone-decision-inbox')).toBeTruthy(),
    );

    expect(screen.getByText('Which approach?')).toBeTruthy();
    const inbox = screen.getByTestId('milestone-decision-inbox');
    const pickOneEl = screen.getByText('Which approach?');
    const otherCard = screen.getByTestId('provenance-badge-ordinary-intent');
    expect(
      pickOneEl.compareDocumentPosition(otherCard) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(inbox.contains(pickOneEl)).toBe(true);
  });

  it('pools clean-verdict groups across different sessions into one TriageBatchPanel/commitBatch', async () => {
    function cleanGroup(groupId: string, taskId: string, sessionId: string): StagedIntent[] {
      return [
        {
          id: `${groupId}-dep`,
          kind: 'task.setDependsOn',
          payload: { taskId, dependsOn: [] },
          projectId: 'proj-1',
          createdAt: 0,
          sessionId,
          groupId,
          milestone: 'M1',
          state: 'staged',
        },
        {
          id: `${groupId}-status`,
          kind: 'task.setStatus',
          payload: {
            taskId,
            status: 'Ready',
            groomingGate: {
              type: '📐 Design',
              triage: { proposedVerdict: 'clean', hasOpenQuestionsHeading: false },
            },
          },
          projectId: 'proj-1',
          createdAt: 1,
          sessionId,
          groupId,
          milestone: 'M1',
          state: 'staged',
        },
      ];
    }

    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([
      ...cleanGroup('group-a', 't-a', 'session-1'),
      ...cleanGroup('group-b', 't-b', 'session-2'),
    ]);
    const commitBatch = vi
      .spyOn(stagedIntentsApi, 'commitBatch')
      .mockResolvedValue({ ok: true, committed: ['group-a', 'group-b'], exceptions: [] });

    render(<MilestoneDecisionInbox projectId="proj-1" milestone="M1" />);
    await waitFor(() => screen.getByTestId('milestone-decision-inbox'));

    expect(screen.getByTestId('clean-batch-bar')).toBeTruthy();
    expect(screen.getByText('Clean verdict (2)')).toBeTruthy();

    fireEvent.click(screen.getByTestId('approve-all-clean'));

    await waitFor(() =>
      expect(commitBatch).toHaveBeenCalledWith(['group-a', 'group-b'], undefined),
    );
  });

  it('renders nothing when the milestone has no staged decisions', async () => {
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([]);

    const { container } = render(
      <MilestoneDecisionInbox projectId="proj-1" milestone="M1" />,
    );

    await waitFor(() =>
      expect(stagedIntentsApi.listByMilestone).toHaveBeenCalledWith(
        'proj-1',
        'M1',
      ),
    );
    expect(container.firstChild).toBeNull();
  });
});
