import {
  render,
  screen,
  waitFor,
  fireEvent,
  within,
} from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MilestoneDecisionInbox } from '../MilestoneDecisionInbox';
import { stagedIntentsApi } from '../../api/stagedIntents';
import { gateApi } from '../../api/gate';
import { reportsApi } from '../../api/reports';
import { investigateApi } from '../../api/investigate';
import type { StagedIntent } from '../../api/stagedIntents';
import type { InvestigationReport } from '../../api/reports';
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
    depthReview: null,
    totalTokens: { input: 0, output: 0 },
    assignedRepo: null,
    ...overrides,
  };
}

function makeReport(
  overrides: Partial<InvestigationReport> & { id: string },
): InvestigationReport {
  return {
    project_id: 'proj-1',
    milestone_id: 'M1',
    title: 'Untitled report',
    symptom_text: 'Something looked wrong',
    evidence_text: null,
    state: 'draft',
    source: 'operator',
    origin_session_id: null,
    origin_task_id: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    inFlight: false,
    resolveEligible: false,
    dispatchedSessions: [],
    ...overrides,
  };
}

describe('MilestoneDecisionInbox', () => {
  beforeEach(() => {
    vi.spyOn(reportsApi, 'list').mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
    });
  });

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
        groupKind: 'groom',
        milestone: 'M1',
        state: 'staged',
        decisionProposal: 'Promote task 1',
        sessionComplete: true,
      },
      {
        id: 'lower-ranked',
        kind: 'task.updateBody',
        payload: { taskId: 'notion:2', sections: {} },
        projectId: 'proj-1',
        createdAt: 1,
        sessionId: 'session-ops',
        groupKind: 'investigation',
        milestone: 'M1',
        state: 'staged',
        sessionComplete: true,
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
      'Groom',
    );
    expect(
      screen.getByTestId('provenance-badge-lower-ranked').textContent,
    ).toBe('Investigation');
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
        sessionComplete: true,
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
        sessionComplete: true,
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
          sessionComplete: true,
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
          sessionComplete: true,
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

  it('gives the View session button its own handler — selecting the card via onViewSession, distinct from onSelectIntent, without dispatching a selectSession navigation event', async () => {
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
        sessionComplete: true,
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
        sessionComplete: true,
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
        sessionComplete: true,
      },
    ];
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue(intents);

    const onSelectIntent = vi.fn();
    const onViewSession = vi.fn();
    render(
      <MilestoneDecisionInbox
        projectId="proj-1"
        milestone="M1"
        onSelectIntent={onSelectIntent}
        onViewSession={onViewSession}
      />,
    );
    await waitFor(() => screen.getByTestId('milestone-decision-inbox'));

    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    fireEvent.click(screen.getByTestId('session-jump-ungrouped'));
    expect(onViewSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ungrouped' }),
    );

    fireEvent.click(screen.getByTestId('session-jump-group-a'));
    expect(onViewSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'grouped-dep' }),
    );

    // The button is wired to onViewSession, not onSelectIntent — it must not
    // repeat the card's own click handler.
    expect(onSelectIntent).not.toHaveBeenCalled();

    expect(dispatchSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'selectSession' }),
    );
  });

  it('renders no decision cards, but keeps the investigation-report section, when the milestone has no staged decisions', async () => {
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([]);

    render(<MilestoneDecisionInbox projectId="proj-1" milestone="M1" />);

    await waitFor(() =>
      expect(stagedIntentsApi.listByMilestone).toHaveBeenCalledWith(
        'proj-1',
        'M1',
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId('investigation-report-section')).toBeTruthy(),
    );
    expect(screen.queryByText(/^Decisions \(/)).toBeNull();
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
      sessionComplete: true,
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
      sessionComplete: true,
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
    const memberPanel = screen.getByTestId('group-member-blocked-member');
    expect(
      within(memberPanel).getByRole('button', { name: /decline/i }),
    ).toBeTruthy();
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
          groupKind: 'groom',
          milestone: 'M1',
          state: 'staged',
          sessionComplete: true,
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

  it('renders no recovery control for a group with no blocked members', async () => {
    const groupId = 'group-clean';
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([
      {
        id: `${groupId}-status`,
        kind: 'task.setStatus',
        payload: { taskId: 't-clean', status: 'Ready' },
        projectId: 'proj-1',
        createdAt: 0,
        groupId,
        milestone: 'M1',
        state: 'staged',
        sessionComplete: true,
      },
    ]);

    render(<MilestoneDecisionInbox projectId="proj-1" milestone="M1" />);
    await waitFor(() => screen.getByTestId('milestone-decision-inbox'));

    expect(screen.queryByTestId(`recover-group-${groupId}`)).toBeNull();
  });

  it('shows a recovery control naming the blocked member count and invoking it calls recoverGroup, re-rendering from the response', async () => {
    const groupId = 'group-wedged';
    const blockedMember: StagedIntent = {
      id: 'wedged-member',
      kind: 'gate.accrete',
      payload: { taskId: 't-wedged' },
      projectId: 'proj-1',
      createdAt: 0,
      sessionId: 'session-groom',
      groupId,
      milestone: 'M1',
      state: 'needs_revision',
      sessionComplete: true,
    };
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([
      blockedMember,
    ]);
    vi.spyOn(stagedIntentsApi, 'listGroup').mockResolvedValue({
      groupId,
      wedged: true,
      intents: [blockedMember],
    });
    const recoverGroup = vi
      .spyOn(stagedIntentsApi, 'recoverGroup')
      .mockResolvedValue({
        ok: true,
        recovered: [{ ...blockedMember, state: 'staged' }],
      });

    render(<MilestoneDecisionInbox projectId="proj-1" milestone="M1" />);
    await waitFor(() => screen.getByTestId('milestone-decision-inbox'));

    const banner = screen.getByTestId(`recovery-banner-${groupId}`);
    expect(banner.textContent).toMatch(/1 blocked member/);

    fireEvent.click(screen.getByTestId(`recover-group-${groupId}`));

    await waitFor(() => expect(recoverGroup).toHaveBeenCalledWith(groupId));
    await waitFor(() =>
      expect(screen.queryByTestId(`recovery-banner-${groupId}`)).toBeNull(),
    );
  });

  it('renders a pushed-back group (operator needs_revision, no autoRejected annotation) as blocked, disables Approve, and never fires the commit request when clicked', async () => {
    const groupId = 'group-pushed-back';
    const blockedMember: StagedIntent = {
      id: `${groupId}-status`,
      kind: 'task.setStatus',
      payload: { taskId: 't-pushed-back', status: 'Ready' },
      projectId: 'proj-1',
      createdAt: 0,
      sessionId: 'session-groom',
      groupId,
      groupKind: 'groom',
      milestone: 'M1',
      state: 'needs_revision',
      sessionComplete: true,
      groupBlocked: true,
      groupBlockedMemberCount: 1,
    };
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([
      blockedMember,
    ]);
    const approveGroup = vi.spyOn(stagedIntentsApi, 'approveGroup');

    render(<MilestoneDecisionInbox projectId="proj-1" milestone="M1" />);
    await waitFor(() => screen.getByTestId('milestone-decision-inbox'));

    const card = screen.getByTestId(`milestone-decision-card-${groupId}`);
    expect(within(card).getByTestId(`recovery-banner-${groupId}`)).toBeTruthy();

    const approveButton = within(card).getByRole('button', {
      name: /approve groom/i,
    }) as HTMLButtonElement;
    expect(approveButton.disabled).toBe(true);

    fireEvent.click(approveButton);
    expect(approveGroup).not.toHaveBeenCalled();
  });

  it('renders a pending_verification member as blocked, disabling Approve, the same as an auto-rejected one', async () => {
    const groupId = 'group-pending-verification';
    const blockedMember: StagedIntent = {
      id: `${groupId}-status`,
      kind: 'task.setStatus',
      payload: { taskId: 't-pv', status: 'Ready' },
      projectId: 'proj-1',
      createdAt: 0,
      sessionId: 'session-groom',
      groupId,
      groupKind: 'groom',
      milestone: 'M1',
      state: 'pending_verification',
      sessionComplete: true,
      groupBlocked: true,
      groupBlockedMemberCount: 1,
    };
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([
      blockedMember,
    ]);

    render(<MilestoneDecisionInbox projectId="proj-1" milestone="M1" />);
    await waitFor(() => screen.getByTestId('milestone-decision-inbox'));

    const card = screen.getByTestId(`milestone-decision-card-${groupId}`);
    expect(within(card).getByTestId(`recovery-banner-${groupId}`)).toBeTruthy();
    const approveButton = within(card).getByRole('button', {
      name: /approve groom/i,
    }) as HTMLButtonElement;
    expect(approveButton.disabled).toBe(true);
  });

  it('renders a group blocked (Approve disabled, no Recover offered) when its only blocked member is auto-rejected and hidden behind a still-live session', async () => {
    const groupId = 'group-hidden-blocked';
    // The auto-rejected/needs_revision sibling never reaches the frontend —
    // isVisibleOnDecisionSurface filters it out server-side while its
    // session is live — so only its visible sibling is fetched. The backend
    // still marks the visible sibling groupBlocked: true because it reads
    // every member of the group, not just the visible ones.
    const visibleSibling: StagedIntent = {
      id: `${groupId}-dep`,
      kind: 'task.setDependsOn',
      payload: { taskId: 't-hidden', dependsOn: [] },
      projectId: 'proj-1',
      createdAt: 0,
      sessionId: 'session-groom',
      groupId,
      groupKind: 'groom',
      milestone: 'M1',
      state: 'staged',
      sessionComplete: true,
      groupBlocked: true,
      groupBlockedMemberCount: 1,
    };
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([
      visibleSibling,
    ]);
    const approveGroup = vi.spyOn(stagedIntentsApi, 'approveGroup');

    render(<MilestoneDecisionInbox projectId="proj-1" milestone="M1" />);
    await waitFor(() => screen.getByTestId('milestone-decision-inbox'));

    // The blocked member stays off the surface entirely — the fix doesn't
    // re-filter its visible sibling out either.
    expect(
      screen.getByTestId(`milestone-decision-card-${groupId}`),
    ).toBeTruthy();

    const card = screen.getByTestId(`milestone-decision-card-${groupId}`);
    expect(within(card).getByTestId(`recovery-banner-${groupId}`)).toBeTruthy();
    // No visible blocked row to recover — Recover isn't offered.
    expect(within(card).queryByTestId(`recover-group-${groupId}`)).toBeNull();

    const approveButton = within(card).getByRole('button', {
      name: /approve groom/i,
    }) as HTMLButtonElement;
    expect(approveButton.disabled).toBe(true);
    fireEvent.click(approveButton);
    expect(approveGroup).not.toHaveBeenCalled();
  });

  it('disables Approve/Recover via the disabled prop when a group member session has not signaled turn-complete', async () => {
    const groupId = 'group-session-incomplete';
    const member: StagedIntent = {
      id: `${groupId}-status`,
      kind: 'task.setStatus',
      payload: { taskId: 't-incomplete', status: 'Ready' },
      projectId: 'proj-1',
      createdAt: 0,
      sessionId: 'session-groom',
      groupId,
      groupKind: 'groom',
      milestone: 'M1',
      state: 'staged',
      sessionComplete: true,
      groupBlocked: true,
      groupBlockedMemberCount: 0,
      groupSessionIncomplete: true,
    };
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([member]);

    render(<MilestoneDecisionInbox projectId="proj-1" milestone="M1" />);
    await waitFor(() => screen.getByTestId('milestone-decision-inbox'));

    const card = screen.getByTestId(`milestone-decision-card-${groupId}`);
    const approveButton = within(card).getByRole('button', {
      name: /approve groom/i,
    }) as HTMLButtonElement;
    expect(approveButton.disabled).toBe(true);
  });

  it('enables the group reject submit once a reason is typed, defaulting to pushback with no outcome chosen', async () => {
    const groupId = 'group-reject';
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([
      {
        id: `${groupId}-status`,
        kind: 'task.setStatus',
        payload: { taskId: 't-reject', status: 'Ready' },
        projectId: 'proj-1',
        createdAt: 0,
        groupId,
        groupKind: 'groom',
        milestone: 'M1',
        state: 'staged',
        sessionComplete: true,
      },
    ]);

    render(<MilestoneDecisionInbox projectId="proj-1" milestone="M1" />);
    await waitFor(() => screen.getByTestId('milestone-decision-inbox'));

    const card = screen.getByTestId(`milestone-decision-card-${groupId}`);
    fireEvent.change(
      within(card).getByPlaceholderText(/what should the session revise/i),
      {
        target: { value: 'No need' },
      },
    );

    expect(
      within(card)
        .getByRole('button', { name: /pushback groom/i })
        .hasAttribute('disabled'),
    ).toBe(false);
  });

  it('issues an explicit decline (never inferred) when Decline is chosen on the group reject toggle', async () => {
    const groupId = 'group-decline';
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([
      {
        id: `${groupId}-status`,
        kind: 'task.setStatus',
        payload: { taskId: 't-decline', status: 'Ready' },
        projectId: 'proj-1',
        createdAt: 0,
        groupId,
        groupKind: 'groom',
        milestone: 'M1',
        state: 'staged',
        sessionComplete: true,
      },
    ]);
    const rejectGroup = vi
      .spyOn(stagedIntentsApi, 'rejectGroup')
      .mockResolvedValue({ ok: true, rejected: [`${groupId}-status`] });

    render(<MilestoneDecisionInbox projectId="proj-1" milestone="M1" />);
    await waitFor(() => screen.getByTestId('milestone-decision-inbox'));

    const card = screen.getByTestId(`milestone-decision-card-${groupId}`);
    fireEvent.click(within(card).getByRole('radio', { name: /decline/i }));
    fireEvent.change(
      within(card).getByPlaceholderText(/why is this being declined/i),
      { target: { value: 'no longer needed' } },
    );
    fireEvent.click(
      within(card).getByRole('button', { name: /decline groom/i }),
    );

    await waitFor(() =>
      expect(rejectGroup).toHaveBeenCalledWith(groupId, {
        outcome: 'decline',
        reason: 'no longer needed',
      }),
    );
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
        sessionComplete: true,
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

  it("labels an ungrouped intent card with its target task's name and Type beside its case label", async () => {
    const intents: StagedIntent[] = [
      {
        id: 'ungrouped-1',
        kind: 'task.updateBody',
        payload: { taskId: 'notion:2', sections: {} },
        projectId: 'proj-1',
        createdAt: 0,
        sessionId: '0067bf6b-9ff8-4782-bd94-d1d9579b68d1',
        groupKind: 'other',
        milestone: 'M1',
        state: 'staged',
        sessionComplete: true,
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
    expect(screen.getByTestId('provenance-badge-ungrouped-1').textContent).toBe(
      'Other',
    );
  });

  it('narrows to intents whose target task is in the selected phase, while keeping a card with no resolvable task ref visible under every phase', async () => {
    const intents: StagedIntent[] = [
      {
        id: 'code-intent',
        kind: 'task.setStatus',
        payload: { taskId: 'notion:code', status: 'Ready' },
        projectId: 'proj-1',
        createdAt: 2,
        milestone: 'M1',
        state: 'staged',
        sessionComplete: true,
      },
      {
        id: 'design-intent',
        kind: 'task.setStatus',
        payload: { taskId: 'notion:design', status: 'Ready' },
        projectId: 'proj-1',
        createdAt: 1,
        milestone: 'M1',
        state: 'staged',
        sessionComplete: true,
      },
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
        sessionComplete: true,
      },
    ];
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue(intents);

    render(
      <MilestoneDecisionInbox
        projectId="proj-1"
        milestone="M1"
        phaseFilter="code"
        tasks={[
          makeTask({
            taskId: 'notion:code',
            taskName: 'A code task',
            taskType: '💻 Code',
            displayStatus: 'ready',
          }),
          makeTask({
            taskId: 'notion:design',
            taskName: 'A design task',
            taskType: '📐 Design',
            displayStatus: 'ready',
          }),
        ]}
      />,
    );
    await waitFor(() => screen.getByTestId('milestone-decision-inbox'));

    expect(
      screen.getByTestId('milestone-decision-card-code-intent'),
    ).toBeTruthy();
    expect(
      screen.queryByTestId('milestone-decision-card-design-intent'),
    ).toBeNull();
    expect(
      screen.getByTestId('milestone-decision-card-pickone-no-task'),
    ).toBeTruthy();
  });

  it('narrows to intents whose target task is blocked when flaggedOnly is set, the same way task rows narrow', async () => {
    const intents: StagedIntent[] = [
      {
        id: 'blocked-intent',
        kind: 'task.setStatus',
        payload: { taskId: 'notion:blocked', status: 'Ready' },
        projectId: 'proj-1',
        createdAt: 1,
        milestone: 'M1',
        state: 'staged',
        sessionComplete: true,
      },
      {
        id: 'open-intent',
        kind: 'task.setStatus',
        payload: { taskId: 'notion:open', status: 'Ready' },
        projectId: 'proj-1',
        createdAt: 0,
        milestone: 'M1',
        state: 'staged',
        sessionComplete: true,
      },
    ];
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue(intents);

    render(
      <MilestoneDecisionInbox
        projectId="proj-1"
        milestone="M1"
        phaseFilter="code"
        flaggedOnly
        tasks={[
          makeTask({
            taskId: 'notion:blocked',
            taskName: 'Blocked task',
            blocked: true,
          }),
          makeTask({
            taskId: 'notion:open',
            taskName: 'Open task',
            blocked: false,
          }),
        ]}
      />,
    );
    await waitFor(() => screen.getByTestId('milestone-decision-inbox'));

    expect(
      screen.getByTestId('milestone-decision-card-blocked-intent'),
    ).toBeTruthy();
    expect(
      screen.queryByTestId('milestone-decision-card-open-intent'),
    ).toBeNull();
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
        sessionComplete: true,
      },
    ];
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue(intents);

    render(
      <MilestoneDecisionInbox projectId="proj-1" milestone="M1" tasks={[]} />,
    );
    await waitFor(() => screen.getByTestId('milestone-decision-inbox'));

    const card = screen.getByTestId('milestone-decision-card-pickone-no-task');
    expect(card.textContent).toContain('Untitled decision');
    expect(card.textContent).toContain('decision.pickOne');
  });

  it('resolves a decision.pickOne card header to its originating session task name when the intent carries no payload.taskId', async () => {
    const intents: StagedIntent[] = [
      {
        id: 'pickone-session-task',
        kind: 'decision.pickOne',
        payload: {
          prompt: 'Which approach?',
          options: [{ label: 'A', description: 'Option A' }],
          allowFreeForm: false,
        },
        projectId: 'proj-1',
        createdAt: 0,
        sessionId: 'session-groom',
        milestone: 'M1',
        state: 'staged',
        sessionComplete: true,
      },
    ];
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue(intents);

    render(
      <MilestoneDecisionInbox
        projectId="proj-1"
        milestone="M1"
        tasks={[]}
        sessions={[
          { sessionId: 'session-groom', taskName: 'Fix the login flow' },
        ]}
      />,
    );
    await waitFor(() => screen.getByTestId('milestone-decision-inbox'));

    const card = screen.getByTestId(
      'milestone-decision-card-pickone-session-task',
    );
    expect(card.textContent).toContain('Fix the login flow');
    expect(card.textContent).toContain('decision.pickOne');
  });

  it('resolves gate.accrete and seed.stage card headers from payload.sourceTask.id', async () => {
    const intents: StagedIntent[] = [
      {
        id: 'gate-accrete-intent',
        kind: 'gate.accrete',
        payload: { sourceTask: { id: 'notion:accrete' }, items: [] },
        projectId: 'proj-1',
        createdAt: 1,
        milestone: 'M1',
        state: 'staged',
        sessionComplete: true,
      },
      {
        id: 'seed-stage-intent',
        kind: 'seed.stage',
        payload: { sourceTask: { id: 'notion:seed' }, seeds: [] },
        projectId: 'proj-1',
        createdAt: 0,
        milestone: 'M1',
        state: 'staged',
        sessionComplete: true,
      },
    ];
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue(intents);

    render(
      <MilestoneDecisionInbox
        projectId="proj-1"
        milestone="M1"
        tasks={[
          makeTask({ taskId: 'notion:accrete', taskName: 'Accrete target' }),
          makeTask({ taskId: 'notion:seed', taskName: 'Seed target' }),
        ]}
      />,
    );
    await waitFor(() => screen.getByTestId('milestone-decision-inbox'));

    const gateCard = screen.getByTestId(
      'milestone-decision-card-gate-accrete-intent',
    );
    expect(gateCard.textContent).toContain('Accrete target');
    expect(gateCard.textContent).toContain('gate.accrete');

    const seedCard = screen.getByTestId(
      'milestone-decision-card-seed-stage-intent',
    );
    expect(seedCard.textContent).toContain('Seed target');
    expect(seedCard.textContent).toContain('seed.stage');
  });

  it('resolves a gate.verify card header from its referenced gate item text, not the unresolved-label fallback', async () => {
    const intents: StagedIntent[] = [
      {
        id: 'gate-verify-intent',
        kind: 'gate.verify',
        payload: { gateItemId: 'gate-item-1' },
        projectId: 'proj-1',
        createdAt: 0,
        sessionId: null,
        milestone: 'M1',
        state: 'staged',
        sessionComplete: true,
      },
    ];
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue(intents);
    vi.spyOn(gateApi, 'getGateItemDetail').mockResolvedValue({
      item: {
        id: 'gate-item-1',
        project: 'proj-1',
        milestone: 'M1',
        text: 'Confirm the login redirect works in prod',
        classification: 'Human-Observation',
        state: 'runnable',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      sources: [],
      events: [],
    });

    render(
      <MilestoneDecisionInbox projectId="proj-1" milestone="M1" tasks={[]} />,
    );
    await waitFor(() => screen.getByTestId('milestone-decision-inbox'));

    const card = await screen.findByTestId(
      'milestone-decision-card-gate-verify-intent',
    );
    await waitFor(() =>
      expect(card.textContent).toContain(
        'Confirm the login redirect works in prod',
      ),
    );
    expect(card.textContent).not.toContain('Untitled decision');
  });

  it('signals onCardsRemoved with the dispositioned card id, so a caller (e.g. the decision stack) can re-select whatever is now topmost', async () => {
    const intents: StagedIntent[] = [
      {
        id: 'intent-1',
        kind: 'task.setStatus',
        payload: { taskId: 'notion:1', status: 'Ready' },
        projectId: 'proj-1',
        createdAt: 1,
        milestone: 'M1',
        state: 'staged',
        sessionComplete: true,
      },
    ];
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue(intents);
    vi.spyOn(stagedIntentsApi, 'apply').mockResolvedValue({
      ok: true,
      result: {},
    });

    const onCardsRemoved = vi.fn();
    render(
      <MilestoneDecisionInbox
        projectId="proj-1"
        milestone="M1"
        onCardsRemoved={onCardsRemoved}
      />,
    );

    const card = await screen.findByTestId('milestone-decision-card-intent-1');
    fireEvent.click(within(card).getByText('✓ Commit'));

    await waitFor(() =>
      expect(onCardsRemoved).toHaveBeenCalledWith(['intent-1']),
    );
  });

  describe('investigation report section', () => {
    it('lists reports by state, and lets the operator draft and commit one', async () => {
      vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([]);
      const draftReport = makeReport({
        id: 'report-draft',
        title: 'Draft report',
        state: 'draft',
      });
      const committedReport = makeReport({
        id: 'report-committed',
        title: 'Committed report',
        state: 'committed',
      });
      vi.spyOn(reportsApi, 'list').mockResolvedValue({
        items: [draftReport, committedReport],
        total: 2,
        page: 1,
      });

      render(<MilestoneDecisionInbox projectId="proj-1" milestone="M1" />);

      await waitFor(() =>
        expect(reportsApi.list).toHaveBeenCalledWith({
          project: 'proj-1',
          milestone: 'M1',
          limit: 100,
        }),
      );

      expect(
        await screen.findByTestId('report-card-report-draft'),
      ).toBeTruthy();
      expect(screen.getByTestId('report-card-report-committed')).toBeTruthy();
      expect(screen.getByTestId('report-filter-draft').textContent).toContain(
        '(1)',
      );
      expect(
        screen.getByTestId('report-filter-committed').textContent,
      ).toContain('(1)');

      // Filtering by state narrows the visible cards.
      fireEvent.click(screen.getByTestId('report-filter-draft'));
      expect(screen.getByTestId('report-card-report-draft')).toBeTruthy();
      expect(screen.queryByTestId('report-card-report-committed')).toBeNull();
      fireEvent.click(screen.getByTestId('report-filter-all'));

      // File a new report: title + symptom, single action creates and commits it.
      const created = makeReport({
        id: 'report-new',
        title: 'New symptom',
        state: 'draft',
      });
      const createdCommitted = { ...created, state: 'committed' as const };
      const draftCommitted = { ...draftReport, state: 'committed' as const };
      vi.spyOn(reportsApi, 'create').mockResolvedValue(created);
      const commitSpy = vi
        .spyOn(reportsApi, 'commit')
        .mockImplementation((id: string) =>
          Promise.resolve(
            id === 'report-new' ? createdCommitted : draftCommitted,
          ),
        );
      fireEvent.click(screen.getByTestId('report-start-draft'));
      fireEvent.change(screen.getByTestId('report-draft-title'), {
        target: { value: 'New symptom' },
      });
      fireEvent.change(screen.getByTestId('report-draft-symptom'), {
        target: { value: 'It broke in prod' },
      });
      fireEvent.click(screen.getByTestId('report-draft-submit'));

      await waitFor(() =>
        expect(reportsApi.create).toHaveBeenCalledWith({
          projectId: 'proj-1',
          milestoneId: 'M1',
          title: 'New symptom',
          symptomText: 'It broke in prod',
          source: 'operator',
        }),
      );
      await waitFor(() => expect(commitSpy).toHaveBeenCalledWith('report-new'));
      expect(await screen.findByTestId('report-card-report-new')).toBeTruthy();
      expect(screen.getByTestId('report-state-report-new').textContent).toBe(
        'Committed',
      );

      // Commit the pre-existing draft report.
      fireEvent.click(screen.getByTestId('report-commit-report-draft'));

      await waitFor(() =>
        expect(commitSpy).toHaveBeenCalledWith('report-draft'),
      );
      await waitFor(() =>
        expect(
          screen.getByTestId('report-state-report-draft').textContent,
        ).toBe('Committed'),
      );
    });

    it('marks a committed, unresolved report as convergence-blocking, but not a draft or a resolved one', async () => {
      vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([]);
      vi.spyOn(reportsApi, 'list').mockResolvedValue({
        items: [
          makeReport({ id: 'r-draft', state: 'draft' }),
          makeReport({ id: 'r-committed', state: 'committed' }),
          makeReport({ id: 'r-resolved', state: 'resolved' }),
        ],
        total: 3,
        page: 1,
      });

      render(<MilestoneDecisionInbox projectId="proj-1" milestone="M1" />);

      await screen.findByTestId('report-card-r-committed');
      expect(screen.getByTestId('report-blocking-r-committed')).toBeTruthy();
      expect(screen.queryByTestId('report-blocking-r-draft')).toBeNull();
      expect(screen.queryByTestId('report-blocking-r-resolved')).toBeNull();
    });

    it('is unaffected by the inbox’s known gate.verify mis-titling defect — a report’s title always comes from its own title field, never resolved through the gate-item-text lookup', async () => {
      vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([]);
      const getGateItemDetail = vi.spyOn(gateApi, 'getGateItemDetail');
      vi.spyOn(reportsApi, 'list').mockResolvedValue({
        items: [
          makeReport({
            id: 'r-titled',
            title: 'Checkout drops the discount code',
            state: 'committed',
          }),
        ],
        total: 1,
        page: 1,
      });

      render(<MilestoneDecisionInbox projectId="proj-1" milestone="M1" />);

      const card = await screen.findByTestId('report-card-r-titled');
      expect(card.textContent).toContain('Checkout drops the discount code');
      expect(card.textContent).not.toContain('Untitled decision');
      // No gate-item lookup is ever issued for a report card — that fetch
      // path (and its known mis-titling defect) is exclusive to gate.verify
      // staged-intent cards.
      expect(getGateItemDetail).not.toHaveBeenCalled();
    });

    it('is unaffected by the inbox’s staged-intent staleness handling — reports fetch and refresh through their own independent effect, not useDecisionQueue', async () => {
      vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([]);
      const listReports = vi.spyOn(reportsApi, 'list').mockResolvedValue({
        items: [makeReport({ id: 'r-1', state: 'committed', inFlight: true })],
        total: 1,
        page: 1,
      });

      render(<MilestoneDecisionInbox projectId="proj-1" milestone="M1" />);

      await screen.findByTestId('report-card-r-1');
      expect(screen.getByTestId('report-inflight-r-1')).toBeTruthy();
      // The report section's own fetch is scoped to /api/reports and never
      // touches stagedIntentsApi.listByMilestone's result at all.
      expect(listReports).toHaveBeenCalledTimes(1);
      expect(stagedIntentsApi.listByMilestone).toHaveBeenCalledTimes(1);
    });

    it('lets the operator batch-select dispatch-eligible (committed, not in-flight) reports', async () => {
      vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([]);
      vi.spyOn(reportsApi, 'list').mockResolvedValue({
        items: [
          makeReport({ id: 'r-eligible', state: 'committed', inFlight: false }),
          makeReport({ id: 'r-inflight', state: 'committed', inFlight: true }),
          makeReport({ id: 'r-draft', state: 'draft' }),
        ],
        total: 3,
        page: 1,
      });

      render(<MilestoneDecisionInbox projectId="proj-1" milestone="M1" />);

      await screen.findByTestId('report-card-r-eligible');
      expect(screen.getByTestId('report-select-r-eligible')).toBeTruthy();
      expect(screen.queryByTestId('report-select-r-inflight')).toBeNull();
      expect(screen.queryByTestId('report-select-r-draft')).toBeNull();

      fireEvent.click(screen.getByTestId('report-select-r-eligible'));
      expect(screen.getByTestId('report-batch-bar').textContent).toContain(
        '1 selected',
      );

      fireEvent.click(screen.getByTestId('report-batch-clear'));
      expect(screen.queryByTestId('report-batch-bar')).toBeNull();
    });

    it("clicking 'Investigate Selected' calls the launch route with exactly the selected reportIds", async () => {
      vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([]);
      vi.spyOn(reportsApi, 'list').mockResolvedValue({
        items: [
          makeReport({ id: 'r-1', state: 'committed', inFlight: false }),
          makeReport({ id: 'r-2', state: 'committed', inFlight: false }),
          makeReport({ id: 'r-3', state: 'committed', inFlight: false }),
        ],
        total: 3,
        page: 1,
      });
      const launch = vi
        .spyOn(investigateApi, 'launch')
        .mockResolvedValue({ sessionId: 'session-inv-1', reportIds: [] });

      render(<MilestoneDecisionInbox projectId="proj-1" milestone="M1" />);

      await screen.findByTestId('report-card-r-1');
      fireEvent.click(screen.getByTestId('report-select-r-1'));
      fireEvent.click(screen.getByTestId('report-select-r-3'));

      fireEvent.click(screen.getByTestId('report-batch-dispatch'));

      await waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
      expect(launch).toHaveBeenCalledWith(['r-1', 'r-3']);
    });
  });
});
