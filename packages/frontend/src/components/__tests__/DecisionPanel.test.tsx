import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react';
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
            triage: { proposedVerdict: 'clean', hasOpenQuestionsHeading: false },
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
    it("exposes a clean group's individual intents once its row is expanded", async () => {
      vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue(
        cleanTriageGroupIntents('group-clean-1', 't-clean-1'),
      );

      render(<DecisionPanel sessionId="groom-session-2" />);
      await waitFor(() => screen.getByTestId('decision-panel'));

      expect(screen.queryByText(/depends on for/i)).toBeNull();

      fireEvent.click(screen.getByTestId('triage-expand-group-clean-1'));

      expect(screen.getByText(/depends on for/i)).toBeTruthy();
      expect(
        within(
          screen.getByTestId('triage-detail-group-clean-1'),
        ).getAllByText('t-clean-1').length,
      ).toBeGreaterThan(0);
    });

    it('exposes the groomProposal text of a clean row once expanded', async () => {
      vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue(
        cleanTriageGroupIntents('group-clean-2', 't-clean-2'),
      );

      render(<DecisionPanel sessionId="groom-session-2" />);
      await waitFor(() => screen.getByTestId('decision-panel'));

      expect(screen.queryByText('Stand up t-clean-2 cleanly')).toBeNull();

      fireEvent.click(screen.getByTestId('triage-expand-group-clean-2'));

      expect(screen.getByText('Stand up t-clean-2 cleanly')).toBeTruthy();
    });

    it('renders a detail path for a panel containing only clean groups — the case that produced the empty surface', async () => {
      vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue(
        cleanTriageGroupIntents('group-clean-3', 't-clean-3'),
      );

      render(<DecisionPanel sessionId="groom-session-2" />);
      await waitFor(() => screen.getByTestId('decision-panel'));

      expect(screen.getByTestId('triage-batch-panel')).toBeTruthy();
      expect(
        screen.getByTestId('triage-expand-group-clean-3'),
      ).toBeTruthy();

      fireEvent.click(screen.getByTestId('triage-expand-group-clean-3'));

      expect(
        screen.getByTestId('triage-detail-group-clean-3'),
      ).toBeTruthy();
      expect(screen.getByText(/depends on for/i)).toBeTruthy();
    });

    it('reconciles the heading count with the rendered content for a panel of only clean groups', async () => {
      vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue(
        cleanTriageGroupIntents('group-clean-4', 't-clean-4'),
      );

      render(<DecisionPanel sessionId="groom-session-2" />);
      await waitFor(() => screen.getByTestId('decision-panel'));

      expect(screen.getByText(/2 intents across 1 group\)/i)).toBeTruthy();

      fireEvent.click(screen.getByTestId('triage-expand-group-clean-4'));

      const detail = screen.getByTestId('triage-detail-group-clean-4');
      expect(within(detail).getByText('task.setDependsOn')).toBeTruthy();
      expect(within(detail).getByText('task.setStatus')).toBeTruthy();
    });

    it('commits every non-vetoed clean group in one call whether its row is expanded or collapsed', async () => {
      vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue([
        ...cleanTriageGroupIntents('group-clean-5', 't-clean-5'),
        ...cleanTriageGroupIntents('group-clean-6', 't-clean-6'),
      ]);
      const commitBatch = vi
        .spyOn(stagedIntentsApi, 'commitBatch')
        .mockResolvedValue({
          ok: true,
          committed: ['group-clean-5', 'group-clean-6'],
          exceptions: [],
        });

      render(<DecisionPanel sessionId="groom-session-2" />);
      await waitFor(() => screen.getByTestId('decision-panel'));

      fireEvent.click(screen.getByTestId('triage-expand-group-clean-5'));

      fireEvent.click(screen.getByTestId('triage-batch-commit'));

      await waitFor(() =>
        expect(commitBatch).toHaveBeenCalledWith(
          ['group-clean-5', 'group-clean-6'],
          undefined,
        ),
      );
    });

    it('excludes an unchecked row from the commit whether expanded or collapsed', async () => {
      vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue([
        ...cleanTriageGroupIntents('group-clean-7', 't-clean-7'),
        ...cleanTriageGroupIntents('group-clean-8', 't-clean-8'),
      ]);
      const commitBatch = vi
        .spyOn(stagedIntentsApi, 'commitBatch')
        .mockResolvedValue({
          ok: true,
          committed: ['group-clean-8'],
          exceptions: [],
        });

      render(<DecisionPanel sessionId="groom-session-2" />);
      await waitFor(() => screen.getByTestId('decision-panel'));

      fireEvent.click(screen.getByTestId('triage-expand-group-clean-7'));
      fireEvent.click(screen.getByTestId('triage-veto-group-clean-7'));

      fireEvent.click(screen.getByTestId('triage-batch-commit'));

      await waitFor(() =>
        expect(commitBatch).toHaveBeenCalledWith(['group-clean-8'], undefined),
      );
    });

    it('still renders non-clean groups through the standard StagedIntentPanel path with hideActions, unaffected by clean-group expansion', async () => {
      vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue([
        ...cleanTriageGroupIntents('group-clean-9', 't-clean-9'),
        ...groomGroupIntents('group-blocked-1', 't-blocked-1'),
      ]);

      render(<DecisionPanel sessionId="groom-session-2" />);
      await waitFor(() => screen.getByTestId('decision-panel'));

      expect(screen.getByText('Group group-blocked-1')).toBeTruthy();
      expect(
        screen.getAllByRole('button', { name: /approve groom/i }),
      ).toHaveLength(1);
    });
  });
});
