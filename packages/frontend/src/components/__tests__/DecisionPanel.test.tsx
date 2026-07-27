import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { DecisionPanel } from '../DecisionPanel';
import { stagedIntentsApi } from '../../api/stagedIntents';
import type { StagedIntent } from '../../api/stagedIntents';

vi.mock('../../hooks/stagedIntentBus', () => ({
  subscribeStagedIntentChange: () => () => {},
}));

function mockMobileViewport() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('max-width'),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

describe('DecisionPanel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders a parked ops session's staged journal.setState decision", async () => {
    const opsDecision: StagedIntent = {
      id: 'intent-1',
      kind: 'journal.setState',
      payload: {
        taskId: 'notion:abc',
        state: 'staged-proposal',
        fields: {
          findingOrProposal: { summary: 'Stand up off-box backups' },
        },
      },
      projectId: 'proj-1',
      createdAt: 0,
      sessionId: 'ops-session-1',
      state: 'staged',
      decisionProposal: 'Stand up off-box backups',
    };
    vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue([
      opsDecision,
    ]);

    render(<DecisionPanel sessionId="ops-session-1" />);

    await waitFor(() => {
      expect(screen.getByTestId('decision-panel')).toBeTruthy();
    });
    expect(screen.getByText('journal.setState')).toBeTruthy();
    expect(screen.getByText('Stand up off-box backups')).toBeTruthy();
  });

  it('renders nothing when the session has no staged decision', async () => {
    vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue([]);

    const { container } = render(<DecisionPanel sessionId="ops-session-2" />);

    await waitFor(() => {
      expect(stagedIntentsApi.listBySession).toHaveBeenCalledWith(
        'ops-session-2',
      );
    });
    expect(container.firstChild).toBeNull();
  });

  function groomGroupIntents(groupId: string, taskId: string): StagedIntent[] {
    return [
      {
        id: `${groupId}-dep`,
        kind: 'task.setDependsOn',
        payload: { taskId, dependsOn: [] },
        projectId: 'proj-1',
        createdAt: 0,
        sessionId: 'groom-session-1',
        groupId,
        state: 'staged',
      },
      {
        id: `${groupId}-status`,
        kind: 'task.setStatus',
        payload: { taskId, status: 'Ready' },
        projectId: 'proj-1',
        createdAt: 1,
        sessionId: 'groom-session-1',
        groupId,
        state: 'staged',
      },
    ];
  }

  it('renders one group-level approval unit — a single Approve action, no per-item approve/reject controls', async () => {
    vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue(
      groomGroupIntents('group-1', 't-1'),
    );

    render(<DecisionPanel sessionId="groom-session-1" />);

    await waitFor(() => {
      expect(screen.getByTestId('decision-panel')).toBeTruthy();
    });

    expect(
      screen.getAllByRole('button', { name: /approve groom/i }),
    ).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /^approve$/i })).toBeNull();
  });

  it('approving the group commits every member in one atomic operator action', async () => {
    vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue(
      groomGroupIntents('group-2', 't-2'),
    );
    const approveGroup = vi
      .spyOn(stagedIntentsApi, 'approveGroup')
      .mockResolvedValue({
        ok: true,
        committed: ['group-2-dep', 'group-2-status'],
      });

    render(<DecisionPanel sessionId="groom-session-1" />);
    await waitFor(() => screen.getByTestId('decision-panel'));

    fireEvent.click(screen.getByRole('button', { name: /approve groom/i }));

    await waitFor(() => expect(approveGroup).toHaveBeenCalledWith('group-2'));
  });

  it('declining the group rejects it as one unit via the group-level reject route', async () => {
    vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue(
      groomGroupIntents('group-3', 't-3'),
    );
    const rejectGroup = vi
      .spyOn(stagedIntentsApi, 'rejectGroup')
      .mockResolvedValue({
        ok: true,
        rejected: ['group-3-dep', 'group-3-status'],
      });

    render(<DecisionPanel sessionId="groom-session-1" />);
    await waitFor(() => screen.getByTestId('decision-panel'));

    fireEvent.click(screen.getByRole('radio', { name: /decline/i }));
    fireEvent.change(
      screen.getByPlaceholderText(/why is this being declined/i),
      {
        target: { value: 'out of scope' },
      },
    );
    fireEvent.click(screen.getByRole('button', { name: /decline groom/i }));

    await waitFor(() =>
      expect(rejectGroup).toHaveBeenCalledWith('group-3', {
        outcome: 'decline',
        reason: 'out of scope',
      }),
    );
  });

  it('exposes a reachable dismiss control at mobile viewport widths, which collapses the panel to a reopenable badge', async () => {
    mockMobileViewport();
    vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue(
      groomGroupIntents('group-4', 't-4'),
    );

    render(<DecisionPanel sessionId="groom-session-1" />);
    await waitFor(() => screen.getByTestId('decision-panel'));

    const dismissButton = screen.getByRole('button', {
      name: /dismiss proposals panel/i,
    });
    expect(dismissButton).toBeTruthy();

    fireEvent.click(dismissButton);

    const panel = screen.getByTestId('decision-panel');
    expect(panel.getAttribute('data-collapsed')).toBe('true');

    // Collapsing must not tear down the underlying decision — it stays
    // reachable via a reopen control, not lost.
    const reopenButton = screen.getByRole('button', {
      name: /show 2 pending proposals/i,
    });
    fireEvent.click(reopenButton);

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /dismiss proposals panel/i }),
      ).toBeTruthy(),
    );
  });

  function cleanTriageGroupIntents(
    groupId: string,
    taskId: string,
  ): StagedIntent[] {
    return [
      {
        id: `${groupId}-dep`,
        kind: 'task.setDependsOn',
        payload: { taskId, dependsOn: [] },
        projectId: 'proj-1',
        createdAt: 0,
        sessionId: 'groom-session-2',
        groupId,
        state: 'staged',
      },
      {
        id: `${groupId}-status`,
        kind: 'task.setStatus',
        payload: {
          taskId,
          status: 'Ready',
          groomingGate: {
            triage: {
              proposedVerdict: 'clean',
              hasOpenQuestionsHeading: false,
            },
          },
        },
        projectId: 'proj-1',
        createdAt: 1,
        sessionId: 'groom-session-2',
        groupId,
        state: 'staged',
        groomProposal: {
          achieves: `Stand up ${taskId} cleanly`,
          openQuestions: 'None',
          automatedTests: 'Covered by existing suite',
          manualVerification: 'Not required',
          operationalSeed: 'None',
        },
      },
    ];
  }

  describe('clean-triaged groups', () => {
    it('renders a clean group through the same element as a non-clean group, carrying a visible clean indicator', async () => {
      vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue(
        cleanTriageGroupIntents('group-clean-1', 't-clean-1'),
      );

      render(<DecisionPanel sessionId="groom-session-2" />);
      await waitFor(() => screen.getByTestId('decision-panel'));

      expect(screen.getByText('Group group-clean-1')).toBeTruthy();
      expect(screen.getByTestId('clean-badge-group-clean-1')).toBeTruthy();
      expect(
        screen.getAllByRole('button', { name: /approve groom/i }),
      ).toHaveLength(1);
    });

    it('exposes pushback, decline, and reason drafting on a clean group', async () => {
      vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue(
        cleanTriageGroupIntents('group-clean-2', 't-clean-2'),
      );

      render(<DecisionPanel sessionId="groom-session-2" />);
      await waitFor(() => screen.getByTestId('decision-panel'));

      expect(screen.getByRole('radio', { name: /pushback/i })).toBeTruthy();
      expect(screen.getByRole('radio', { name: /decline/i })).toBeTruthy();
      expect(
        screen.getByPlaceholderText(/what should the session revise/i),
      ).toBeTruthy();
    });

    it("exposes a clean group's per-intent detail without a bespoke expand container", async () => {
      vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue(
        cleanTriageGroupIntents('group-clean-3', 't-clean-3'),
      );

      render(<DecisionPanel sessionId="groom-session-2" />);
      await waitFor(() => screen.getByTestId('decision-panel'));

      expect(screen.getByText(/depends on for/i)).toBeTruthy();
      expect(screen.queryByTestId('triage-expand-group-clean-3')).toBeNull();
    });

    it('lets a clean group whose commit is refused server-side still be pushed back or declined', async () => {
      vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue(
        cleanTriageGroupIntents('group-clean-4', 't-clean-4'),
      );
      vi.spyOn(stagedIntentsApi, 'approveGroup').mockRejectedValue(
        new Error('readiness gate violation'),
      );
      const rejectGroup = vi
        .spyOn(stagedIntentsApi, 'rejectGroup')
        .mockResolvedValue({ ok: true, rejected: ['group-clean-4-status'] });

      render(<DecisionPanel sessionId="groom-session-2" />);
      await waitFor(() => screen.getByTestId('decision-panel'));

      fireEvent.click(screen.getByRole('button', { name: /approve groom/i }));
      await waitFor(() =>
        expect(screen.getByText('readiness gate violation')).toBeTruthy(),
      );

      fireEvent.click(screen.getByRole('radio', { name: /decline/i }));
      fireEvent.change(
        screen.getByPlaceholderText(/why is this being declined/i),
        { target: { value: 'gate refused it' } },
      );
      fireEvent.click(screen.getByRole('button', { name: /decline groom/i }));

      await waitFor(() =>
        expect(rejectGroup).toHaveBeenCalledWith('group-clean-4', {
          outcome: 'decline',
          reason: 'gate refused it',
        }),
      );
    });

    it('approves only the included flagged groups via the batch action, leaving an excluded group individually dispositionable', async () => {
      vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue([
        ...cleanTriageGroupIntents('group-clean-5', 't-clean-5'),
        ...cleanTriageGroupIntents('group-clean-6', 't-clean-6'),
      ]);
      const commitBatch = vi
        .spyOn(stagedIntentsApi, 'commitBatch')
        .mockResolvedValue({
          ok: true,
          committed: ['group-clean-6'],
          exceptions: [],
        });

      render(<DecisionPanel sessionId="groom-session-2" />);
      await waitFor(() => screen.getByTestId('decision-panel'));

      fireEvent.click(screen.getByTestId('clean-batch-include-group-clean-5'));
      fireEvent.click(screen.getByTestId('approve-all-clean'));

      await waitFor(() =>
        expect(commitBatch).toHaveBeenCalledWith(['group-clean-6'], undefined),
      );

      // the excluded group is still fully dispositionable in place
      expect(screen.getByText('Group group-clean-5')).toBeTruthy();
      expect(
        screen.getAllByRole('button', { name: /approve groom/i }),
      ).toHaveLength(1);
    });

    it('renders full disposition controls for a panel containing only clean groups', async () => {
      vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue(
        cleanTriageGroupIntents('group-clean-7', 't-clean-7'),
      );

      render(<DecisionPanel sessionId="groom-session-2" />);
      await waitFor(() => screen.getByTestId('decision-panel'));

      expect(
        screen.getByRole('button', { name: /approve groom/i }),
      ).toBeTruthy();
      expect(screen.getByRole('radio', { name: /pushback/i })).toBeTruthy();
      expect(screen.getByRole('radio', { name: /decline/i })).toBeTruthy();
    });

    it('still renders non-clean groups through the standard StagedIntentPanel path with hideActions, unaffected by clean groups', async () => {
      vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue([
        ...cleanTriageGroupIntents('group-clean-9', 't-clean-9'),
        ...groomGroupIntents('group-blocked-1', 't-blocked-1'),
      ]);

      render(<DecisionPanel sessionId="groom-session-2" />);
      await waitFor(() => screen.getByTestId('decision-panel'));

      expect(screen.getByText('Group group-blocked-1')).toBeTruthy();
      expect(
        screen.getAllByRole('button', { name: /approve groom/i }),
      ).toHaveLength(2);
    });
  });
});
