import { useEffect, useState, type CSSProperties } from 'react';
import { FLOW_IDS } from '@claude-orchestrator/backend/src/orchestration/flowArm';
import type { FlowId } from '@claude-orchestrator/backend/src/orchestration/flowArm';
import {
  flowArmApi,
  gateVerifyPolicyApi,
  type FlowArmState,
  type GateVerifyPolicyState,
} from '../api/flowArm';
import {
  gateApi,
  TRUST_PRECISION_FLOWS,
  type FlowRejectionRateResult,
  type TrustPrecisionFlow,
} from '../api/gate';
import styles from './FlowArmToggle.module.css';

interface Props {
  milestoneId: string | null;
  /** Scopes the per-flow trust-rate read; the milestone UUID is passed through unconverted (resolveMilestoneForProject translates it server-side). */
  projectId?: string | null;
  /** The project's code-level autoLaunchEnabled flag, surfaced alongside per-flow arm — see the arm-model design's "independence surprise" mitigation. */
  autoLaunchEnabled?: boolean;
}

function hasTrustMetric(flow: FlowId): flow is TrustPrecisionFlow {
  return (TRUST_PRECISION_FLOWS as readonly string[]).includes(flow);
}

function hueForRate(rate: number): number {
  const clamped = Math.min(1, Math.max(0, rate));
  return 120 - 120 * clamped;
}

/** Green→red ramp by rate, heavily desaturated toward grey when disarmed, bright when armed. */
function ratedBackground(rate: number, armed: boolean): string {
  const hue = hueForRate(rate);
  return armed ? `hsl(${hue}, 65%, 42%)` : `hsl(${hue}, 16%, 28%)`;
}

/** A neutral, non-ramp tint for "no data" (the fetch resolved and there is genuinely nothing) — distinct from both a good (green) score and the achromatic disarmed grey. */
function noDataBackground(armed: boolean): string {
  return armed ? 'hsl(228, 24%, 42%)' : 'hsl(228, 12%, 26%)';
}

/** A distinct tint for "the rate hasn't resolved yet" — must not collide with rated, no-data, or the disarmed no-metric grey. */
function loadingBackground(armed: boolean): string {
  return armed ? 'hsl(268, 24%, 42%)' : 'hsl(268, 12%, 26%)';
}

function formatRate(result: FlowRejectionRateResult): string {
  if (result.rate === null) return 'no data';
  return `${Math.round(result.rate * 100)}% (${result.rejected}/${result.total})`;
}

export function FlowArmToggle({
  milestoneId,
  projectId = null,
  autoLaunchEnabled,
}: Props) {
  const [state, setState] = useState<FlowArmState | null>(null);
  const [pending, setPending] = useState<Partial<Record<FlowId, boolean>>>({});
  const [error, setError] = useState<string | null>(null);
  const [trustRates, setTrustRates] = useState<
    Partial<Record<TrustPrecisionFlow, FlowRejectionRateResult>>
  >({});
  const [policy, setPolicy] = useState<GateVerifyPolicyState | null>(null);
  const [policyPending, setPolicyPending] = useState<
    Partial<Record<string, boolean>>
  >({});
  const [policyError, setPolicyError] = useState<string | null>(null);

  useEffect(() => {
    setState(null);
    setError(null);
    if (!milestoneId) return;

    let cancelled = false;
    flowArmApi
      .get(milestoneId)
      .then((res) => {
        if (!cancelled) setState(res);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [milestoneId]);

  useEffect(() => {
    setPolicy(null);
    setPolicyError(null);
    if (!milestoneId) return;

    let cancelled = false;
    gateVerifyPolicyApi
      .get(milestoneId)
      .then((res) => {
        if (!cancelled) setPolicy(res);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setPolicyError(err instanceof Error ? err.message : String(err));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [milestoneId]);

  useEffect(() => {
    setTrustRates({});
    if (!projectId || !milestoneId) return;

    let cancelled = false;
    // Each flow's fetch resolves independently so a flow with data renders as
    // soon as it's ready, instead of every row waiting on the slowest fetch.
    TRUST_PRECISION_FLOWS.forEach((flow) => {
      gateApi
        .getFlowRejectionRate(projectId, milestoneId, flow)
        .catch(
          (): FlowRejectionRateResult => ({
            flow,
            project: projectId,
            milestone: milestoneId,
            total: 0,
            rejected: 0,
            rate: null,
          }),
        )
        .then((result) => {
          if (cancelled) return;
          setTrustRates((prev) => ({ ...prev, [flow]: result }));
        });
    });

    return () => {
      cancelled = true;
    };
  }, [projectId, milestoneId]);

  if (!milestoneId) return null;

  const handleToggle = (flow: FlowId, next: boolean) => {
    setError(null);
    setPending((prev) => ({ ...prev, [flow]: true }));
    flowArmApi
      .set(milestoneId, flow, next)
      .then((res) => {
        setState((prev) => ({
          ...(prev ?? ({} as FlowArmState)),
          [flow]: { armed: res.armed, source: 'row' },
        }));
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setPending((prev) => {
          const next = { ...prev };
          delete next[flow];
          return next;
        });
      });
  };

  const handlePolicyToggle = (dispositionClass: string, next: boolean) => {
    if (!milestoneId) return;
    setPolicyError(null);
    setPolicyPending((prev) => ({ ...prev, [dispositionClass]: true }));
    gateVerifyPolicyApi
      .set(milestoneId, dispositionClass, next)
      .then((res) => {
        setPolicy((prev) => ({
          ...(prev ?? {}),
          [dispositionClass]: { armed: res.armed },
        }));
      })
      .catch((err: unknown) => {
        setPolicyError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setPolicyPending((prev) => {
          const next = { ...prev };
          delete next[dispositionClass];
          return next;
        });
      });
  };

  return (
    <div className={styles.container} data-testid="flow-arm-toggle">
      <div className={styles.header}>
        <span className={styles.title}>Auto-dispatch arm</span>
        <span className={styles.autoLaunch} data-testid="flow-arm-auto-launch">
          Auto-launch: {autoLaunchEnabled ? 'on' : 'off'}
        </span>
      </div>

      {error && (
        <div className={styles.error} data-testid="flow-arm-error">
          {error}
        </div>
      )}

      <div className={styles.rows}>
        {FLOW_IDS.map((flow) => {
          const entry = state?.[flow];
          const armed = entry?.armed ?? false;
          const isPending = pending[flow] === true;
          const metricFlow = hasTrustMetric(flow);
          const trustResult = metricFlow ? trustRates[flow] : undefined;
          const trustFetchInFlight = Boolean(
            metricFlow && projectId && milestoneId,
          );
          const trustLoading = trustFetchInFlight && trustResult === undefined;

          let toggleClassName = `${styles.toggle} ${armed ? styles.toggleArmed : ''}`;
          let toggleStyle: CSSProperties | undefined;
          let rateLabel: string | null = null;
          let rateAccessibleLabel = '';

          if (metricFlow) {
            if (trustLoading) {
              toggleClassName += ` ${styles.toggleLoading}`;
              toggleStyle = { backgroundColor: loadingBackground(armed) };
              rateLabel = null;
              rateAccessibleLabel = ', trust rate loading';
            } else if (trustResult && trustResult.rate !== null) {
              toggleClassName += ` ${styles.toggleRated}`;
              toggleStyle = {
                backgroundColor: ratedBackground(trustResult.rate, armed),
              };
              rateLabel = formatRate(trustResult);
              rateAccessibleLabel = `, trust rate ${rateLabel}`;
            } else {
              toggleClassName += ` ${styles.toggleNoData}`;
              toggleStyle = { backgroundColor: noDataBackground(armed) };
              rateLabel = 'no data';
              rateAccessibleLabel = ', trust rate no data';
            }
          } else {
            toggleClassName += ` ${styles.toggleNoMetric}`;
          }

          return (
            <div
              key={flow}
              className={styles.row}
              data-testid={`flow-arm-row-${flow}`}
            >
              <span className={styles.flowLabel}>{flow}</span>
              <button
                type="button"
                role="switch"
                aria-checked={armed}
                aria-label={`Toggle auto-dispatch arm for ${flow}${rateAccessibleLabel}`}
                disabled={!state || isPending}
                className={toggleClassName}
                style={toggleStyle}
                data-testid={`flow-arm-switch-${flow}`}
                onClick={() => handleToggle(flow, !armed)}
              >
                <span className={styles.toggleText}>
                  {armed ? 'Armed' : 'Disarmed'}
                </span>
                {rateLabel && (
                  <span
                    className={styles.rateLabel}
                    data-testid={`flow-arm-rate-${flow}`}
                  >
                    {rateLabel}
                  </span>
                )}
              </button>
            </div>
          );
        })}
      </div>

      <div className={styles.header}>
        <span className={styles.title}>Gate-verify auto-commit policy</span>
      </div>

      {policyError && (
        <div className={styles.error} data-testid="gate-verify-policy-error">
          {policyError}
        </div>
      )}

      <div className={styles.rows}>
        {policy &&
          Object.keys(policy).map((dispositionClass) => {
            const armed = policy[dispositionClass]?.armed ?? false;
            const isPending = policyPending[dispositionClass] === true;

            return (
              <div
                key={dispositionClass}
                className={styles.row}
                data-testid={`gate-verify-policy-row-${dispositionClass}`}
              >
                <span className={styles.flowLabel}>{dispositionClass}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={armed}
                  aria-label={`Toggle gate-verify auto-commit policy for ${dispositionClass}`}
                  disabled={isPending}
                  className={`${styles.toggle} ${armed ? styles.toggleArmed : ''}`}
                  data-testid={`gate-verify-policy-switch-${dispositionClass}`}
                  onClick={() => handlePolicyToggle(dispositionClass, !armed)}
                >
                  <span className={styles.toggleText}>
                    {armed ? 'Armed' : 'Disarmed'}
                  </span>
                </button>
              </div>
            );
          })}
      </div>
    </div>
  );
}
