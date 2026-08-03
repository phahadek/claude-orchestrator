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
import type { FlowRejectionRateResult } from '../../api/gate';

const getFlowRejectionRateMock = vi.hoisted(() => vi.fn());
vi.mock('../../api/gate', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/gate')>('../../api/gate');
  return {
    ...actual,
    gateApi: {
      ...actual.gateApi,
      getFlowRejectionRate: getFlowRejectionRateMock,
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  getFlowRejectionRateMock.mockReset();
});

function makeState(overrides: Partial<FlowArmState> = {}): FlowArmState {
  return {
    groom: { armed: false, source: 'default' },
    'gate-verify': { armed: false, source: 'default' },
    design: { armed: false, source: 'default' },
    ops: { armed: false, source: 'default' },
    docs: { armed: false, source: 'default' },
    ...overrides,
  };
}

function parseRgb(color: string): { r: number; g: number; b: number } {
  const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) throw new Error(`unparseable color: ${color}`);
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
}

/** Spread between the loudest and quietest channel — a rough saturation proxy for an achromatic-vs-tinted comparison in jsdom, which normalizes inline hsl() styles to rgb(). */
function channelSpread({
  r,
  g,
  b,
}: {
  r: number;
  g: number;
  b: number;
}): number {
  return Math.max(r, g, b) - Math.min(r, g, b);
}

function makeTrustRate(
  overrides: Partial<FlowRejectionRateResult> = {},
): FlowRejectionRateResult {
  return {
    flow: 'groom',
    project: 'proj',
    milestone: 'm1',
    total: 10,
    rejected: 1,
    rate: 0.1,
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
      ).toBe('false');
    });
    for (const flow of FLOW_IDS) {
      expect(
        screen
          .getByTestId(`flow-arm-switch-${flow}`)
          .getAttribute('aria-checked'),
      ).toBe('false');
    }
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
      ).toBe('false'),
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

  it('passes the milestoneId through unconverted to the trust-rate read', async () => {
    vi.spyOn(flowArmApi, 'get').mockResolvedValue(makeState());
    getFlowRejectionRateMock.mockResolvedValue(makeTrustRate());

    render(
      <FlowArmToggle
        milestoneId="a3f9c1d2-uuid-not-short-id"
        projectId="proj"
      />,
    );

    await waitFor(() => {
      expect(getFlowRejectionRateMock).toHaveBeenCalledWith(
        'proj',
        'a3f9c1d2-uuid-not-short-id',
        'groom',
      );
    });
  });

  it('tints an arm button on a ramp where a low rejection rate renders green and a high rate renders red', async () => {
    vi.spyOn(flowArmApi, 'get').mockResolvedValue(makeState());
    getFlowRejectionRateMock.mockImplementation(
      (_project: string, _milestone: string, flow: string) =>
        Promise.resolve(
          flow === 'groom'
            ? makeTrustRate({
                flow: 'groom',
                total: 100,
                rejected: 1,
                rate: 0.01,
              })
            : makeTrustRate({
                flow: flow as never,
                total: 100,
                rejected: 95,
                rate: 0.95,
              }),
        ),
    );

    render(<FlowArmToggle milestoneId="m1" projectId="proj" />);

    await waitFor(() => {
      expect(screen.getByTestId('flow-arm-rate-groom').textContent).toContain(
        '1%',
      );
    });

    const lowRateButton = screen.getByTestId('flow-arm-switch-groom');
    const highRateButton = screen.getByTestId('flow-arm-switch-design');

    const lowRgb = parseRgb(lowRateButton.style.backgroundColor);
    const highRgb = parseRgb(highRateButton.style.backgroundColor);

    // Low rate (good) leans green; high rate (bad) leans red.
    expect(lowRgb.g).toBeGreaterThan(lowRgb.r);
    expect(highRgb.r).toBeGreaterThan(highRgb.g);
  });

  it('renders the same rate desaturated/grey when disarmed and bright when armed', async () => {
    vi.spyOn(flowArmApi, 'get').mockResolvedValue(
      makeState({
        groom: { armed: false, source: 'default' },
        design: { armed: true, source: 'row' },
      }),
    );
    getFlowRejectionRateMock.mockImplementation(
      (_project: string, _milestone: string, flow: string) =>
        Promise.resolve(makeTrustRate({ flow: flow as never, rate: 0.5 })),
    );

    render(<FlowArmToggle milestoneId="m1" projectId="proj" />);

    await waitFor(() => {
      expect(
        screen
          .getByTestId('flow-arm-switch-groom')
          .getAttribute('aria-checked'),
      ).toBe('false');
    });

    const disarmed = screen.getByTestId('flow-arm-switch-groom');
    const armed = screen.getByTestId('flow-arm-switch-design');

    const disarmedSpread = channelSpread(
      parseRgb(disarmed.style.backgroundColor),
    );
    const armedSpread = channelSpread(parseRgb(armed.style.backgroundColor));

    expect(armedSpread).toBeGreaterThan(disarmedSpread);
  });

  it('renders a defined no-metric appearance for docs and issues no trust-rate request for it', async () => {
    vi.spyOn(flowArmApi, 'get').mockResolvedValue(makeState());
    getFlowRejectionRateMock.mockResolvedValue(makeTrustRate());

    render(<FlowArmToggle milestoneId="m1" projectId="proj" />);

    await waitFor(() => {
      expect(getFlowRejectionRateMock).toHaveBeenCalled();
    });

    expect(screen.queryByTestId('flow-arm-rate-docs')).toBeNull();
    for (const call of getFlowRejectionRateMock.mock.calls) {
      expect(call[2]).not.toBe('docs');
    }
  });

  it('renders a neutral no-data appearance for a null rate, distinct from a good score and the disarmed tint', async () => {
    vi.spyOn(flowArmApi, 'get').mockResolvedValue(makeState());
    getFlowRejectionRateMock.mockImplementation(
      (_project: string, _milestone: string, flow: string) =>
        Promise.resolve(
          flow === 'ops'
            ? makeTrustRate({ flow: 'ops', total: 0, rejected: 0, rate: null })
            : makeTrustRate({
                flow: flow as never,
                total: 10,
                rejected: 1,
                rate: 0.1,
              }),
        ),
    );

    render(<FlowArmToggle milestoneId="m1" projectId="proj" />);

    // Await every rate this test compares against, not just ops — a flow whose
    // fetch hasn't resolved yet is "loading", not "no data", so comparing
    // against an unawaited flow would race its own fetch resolution.
    await waitFor(() => {
      expect(screen.getByTestId('flow-arm-rate-ops').textContent).toContain(
        'no data',
      );
      expect(screen.getByTestId('flow-arm-rate-groom').textContent).toContain(
        '10%',
      );
    });

    const noDataButton = screen.getByTestId('flow-arm-switch-ops');
    const goodScoreButton = screen.getByTestId('flow-arm-switch-groom');
    const disarmedNoMetric = screen.getByTestId('flow-arm-switch-docs');

    expect(noDataButton.style.backgroundColor).not.toEqual(
      goodScoreButton.style.backgroundColor,
    );
    expect(noDataButton.style.backgroundColor).not.toEqual(
      disarmedNoMetric.style.backgroundColor,
    );
  });

  it('renders a loading state distinct from genuinely-null, a rated score, and the disarmed no-metric tint, and never issues a docs request', async () => {
    vi.spyOn(flowArmApi, 'get').mockResolvedValue(
      makeState({
        groom: { armed: false, source: 'default' },
        docs: { armed: false, source: 'default' },
      }),
    );
    let resolveGroom: (result: FlowRejectionRateResult) => void = () => {};
    getFlowRejectionRateMock.mockImplementation(
      (_project: string, _milestone: string, flow: string) => {
        if (flow === 'groom') {
          return new Promise<FlowRejectionRateResult>((resolve) => {
            resolveGroom = resolve;
          });
        }
        return Promise.resolve(
          makeTrustRate({
            flow: flow as never,
            rate: null,
            total: 0,
            rejected: 0,
          }),
        );
      },
    );

    render(<FlowArmToggle milestoneId="m1" projectId="proj" />);

    await waitFor(() => {
      expect(screen.getByTestId('flow-arm-rate-ops').textContent).toContain(
        'no data',
      );
    });

    // groom's fetch is still pending — it must not read as "no data" yet.
    const loadingButton = screen.getByTestId('flow-arm-switch-groom');
    expect(screen.queryByTestId('flow-arm-rate-groom')).toBeNull();
    expect(loadingButton.getAttribute('aria-label')).not.toContain('no data');

    const noDataButton = screen.getByTestId('flow-arm-switch-ops');
    const disarmedNoMetric = screen.getByTestId('flow-arm-switch-docs');
    const loadingColor = loadingButton.style.backgroundColor;

    expect(loadingColor).not.toEqual(noDataButton.style.backgroundColor);
    expect(loadingColor).not.toEqual(disarmedNoMetric.style.backgroundColor);

    await act(async () => {
      resolveGroom(makeTrustRate({ flow: 'groom', rate: 0.1 }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId('flow-arm-rate-groom').textContent).toContain(
        '10%',
      );
    });

    const ratedButton = screen.getByTestId('flow-arm-switch-groom');
    expect(ratedButton.style.backgroundColor).not.toEqual(loadingColor);

    for (const call of getFlowRejectionRateMock.mock.calls) {
      expect(call[2]).not.toBe('docs');
    }
  });

  it('keeps the rate available as text alongside the unchanged Armed/Disarmed label and aria-checked', async () => {
    vi.spyOn(flowArmApi, 'get').mockResolvedValue(makeState());
    getFlowRejectionRateMock.mockResolvedValue(
      makeTrustRate({ flow: 'groom', total: 73, rejected: 1, rate: 1 / 73 }),
    );

    render(<FlowArmToggle milestoneId="m1" projectId="proj" />);

    await waitFor(() => {
      expect(screen.getByTestId('flow-arm-rate-groom').textContent).toContain(
        '1/73',
      );
    });

    const groomButton = screen.getByTestId('flow-arm-switch-groom');
    expect(groomButton.textContent).toContain('Disarmed');
    expect(groomButton.getAttribute('aria-checked')).toBe('false');
  });
});
