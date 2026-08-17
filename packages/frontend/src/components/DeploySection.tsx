import { useState, useEffect, useCallback } from 'react';
import { deployApi } from '../api/deploy';
import type {
  DeployRun,
  DeployRunEvent,
  BehindItem,
  DeployPlanStep,
} from '../api/deploy';
import { DeployStepStrip } from './DeployStepStrip';
import styles from './DeploySection.module.css';

interface Props {
  activeProjectId: string | null;
}

export function DeploySection({ activeProjectId }: Props) {
  const [deployLaunching, setDeployLaunching] = useState(false);
  const [deployLaunchError, setDeployLaunchError] = useState<string | null>(
    null,
  );
  const [deployRun, setDeployRun] = useState<DeployRun | null>(null);
  const [deployEvents, setDeployEvents] = useState<DeployRunEvent[]>([]);
  const [deployPlan, setDeployPlan] = useState<DeployPlanStep[]>([]);
  const [deployLogExpanded, setDeployLogExpanded] = useState(false);
  const [dismissedDeployRunId, setDismissedDeployRunId] = useState<
    string | null
  >(null);
  const [deployedSha, setDeployedSha] = useState<string | null>(null);
  const [deployBehind, setDeployBehind] = useState<{
    count: number;
    items: BehindItem[];
  }>({ count: 0, items: [] });
  // Plain ephemeral React state — no persistence. A reload must reset the
  // gate back to requiring a fresh review rather than resuming pre-armed.
  const [deployConfirmArmed, setDeployConfirmArmed] = useState(false);

  const refreshDeployStatus = useCallback(() => {
    if (!activeProjectId) return;
    deployApi
      .getStatus(activeProjectId)
      .then((result) => {
        setDeployRun(result.run);
        setDeployEvents(result.events);
        setDeployedSha(result.deployedSha ?? null);
        setDeployBehind(result.behind ?? { count: 0, items: [] });
        setDeployPlan(result.plan ?? []);
      })
      .catch(() => {
        /* transient poll failures don't clear the last-known run state */
      });
  }, [activeProjectId]);

  // Load the project's deploy_run progress, polling while a run is active.
  useEffect(() => {
    if (!activeProjectId) {
      setDeployRun(null);
      setDeployEvents([]);
      setDeployPlan([]);
      setDeployedSha(null);
      setDeployBehind({ count: 0, items: [] });
      setDeployConfirmArmed(false);
      return;
    }
    refreshDeployStatus();
    const interval = setInterval(() => {
      if (deployRun?.status === 'running') refreshDeployStatus();
    }, 3000);
    return () => clearInterval(interval);
  }, [activeProjectId, deployRun?.status, refreshDeployStatus]);

  const launchDeploy = useCallback(() => {
    if (!activeProjectId) return;
    setDeployConfirmArmed(false);
    setDeployLaunching(true);
    setDeployLaunchError(null);
    deployApi
      .launch(activeProjectId)
      .then((result) => {
        setDeployRun(result.run);
        setDeployEvents([]);
        setDismissedDeployRunId(null);
      })
      .catch((err) => {
        setDeployLaunchError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setDeployLaunching(false);
      });
  }, [activeProjectId]);

  const dismissDeployRun = useCallback(() => {
    if (!deployRun) return;
    setDismissedDeployRunId(deployRun.run_id);
  }, [deployRun]);

  if (!activeProjectId) return null;

  return (
    <div className={styles.deploySection} data-testid="deploy-launch-section">
      <div className={styles.deployRow}>
        {deployConfirmArmed ? (
          <>
            <button
              className={styles.deployButton}
              onClick={launchDeploy}
              disabled={deployLaunching || deployRun?.status === 'running'}
              data-testid="deploy-launch-button"
            >
              {deployRun?.status === 'running'
                ? 'Deploying…'
                : `Confirm & Deploy (${deployBehind.count} behind)`}
            </button>
            <button
              type="button"
              className={styles.deployButton}
              onClick={() => setDeployConfirmArmed(false)}
              disabled={deployLaunching || deployRun?.status === 'running'}
              data-testid="deploy-cancel-confirm-button"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            className={styles.deployButton}
            onClick={() => setDeployConfirmArmed(true)}
            disabled={deployLaunching || deployRun?.status === 'running'}
            data-testid="deploy-review-button"
          >
            {deployRun?.status === 'running'
              ? 'Deploying…'
              : `Review Deploy (${deployBehind.count} behind)`}
          </button>
        )}
        {deployRun && deployRun.run_id !== dismissedDeployRunId && (
          <span
            className={styles.deployRunStatus}
            data-testid="deploy-run-status"
          >
            Run {deployRun.run_id.slice(0, 8)}: {deployRun.status}
            {deployRun.current_step ? ` (${deployRun.current_step})` : ''}
          </span>
        )}
        {deployRun &&
          deployRun.status !== 'running' &&
          deployRun.run_id !== dismissedDeployRunId && (
            <button
              type="button"
              className={styles.deployButton}
              onClick={dismissDeployRun}
              data-testid="deploy-run-dismiss-button"
            >
              Dismiss
            </button>
          )}
      </div>
      <p className={styles.muted} data-testid="deploy-behind-summary">
        {deployedSha
          ? `Deployed ${deployedSha.slice(0, 8)} — ${deployBehind.count} merged since`
          : `Never deployed through this system — ${deployBehind.count} merged`}
      </p>
      {deployConfirmArmed && deployBehind.items.length > 0 && (
        <ul className={styles.deployEventList} data-testid="deploy-behind-list">
          {deployBehind.items.map((item, index) => (
            <li key={`${item.kind}-${index}`}>
              {item.kind === 'pr' ? (
                <a
                  className={styles.deployPrLink}
                  href={item.prUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  #{item.prNumber} {item.title ?? item.prUrl}
                </a>
              ) : (
                <span>
                  {item.branchName}
                  {item.title ? ` — ${item.title}` : ''}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {deployLaunchError && <p className={styles.error}>{deployLaunchError}</p>}
      {deployRun &&
        deployRun.status === 'failed' &&
        deployRun.run_id !== dismissedDeployRunId &&
        (() => {
          const failedEvent = [...deployEvents]
            .reverse()
            .find((ev) => ev.event_type === 'step_failed');
          return (
            <p className={styles.error} data-testid="deploy-run-failure-reason">
              Deploy failed
              {failedEvent
                ? ` at step "${failedEvent.step}"${
                    failedEvent.detail ? `: ${failedEvent.detail}` : ''
                  }`
                : deployRun.current_step
                  ? ` at step "${deployRun.current_step}"`
                  : ''}
            </p>
          );
        })()}
      {deployRun &&
        deployRun.run_id !== dismissedDeployRunId &&
        deployPlan.length > 0 && (
          <DeployStepStrip plan={deployPlan} events={deployEvents} />
        )}
      {deployRun &&
        deployRun.run_id !== dismissedDeployRunId &&
        deployEvents.length > 0 && (
          <>
            <button
              type="button"
              className={styles.deployButton}
              onClick={() => setDeployLogExpanded((v) => !v)}
              data-testid="deploy-run-events-toggle"
            >
              {deployLogExpanded ? 'Hide' : 'Show'} raw log (
              {deployEvents.length})
            </button>
            {deployLogExpanded && (
              <ul
                className={styles.deployEventList}
                data-testid="deploy-run-events"
              >
                {deployEvents.map((ev) => (
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
