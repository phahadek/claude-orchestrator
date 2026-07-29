import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { FlowArmToggle } from '../FlowArmToggle';
import { flowArmApi, type FlowArmState } from '../../api/flowArm';
import { FLOW_IDS } from '@claude-orchestrator/backend/src/orchestration/flowArm';

afterEach(() => {
  vi.restoreAllMocks();
});

function makeState(overrides: Partial<FlowArmState> = {}): FlowArmState {
  return {
    groom: { armed: true, source: 'default' },
    'gate-verify': { armed: true, source: 'default' },
    design: { armed: false, source: 'default' },
    ops: { armed: false, source: 'default' },
    ...overrides,
  };
}

describe('FlowArmToggle', () => {
  it('renders exactly one row per FLOW_IDS entry', async () => {
    vi.spyOn(flowArmApi, 'get').mockResolvedValue(makeState());

    render(<FlowArmToggle milestoneId="m1" autoLaunchEnabled />);

    await waitFor(() => {
      for (const flow of FLOW_IDS) {
        expect(screen.getByTestId(`flow-arm-row-${flow}`)).toBeTruthy();
      }
    });
    expect(screen.getAllByTestId(/^flow-arm-row-/)).toHaveLength(
      FLOW_IDS.length,
    );
  });

  it('matches DEFAULT_ARM when no flow_arm rows exist for the milestone', async () => {
    vi.spyOn(flowArmApi, 'get').mockResolvedValue(makeState());

    render(<FlowArmToggle milestoneId="m1" />);

    await waitFor(() => {
      expect(
        screen
          .getByTestId('flow-arm-switch-groom')
          .getAttribute('aria-checked'),
      ).toBe('true');
    });
    expect(
      screen
        .getByTestId('flow-arm-switch-gate-verify')
        .getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      screen.getByTestId('flow-arm-switch-design').getAttribute('aria-checked'),
    ).toBe('false');
    expect(
      screen.getByTestId('flow-arm-switch-ops').getAttribute('aria-checked'),
    ).toBe('false');
  });

  it('displays the project autoLaunchEnabled state alongside arm state', async () => {
    vi.spyOn(flowArmApi, 'get').mockResolvedValue(makeState());

    render(<FlowArmToggle milestoneId="m1" autoLaunchEnabled={false} />);

    expect(screen.getByTestId('flow-arm-auto-launch').textContent).toContain(
      'off',
    );

    await waitFor(() =>
      expect(
        screen
          .getByTestId('flow-arm-switch-groom')
          .getAttribute('aria-checked'),
      ).toBe('true'),
    );
  });

  it('toggling a flow issues the PUT route and renders the returned state', async () => {
    vi.spyOn(flowArmApi, 'get').mockResolvedValue(makeState());
    const setSpy = vi
      .spyOn(flowArmApi, 'set')
      .mockResolvedValue({ milestoneId: 'm1', flow: 'design', armed: true });

    render(<FlowArmToggle milestoneId="m1" />);

    await waitFor(() =>
      expect(
        screen
          .getByTestId('flow-arm-switch-design')
          .getAttribute('aria-checked'),
      ).toBe('false'),
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId('flow-arm-switch-design'));
    });

    expect(setSpy).toHaveBeenCalledWith('m1', 'design', true);

    await waitFor(() =>
      expect(
        screen
          .getByTestId('flow-arm-switch-design')
          .getAttribute('aria-checked'),
      ).toBe('true'),
    );
  });

  it('surfaces a 400 error from the arm route instead of swallowing it', async () => {
    vi.spyOn(flowArmApi, 'get').mockResolvedValue(makeState());
    vi.spyOn(flowArmApi, 'set').mockRejectedValue(
      new Error('armed must be a boolean'),
    );

    render(<FlowArmToggle milestoneId="m1" />);

    await waitFor(() =>
      expect(
        screen
          .getByTestId('flow-arm-switch-design')
          .getAttribute('aria-checked'),
      ).toBe('false'),
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId('flow-arm-switch-design'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('flow-arm-error').textContent).toContain(
        'armed must be a boolean',
      );
    });
    // The toggle stays at its prior state — no optimistic guess left unreconciled.
    expect(
      screen.getByTestId('flow-arm-switch-design').getAttribute('aria-checked'),
    ).toBe('false');
  });
});
