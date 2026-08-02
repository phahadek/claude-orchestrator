import { useEffect, useState } from 'react';
import { FLOW_IDS } from '@claude-orchestrator/backend/src/orchestration/flowArm';
import type { FlowId } from '@claude-orchestrator/backend/src/orchestration/flowArm';
import { flowArmApi, type FlowArmState } from '../api/flowArm';
import styles from './FlowArmToggle.module.css';

interface Props {
  milestoneId: string | null;
  /** The project's code-level autoLaunchEnabled flag, surfaced alongside per-flow arm — see the arm-model design's "independence surprise" mitigation. */
  autoLaunchEnabled?: boolean;
}

export function FlowArmToggle({ milestoneId, autoLaunchEnabled }: Props) {
  const [state, setState] = useState<FlowArmState | null>(null);
  const [pending, setPending] = useState<Partial<Record<FlowId, boolean>>>({});
  const [error, setError] = useState<string | null>(null);

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
                aria-label={`Toggle auto-dispatch arm for ${flow}`}
                disabled={!state || isPending}
                className={`${styles.toggle} ${armed ? styles.toggleArmed : ''}`}
                data-testid={`flow-arm-switch-${flow}`}
                onClick={() => handleToggle(flow, !armed)}
              >
                {armed ? 'Armed' : 'Disarmed'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
