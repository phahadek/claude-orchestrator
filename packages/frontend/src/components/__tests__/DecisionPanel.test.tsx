import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { DecisionPanel } from '../DecisionPanel';
import { stagedIntentsApi } from '../../api/stagedIntents';
import type { StagedIntent } from '../../api/stagedIntents';

vi.mock('../../hooks/stagedIntentBus', () => ({
  subscribeStagedIntentChange: () => () => {},
}));

describe('DecisionPanel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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

    expect(screen.getAllByRole('button', { name: /approve groom/i })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /^approve$/i })).toBeNull();
  });

  it('approving the group commits every member in one atomic operator action', async () => {
    vi.spyOn(stagedIntentsApi, 'listBySession').mockResolvedValue(
      groomGroupIntents('group-2', 't-2'),
    );
    const approveGroup = vi
      .spyOn(stagedIntentsApi, 'approveGroup')
      .mockResolvedValue({ ok: true, committed: ['group-2-dep', 'group-2-status'] });

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
      .mockResolvedValue({ ok: true, rejected: ['group-3-dep', 'group-3-status'] });

    render(<DecisionPanel sessionId="groom-session-1" />);
    await waitFor(() => screen.getByTestId('decision-panel'));

    fireEvent.click(screen.getByRole('radio', { name: /decline/i }));
    fireEvent.change(screen.getByPlaceholderText(/why is this being declined/i), {
      target: { value: 'out of scope' },
    });
    fireEvent.click(screen.getByRole('button', { name: /decline groom/i }));

    await waitFor(() =>
      expect(rejectGroup).toHaveBeenCalledWith('group-3', {
        outcome: 'decline',
        reason: 'out of scope',
      }),
    );
  });
});
