import { useState, useEffect, useCallback, useMemo } from 'react';
import { wrapApi } from '../api/wrap';
import type { WrapRun, WrapRunEvent } from '../api/wrap';
import type { DeployPlanStep } from '../api/deploy';
import { DeployStepStrip } from './DeployStepStrip';
import { useMilestoneConvergence } from '../hooks/useMilestoneConvergence';
import type { MilestoneConvergence } from '@claude-orchestrator/backend/src/convergence/convergenceService';
import {
  WRAP_STEP_MARK_WRAPPED,
  WRAP_STEP_CARRY_GATE_ITEMS,
  WRAP_STEP_CONFIRM_REPOINT,
  WRAP_STEP_REPOINT,
  WRAP_STEP_ADVANCE_MAIN,
  WRAP_STEP_CONFIRM_RELEASE,
  WRAP_STEP_CUT_RELEASE,
} from '@claude-orchestrator/backend/src/deploy/wrapPlaybook';
import styles from './WrapSection.module.css';

interface Props {
  activeProjectId: string | null;
  /** The milestone being closed out — passed to the convergence route as-is (accepts a short token or a canonical id). */
  closingMilestoneId: string | null;
}

const WRAP_PLAN: DeployPlanStep[] = [
  { id: WRAP_STEP_MARK_WRAPPED, description: 'Mark milestone wrapped' },
  {
    id: WRAP_STEP_CARRY_GATE_ITEMS,
    description: 'Carry forward pending gate items',
  },
  {
    id: WRAP_STEP_CONFIRM_REPOINT,
    description: 'Confirm repoint auto-launch',
  },
  { id: WRAP_STEP_REPOINT, description: 'Repoint auto-launch' },
  { id: WRAP_STEP_ADVANCE_MAIN, description: 'Advance dev -> main' },
  { id: WRAP_STEP_CONFIRM_RELEASE, description: 'Confirm cut release' },
  { id: WRAP_STEP_CUT_RELEASE, description: 'Cut release tag' },
];

const AXIS_LABELS: Record<
  keyof MilestoneConvergence['axes'],
  string
> = {
  tasks: 'tasks',
  gate: 'gate',
  seed: 'seed',
  ops: 'ops',
  investigationReport: 'investigationReport',
};

/** The specific axis keys (of the real 5-axis convergence read) not currently green — used to name what's blocking a wrap launch. */
function blockingAxisNames(convergence: MilestoneConvergence | null): string[] {
  if (!convergence) return [];
  return (Object.keys(convergence.axes) as (keyof MilestoneConvergence['axes'])[])
    .filter((key) => convergence.axes[key].status !== 'green')
    .map((key) => AXIS_LABELS[key]);
}

export function WrapSection({ activeProjectId, closingMilestoneId }: Props) {
  const [nextMilestoneId, setNextMilestoneId] = useState('');
  const [releaseVersion, setReleaseVersion] = useState('');
  const [wrapLaunching, setWrapLaunching] = useState(false);
  const [wrapLaunchError, setWrapLaunchError] = useState<string | null>(null);
  const [wrapRun, setWrapRun] = useState<WrapRun | null>(null);
  const [wrapEvents, setWrapEvents] = useState<WrapRunEvent[]>([]);
  const [wrapLogExpanded, setWrapLogExpanded] = useState(false);
  const [dismissedWrapRunId, setDismissedWrapRunId] = useState<string | null>(
    null,
  );
  // Plain ephemeral React state — no persistence. A reload must reset the
  // gate back to requiring a fresh review rather than resuming pre-armed.
  const [wrapConfirmArmed, setWrapConfirmArmed] = useState(false);

  const { convergence } = useMilestoneConvergence({
    projectId: activeProjectId,
    milestoneId: closingMilestoneId,
  });
  const allGreen = convergence?.status === 'green';
  const blockingAxes = useMemo(
    () => blockingAxisNames(convergence),
    [convergence],
  );

  const refreshWrapStatus = useCallback(() => {
    if (!activeProjectId) return;
    wrapApi
      .getStatus(activeProjectId)
      .then((result) => {
        setWrapRun(result.run);
        setWrapEvents(result.events);
      })
      .catch(() => {
        /* transient poll failures don't clear the last-known run state */
      });
  }, [activeProjectId]);

  // Load the project's wrap_run progress, polling while a run is active.
  useEffect(() => {
    if (!activeProjectId) {
      setWrapRun(null);
      setWrapEvents([]);
      setWrapConfirmArmed(false);
      return;
    }
    refreshWrapStatus();
    const interval = setInterval(() => {
      if (wrapRun?.status === 'running') refreshWrapStatus();
    }, 3000);
    return () => clearInterval(interval);
  }, [activeProjectId, wrapRun?.status, refreshWrapStatus]);

  const launchWrap = useCallback(() => {
    if (!activeProjectId || !closingMilestoneId) return;
    setWrapConfirmArmed(false);
    setWrapLaunching(true);
    setWrapLaunchError(null);
    wrapApi
      .launch({
        projectId: activeProjectId,
        closingMilestoneId,
        nextMilestoneId,
        releaseVersion,
      })
      .then((result) => {
        setWrapRun(result.run);
        setWrapEvents([]);
        setDismissedWrapRunId(null);
      })
      .catch((err) => {
        setWrapLaunchError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setWrapLaunching(false);
      });
  }, [activeProjectId, closingMilestoneId, nextMilestoneId, releaseVersion]);

  const dismissWrapRun = useCallback(() => {
    if (!wrapRun) return;
    setDismissedWrapRunId(wrapRun.run_id);
  }, [wrapRun]);

  if (!activeProjectId) return null;

  const launchDisabled =
    wrapLaunching ||
    wrapRun?.status === 'running' ||
    !allGreen ||
    !nextMilestoneId ||
    !releaseVersion;

  return (
    <div className={styles.wrapSection} data-testid="wrap-launch-section">
      <div className={styles.wrapInputs}>
        <input
          type="text"
          className={styles.wrapInput}
          placeholder="Next milestone id"
          value={nextMilestoneId}
          onChange={(e) => setNextMilestoneId(e.target.value)}
          data-testid="wrap-next-milestone-input"
        />
        <input
          type="text"
          className={styles.wrapInput}
          placeholder="Release version (e.g. 1.9.0)"
          value={releaseVersion}
          onChange={(e) => setReleaseVersion(e.target.value)}
          data-testid="wrap-release-version-input"
        />
      </div>
      <div className={styles.wrapRow}>
        {wrapConfirmArmed ? (
          <>
            <button
              className={styles.wrapButton}
              onClick={launchWrap}
              disabled={launchDisabled}
              data-testid="wrap-launch-button"
            >
              {wrapRun?.status === 'running' ? 'Wrapping…' : 'Confirm & Wrap'}
            </button>
            <button
              type="button"
              className={styles.wrapButton}
              onClick={() => setWrapConfirmArmed(false)}
              disabled={wrapLaunching || wrapRun?.status === 'running'}
              data-testid="wrap-cancel-confirm-button"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            className={styles.wrapButton}
            onClick={() => setWrapConfirmArmed(true)}
            disabled={launchDisabled}
            data-testid="wrap-review-button"
          >
            {wrapRun?.status === 'running' ? 'Wrapping…' : 'Review Wrap'}
          </button>
        )}
        {wrapRun && wrapRun.run_id !== dismissedWrapRunId && (
          <span className={styles.wrapRunStatus} data-testid="wrap-run-status">
            Run {wrapRun.run_id.slice(0, 8)}: {wrapRun.status}
            {wrapRun.current_step ? ` (${wrapRun.current_step})` : ''}
          </span>
        )}
        {wrapRun &&
          wrapRun.status !== 'running' &&
          wrapRun.run_id !== dismissedWrapRunId && (
            <button
              type="button"
              className={styles.wrapButton}
              onClick={dismissWrapRun}
              data-testid="wrap-run-dismiss-button"
            >
              Dismiss
            </button>
          )}
      </div>
      {!allGreen && (
        <p className={styles.blockingAxes} data-testid="wrap-blocking-axes">
          {blockingAxes.length > 0
            ? `Blocked on: ${blockingAxes.join(', ')}`
            : 'Waiting on milestone convergence…'}
        </p>
      )}
      {wrapLaunchError && <p className={styles.error}>{wrapLaunchError}</p>}
      {wrapRun &&
        wrapRun.status === 'failed' &&
        wrapRun.run_id !== dismissedWrapRunId &&
        (() => {
          const failedEvent = [...wrapEvents]
            .reverse()
            .find((ev) => ev.event_type === 'step_failed');
          return (
            <p className={styles.error} data-testid="wrap-run-failure-reason">
              Wrap failed
              {failedEvent
                ? ` at step "${failedEvent.step}"${
                    failedEvent.detail ? `: ${failedEvent.detail}` : ''
                  }`
                : wrapRun.current_step
                  ? ` at step "${wrapRun.current_step}"`
                  : ''}
            </p>
          );
        })()}
      {wrapRun && wrapRun.run_id !== dismissedWrapRunId && (
        <DeployStepStrip plan={WRAP_PLAN} events={wrapEvents} />
      )}
      {wrapRun &&
        wrapRun.run_id !== dismissedWrapRunId &&
        wrapEvents.length > 0 && (
          <>
            <button
              type="button"
              className={styles.wrapButton}
              onClick={() => setWrapLogExpanded((v) => !v)}
              data-testid="wrap-run-events-toggle"
            >
              {wrapLogExpanded ? 'Hide' : 'Show'} raw log ({wrapEvents.length})
            </button>
            {wrapLogExpanded && (
              <ul className={styles.wrapEventList} data-testid="wrap-run-events">
                {wrapEvents.map((ev) => (
                  <li key={ev.id}>
                    {ev.step}: {ev.event_type}
                    {ev.disposition ? ` (${ev.disposition})` : ''}
                    {ev.detail ? ` — ${ev.detail}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
    </div>
  );
}
