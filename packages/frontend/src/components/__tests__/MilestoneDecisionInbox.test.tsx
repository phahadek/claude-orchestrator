import {
  render,
  screen,
  waitFor,
  fireEvent,
  within,
} from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MilestoneDecisionInbox } from '../MilestoneDecisionInbox';
import { stagedIntentsApi } from '../../api/stagedIntents';
import type { StagedIntent } from '../../api/stagedIntents';
import type { TaskView } from '../../types/taskView';

vi.mock('../../hooks/stagedIntentBus', () => ({
  subscribeStagedIntentChange: () => () => {},
}));

function makeTask(overrides: Partial<TaskView> & { taskId: string }): TaskView {
  return {
    taskName: 'Untitled task',
    notionStatus: 'Ready',
    displayStatus: 'ready',
    pauseReason: null,
    priority: '🟡 Medium',
    notionUrl: '',
    taskType: '💻 Code',
    blocked: false,
    blockerNames: [],
    wave: 1,
    codeSession: null,
    planningSession: null,
    pr: null,
    review: null,
    totalTokens: { input: 0, output: 0 },
    assignedRepo: null,
    ...overrides,
  };
}

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

  it('excludes a card from both the list and the count while its owning session is incomplete', async () => {
    const intents: StagedIntent[] = [
      {
        id: 'complete-intent',
        kind: 'task.setStatus',
        payload: { taskId: 'notion:1', status: 'Ready' },
        projectId: 'proj-1',
        createdAt: 100,
        sessionId: 'session-groom',
        milestone: 'M1',
        state: 'staged',
        decisionProposal: 'Promote task 1',
        sessionComplete: true,
      },
      {
        id: 'incomplete-intent',
        kind: 'task.updateBody',
        payload: { taskId: 'notion:2', sections: {} },
        projectId: 'proj-1',
        createdAt: 1,
        sessionId: 'session-ops',
        milestone: 'M1',
        state: 'staged',
        sessionComplete: false,
      },
    ];
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue(intents);

    render(<MilestoneDecisionInbox projectId="proj-1" milestone="M1" />);

    await waitFor(() =>
      expect(screen.getByTestId('milestone-decision-inbox')).toBeTruthy(),
    );

    expect(screen.getByText('Decisions (1)')).toBeTruthy();
    expect(
      screen.getByTestId('milestone-decision-card-complete-intent'),
    ).toBeTruthy();
    expect(
      screen.queryByTestId('milestone-decision-card-incomplete-intent'),
    ).toBeNull();
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
    function cleanGroup(
      groupId: string,
      taskId: string,
      sessionId: string,
    ): StagedIntent[] {
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
              triage: {
                proposedVerdict: 'clean',
                hasOpenQuestionsHeading: false,
              },
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
      .mockResolvedValue({
        ok: true,
        committed: ['group-a', 'group-b'],
        exceptions: [],
      });

    render(<MilestoneDecisionInbox projectId="proj-1" milestone="M1" />);
    await waitFor(() => screen.getByTestId('milestone-decision-inbox'));

    expect(screen.getByTestId('clean-batch-bar')).toBeTruthy();
    expect(screen.getByText('Clean verdict (2)')).toBeTruthy();

    fireEvent.click(screen.getByTestId('approve-all-clean'));

    await waitFor(() =>
      expect(commitBatch).toHaveBeenCalledWith(
        ['group-a', 'group-b'],
        undefined,
      ),
    );
  });

  it('exposes a per-card control that routes to the session that staged it, for ungrouped and grouped intents', async () => {
    const intents: StagedIntent[] = [
      {
        id: 'ungrouped',
        kind: 'task.setStatus',
        payload: { taskId: 'notion:1', status: 'Ready' },
        projectId: 'proj-1',
        createdAt: 100,
        sessionId: 'session-ungrouped',
        milestone: 'M1',
        state: 'staged',
      },
      {
        id: 'grouped-dep',
        kind: 'task.setDependsOn',
        payload: { taskId: 'notion:2', dependsOn: [] },
        projectId: 'proj-1',
        createdAt: 1,
        sessionId: 'session-grouped',
        groupId: 'group-a',
        milestone: 'M1',
        state: 'staged',
      },
      {
        id: 'grouped-status',
        kind: 'task.setStatus',
        payload: { taskId: 'notion:2', status: 'Ready' },
        projectId: 'proj-1',
        createdAt: 2,
        sessionId: 'session-grouped',
        groupId: 'group-a',
        milestone: 'M1',
        state: 'staged',
      },
    ];
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue(intents);

    render(<MilestoneDecisionInbox projectId="proj-1" milestone="M1" />);
    await waitFor(() => screen.getByTestId('milestone-decision-inbox'));

    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    fireEvent.click(screen.getByTestId('session-jump-ungrouped'));
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'selectSession',
        detail: { sessionId: 'session-ungrouped' },
      }),
    );

    fireEvent.click(screen.getByTestId('session-jump-group-a'));
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'selectSession',
        detail: { sessionId: 'session-grouped' },
      }),
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

  it('renders a partially-applied group as such — an already-committed sibling alongside the one member still blocked', async () => {
    const groupId = 'group-partial';
    const blockedMember: StagedIntent = {
      id: 'blocked-member',
      kind: 'task.setStatus',
      payload: { taskId: 'notion:2', status: 'Ready' },
      projectId: 'proj-1',
      createdAt: 1,
      sessionId: 'session-groom',
      groupId,
      milestone: 'M1',
      state: 'needs_revision',
    };
    const committedMember: StagedIntent = {
      id: 'committed-member',
      kind: 'task.setDependsOn',
      payload: { taskId: 'notion:2', dependsOn: [] },
      projectId: 'proj-1',
      createdAt: 0,
      sessionId: 'session-groom',
      groupId,
      milestone: 'M1',
      state: 'committed',
    };
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([
      blockedMember,
    ]);
    vi.spyOn(stagedIntentsApi, 'listGroup').mockResolvedValue({
      groupId,
      wedged: false,
      intents: [committedMember, blockedMember],
    });

    render(<MilestoneDecisionInbox projectId="proj-1" milestone="M1" />);

    await waitFor(() =>
      expect(screen.getByTestId('milestone-decision-inbox')).toBeTruthy(),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId(`group-member-${committedMember.id}`),
      ).toBeTruthy(),
    );

    // The already-committed sibling and the still-blocked member both render
    // on the same card — a partially-applied group reads as such instead of
    // an orphaned status-only intent.
    const card = screen.getByTestId(`milestone-decision-card-${groupId}`);
    expect(card.textContent).toContain('task.setDependsOn');
    expect(card.textContent).toContain('task.setStatus');
    expect(card.textContent).toContain('committed');
    expect(card.textContent).toContain('needs_revision');

    // The blocked member's own per-member Decline affordance is exposed
    // (actions aren't hidden for it) once expanded, while the committed
    // sibling stays read-only.
    fireEvent.click(screen.getByTestId('group-member-toggle-blocked-member'));
    expect(screen.getByRole('button', { name: /decline/i })).toBeTruthy();
  });

  it('shows a failed group approve error only on that group card, not on other group cards', async () => {
    function group(groupId: string, taskId: string): StagedIntent[] {
      return [
        {
          id: `${groupId}-status`,
          kind: 'task.setStatus',
          payload: { taskId, status: 'Ready' },
          projectId: 'proj-1',
          createdAt: 0,
          groupId,
          milestone: 'M1',
          state: 'staged',
        },
      ];
    }
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([
      ...group('group-a', 't-a'),
      ...group('group-b', 't-b'),
    ]);
    vi.spyOn(stagedIntentsApi, 'approveGroup').mockRejectedValue(
      new Error('boom'),
    );

    render(<MilestoneDecisionInbox projectId="proj-1" milestone="M1" />);
    await waitFor(() => screen.getByTestId('milestone-decision-inbox'));

    const cardA = screen.getByTestId('milestone-decision-card-group-a');
    const cardB = screen.getByTestId('milestone-decision-card-group-b');

    fireEvent.click(
      within(cardA).getByRole('button', { name: /approve groom/i }),
    );

    await waitFor(() => expect(cardA.textContent).toContain('boom'));
    expect(cardB.textContent).not.toContain('boom');
  });

  it("labels a group card with its target task's name and Type, not the raw group id", async () => {
    const intents: StagedIntent[] = [
      {
        id: 'group-a-status',
        kind: 'task.setStatus',
        payload: { taskId: 'notion:1', status: 'Ready' },
        projectId: 'proj-1',
        createdAt: 0,
        groupId: 'group-a',
        milestone: 'M1',
        state: 'staged',
      },
    ];
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue(intents);

    render(
      <MilestoneDecisionInbox
        projectId="proj-1"
        milestone="M1"
        tasks={[
          makeTask({
            taskId: 'notion:1',
            taskName: 'Fix the flaky retry loop',
            taskType: '💻 Code',
          }),
        ]}
      />,
    );
    await waitFor(() => screen.getByTestId('milestone-decision-inbox'));

    const card = screen.getByTestId('milestone-decision-card-group-a');
    expect(card.textContent).toContain('Fix the flaky retry loop');
    expect(card.textContent).toContain('💻');
    expect(card.textContent).toContain('Group group-a');
  });

  it("labels an ungrouped intent card with its target task's name and Type beside the session uuid", async () => {
    const intents: StagedIntent[] = [
      {
        id: 'ungrouped-1',
        kind: 'task.updateBody',
        payload: { taskId: 'notion:2', sections: {} },
        projectId: 'proj-1',
        createdAt: 0,
        sessionId: '0067bf6b-9ff8-4782-bd94-d1d9579b68d1',
        milestone: 'M1',
        state: 'staged',
      },
    ];
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue(intents);

    render(
      <MilestoneDecisionInbox
        projectId="proj-1"
        milestone="M1"
        tasks={[
          makeTask({
            taskId: 'notion:2',
            taskName: 'Groom the wire-analyst MCP guide',
            taskType: '📐 Design',
          }),
        ]}
      />,
    );
    await waitFor(() => screen.getByTestId('milestone-decision-inbox'));

    const card = screen.getByTestId('milestone-decision-card-ungrouped-1');
    expect(card.textContent).toContain('Groom the wire-analyst MCP guide');
    expect(card.textContent).toContain('📐');
    expect(
      screen.getByTestId('provenance-badge-ungrouped-1').textContent,
    ).toBe('0067bf6b-9ff8-4782-bd94-d1d9579b68d1');
  });

  it('falls back to a defined label, without crashing, for an intent with no resolvable task ref', async () => {
    const intents: StagedIntent[] = [
      {
        id: 'pickone-no-task',
        kind: 'decision.pickOne',
        payload: {
          prompt: 'Which approach?',
          options: [{ label: 'A', description: 'Option A' }],
          allowFreeForm: false,
        },
        projectId: 'proj-1',
        createdAt: 0,
        milestone: 'M1',
        state: 'staged',
      },
    ];
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue(intents);

    render(
      <MilestoneDecisionInbox projectId="proj-1" milestone="M1" tasks={[]} />,
    );
    await waitFor(() => screen.getByTestId('milestone-decision-inbox'));

    const card = screen.getByTestId('milestone-decision-card-pickone-no-task');
    expect(card.textContent).toContain('decision.pickOne');
  });
});
