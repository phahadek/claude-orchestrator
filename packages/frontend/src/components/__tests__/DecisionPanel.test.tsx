import { render, screen, waitFor } from '@testing-library/react';
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
});
