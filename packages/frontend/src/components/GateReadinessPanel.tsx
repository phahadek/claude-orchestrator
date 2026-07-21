import { Fragment, useState, useEffect, useCallback, useRef } from 'react';
import { gateApi } from '../api/gate';
import type {
  GateItem,
  GateItemClassification,
  GateItemDetail,
  GateReadiness,
  MilestoneReadiness,
} from '../api/gate';
import { seedApi } from '../api/seed';
import type {
  SeedItem,
  SeedReadiness,
  SeedMilestoneReadiness,
} from '../api/seed';
import { deployApi } from '../api/deploy';
import type { DeployRun, DeployRunEvent } from '../api/deploy';
import styles from './GateReadinessPanel.module.css';

interface Props {
  activeProjectId: string | null;
  /** Milestone display name resolved from the top bar's selected board, if any. */
  activeBoardMilestone?: string | null;
}

const PAGE_SIZE = 20;

const CLASSIFICATION_OPTIONS: GateItemClassification[] = [
  'needs-triage',
  'Read-Only',
  'Opportunistic',
  'Prod-Mutating',
];

const GATE_STATE_ORDER = [
  'open',
  'runnable',
  'pass',
  'fail',
  'deferred',
  'pending-approval',
];
const GATE_DONE_STATES = ['pass', 'deferred'];

const SEED_STATE_ORDER = ['pending', 'applied', 'confirmed', 'blocked'];
const SEED_DONE_STATES = ['confirmed'];

interface RollupHeaderProps {
  testId: string;
  title: string;
  status: 'green' | 'blocked' | null;
  loading: boolean;
  error: string | null;
  counts: Record<string, number>;
  stateOrder: string[];
  doneStates: string[];
  activeState: string;
  onSelectState: (state: string) => void;
}

function RollupHeader({
  testId,
  title,
  status,
  loading,
  error,
  counts,
  stateOrder,
  doneStates,
  activeState,
  onSelectState,
}: RollupHeaderProps) {
  const total = stateOrder.reduce((sum, s) => sum + (counts[s] ?? 0), 0);
  const doneCount = doneStates.reduce((sum, s) => sum + (counts[s] ?? 0), 0);
  const notDoneStates = stateOrder.filter((s) => !doneStates.includes(s));

  return (
    <div className={styles.rollupHeader} data-testid={testId}>
      <div className={styles.rollupHeaderTop}>
        <h3 className={styles.rollupTitle}>{title}</h3>
        {status && (
          <div
            className={`${styles.statusBadge} ${
              status === 'green' ? styles.statusGreen : styles.statusBlocked
            }`}
          >
            {status === 'green' ? '✅ Green — ready' : '🚫 Blocked'}
          </div>
        )}
      </div>

      {loading && <p className={styles.muted}>Loading readiness…</p>}
      {error && <p className={styles.error}>{error}</p>}

      {!loading && !error && total === 0 && (
        <p className={styles.muted}>No items tracked yet.</p>
      )}

      {!loading && !error && total > 0 && (
        <>
          <div className={styles.progressBar}>
            <div
              className={`${styles.progressSegment} ${styles.progressDone}`}
              style={{ width: `${(doneCount / total) * 100}%` }}
              title={`${doneCount} done`}
            />
            {notDoneStates.map((s) =>
              counts[s] ? (
                <div
                  key={s}
                  className={`${styles.progressSegment} ${styles.progressPending}`}
                  style={{ width: `${((counts[s] ?? 0) / total) * 100}%` }}
                  title={`${counts[s]} ${s}`}
                />
              ) : null,
            )}
          </div>

          <div className={styles.chipRow}>
            {stateOrder.map((s) => (
              <button
                key={s}
                type="button"
                className={`${styles.chip} ${
                  activeState === s ? styles.chipActive : ''
                } ${doneStates.includes(s) ? styles.chipDone : ''}`}
                onClick={() => onSelectState(s)}
                data-testid={`${testId}-chip-${s}`}
              >
                {s} ({counts[s] ?? 0})
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function GateReadinessPanel({
  activeProjectId,
  activeBoardMilestone = null,
}: Props) {
  const [milestones, setMilestones] = useState<MilestoneReadiness[]>([]);
  const [milestonesLoading, setMilestonesLoading] = useState(false);
  const [milestonesError, setMilestonesError] = useState<string | null>(null);

  const [selectedMilestone, setSelectedMilestone] = useState<string | null>(
    null,
  );

  const [readiness, setReadiness] = useState<GateReadiness | null>(null);
  const [readinessLoading, setReadinessLoading] = useState(false);
  const [readinessError, setReadinessError] = useState<string | null>(null);

  const [stateFilter, setStateFilter] = useState('');
  const [classificationFilter, setClassificationFilter] = useState('');
  const [runnableFilter, setRunnableFilter] = useState('true');
  const [page, setPage] = useState(1);

  const [items, setItems] = useState<GateItem[]>([]);
  const [itemsTotal, setItemsTotal] = useState(0);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [itemsError, setItemsError] = useState<string | null>(null);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<GateItemDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(
    new Set(),
  );
  const [verifyingIds, setVerifyingIds] = useState<Set<string>>(new Set());
  const [verifyBaseline, setVerifyBaseline] = useState<
    Record<string, string | undefined>
  >({});
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const [seedMilestones, setSeedMilestones] = useState<
    SeedMilestoneReadiness[]
  >([]);

  const [seedReadiness, setSeedReadiness] = useState<SeedReadiness | null>(
    null,
  );
  const [seedReadinessLoading, setSeedReadinessLoading] = useState(false);
  const [seedReadinessError, setSeedReadinessError] = useState<string | null>(
    null,
  );

  const [seedStateFilter, setSeedStateFilter] = useState('');
  const [seedPage, setSeedPage] = useState(1);

  const [seedItems, setSeedItems] = useState<SeedItem[]>([]);
  const [seedItemsTotal, setSeedItemsTotal] = useState(0);
  const [seedItemsLoading, setSeedItemsLoading] = useState(false);
  const [seedItemsError, setSeedItemsError] = useState<string | null>(null);

  const [deployLaunching, setDeployLaunching] = useState(false);
  const [deployLaunchError, setDeployLaunchError] = useState<string | null>(
    null,
  );
  const [deployRun, setDeployRun] = useState<DeployRun | null>(null);
  const [deployEvents, setDeployEvents] = useState<DeployRunEvent[]>([]);

  // Tracks the top-bar milestone selection without forcing a milestone-list
  // refetch whenever it changes (see the resync effect below).
  const activeBoardMilestoneRef = useRef(activeBoardMilestone);
  useEffect(() => {
    activeBoardMilestoneRef.current = activeBoardMilestone;
  }, [activeBoardMilestone]);

  // Load milestone readiness for the active project.
  useEffect(() => {
    let cancelled = false;
    setMilestonesLoading(true);
    setMilestonesError(null);
    gateApi
      .listMilestoneReadiness(activeProjectId ?? undefined)
      .then((result) => {
        if (cancelled) return;
        setMilestones(result);
        setSelectedMilestone((current) => {
          const topBarMilestone = activeBoardMilestoneRef.current;
          if (
            topBarMilestone &&
            result.some((m) => m.milestone === topBarMilestone)
          ) {
            return topBarMilestone;
          }
          if (current && result.some((m) => m.milestone === current)) {
            return current;
          }
          return result[0]?.milestone ?? null;
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setMilestonesError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (cancelled) return;
        setMilestonesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProjectId]);

  // Re-sync the selected milestone whenever the top-bar selection changes
  // (the panel's own dropdown remains an explicit override in between).
  const lastSyncedBoardMilestoneRef = useRef(activeBoardMilestone);
  useEffect(() => {
    if (activeBoardMilestone === lastSyncedBoardMilestoneRef.current) return;
    lastSyncedBoardMilestoneRef.current = activeBoardMilestone;
    if (
      activeBoardMilestone &&
      milestones.some((m) => m.milestone === activeBoardMilestone)
    ) {
      setSelectedMilestone(activeBoardMilestone);
    }
  }, [activeBoardMilestone, milestones]);

  // Load config-seed milestone readiness alongside gate readiness.
  useEffect(() => {
    let cancelled = false;
    seedApi
      .listSeedMilestoneReadiness(activeProjectId ?? undefined)
      .then((result) => {
        if (cancelled) return;
        setSeedMilestones(result);
      })
      .catch(() => {
        if (cancelled) return;
        setSeedMilestones([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProjectId]);

  // Load readiness (green/blocked + per-state counts) for the selected milestone.
  useEffect(() => {
    if (!selectedMilestone) {
      setReadiness(null);
      return;
    }
    let cancelled = false;
    setReadinessLoading(true);
    setReadinessError(null);
    gateApi
      .getGateReadiness(selectedMilestone)
      .then((result) => {
        if (cancelled) return;
        setReadiness(result);
      })
      .catch((err) => {
        if (cancelled) return;
        setReadinessError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (cancelled) return;
        setReadinessLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedMilestone]);

  // Load config-seed readiness (green/blocked + per-state counts) for the selected milestone.
  useEffect(() => {
    if (!selectedMilestone) {
      setSeedReadiness(null);
      return;
    }
    let cancelled = false;
    setSeedReadinessLoading(true);
    setSeedReadinessError(null);
    seedApi
      .getSeedReadiness(selectedMilestone)
      .then((result) => {
        if (cancelled) return;
        setSeedReadiness(result);
      })
      .catch((err) => {
        if (cancelled) return;
        setSeedReadinessError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (cancelled) return;
        setSeedReadinessLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedMilestone]);

  // Reset to page 1 whenever the milestone or filters change.
  useEffect(() => {
    setPage(1);
  }, [selectedMilestone, stateFilter, classificationFilter, runnableFilter]);

  // Reset seed items to page 1 whenever the milestone or seed filter changes.
  useEffect(() => {
    setSeedPage(1);
  }, [selectedMilestone, seedStateFilter]);

  // Load the filtered/paginated item list — never a full unbounded load.
  // Defaults to the run worklist: runnable items, not-done first.
  useEffect(() => {
    if (!selectedMilestone) {
      setItems([]);
      setItemsTotal(0);
      return;
    }
    let cancelled = false;
    setItemsLoading(true);
    setItemsError(null);
    gateApi
      .listGateItems({
        project: activeProjectId ?? undefined,
        milestone: selectedMilestone,
        state: stateFilter || undefined,
        classification:
          (classificationFilter as GateItemClassification) || undefined,
        runnable: runnableFilter === '' ? undefined : runnableFilter === 'true',
        order: stateFilter === '' ? 'not-done-first' : undefined,
        page,
        limit: PAGE_SIZE,
      })
      .then((result) => {
        if (cancelled) return;
        setItems(result.items);
        setItemsTotal(result.total);
      })
      .catch((err) => {
        if (cancelled) return;
        setItemsError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (cancelled) return;
        setItemsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeProjectId,
    selectedMilestone,
    stateFilter,
    classificationFilter,
    runnableFilter,
    page,
  ]);

  // Load the filtered/paginated seed item list — never a full unbounded load.
  // Defaults to the run worklist: unconfirmed items first.
  useEffect(() => {
    if (!selectedMilestone) {
      setSeedItems([]);
      setSeedItemsTotal(0);
      return;
    }
    let cancelled = false;
    setSeedItemsLoading(true);
    setSeedItemsError(null);
    seedApi
      .listSeedItems({
        project: activeProjectId ?? undefined,
        milestone: selectedMilestone,
        state: seedStateFilter || undefined,
        order: seedStateFilter === '' ? 'not-done-first' : undefined,
        page: seedPage,
        limit: PAGE_SIZE,
      })
      .then((result) => {
        if (cancelled) return;
        setSeedItems(result.items);
        setSeedItemsTotal(result.total);
      })
      .catch((err) => {
        if (cancelled) return;
        setSeedItemsError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (cancelled) return;
        setSeedItemsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProjectId, selectedMilestone, seedStateFilter, seedPage]);

  const refreshDeployStatus = useCallback(() => {
    if (!activeProjectId) return;
    deployApi
      .getStatus(activeProjectId)
      .then((result) => {
        setDeployRun(result.run);
        setDeployEvents(result.events);
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
    setDeployLaunching(true);
    setDeployLaunchError(null);
    deployApi
      .launch(activeProjectId)
      .then((result) => {
        setDeployRun(result.run);
        setDeployEvents([]);
      })
      .catch((err) => {
        setDeployLaunchError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setDeployLaunching(false);
      });
  }, [activeProjectId]);

  const toggleExpanded = useCallback(
    (id: string) => {
      if (expandedId === id) {
        setExpandedId(null);
        setDetail(null);
        return;
      }
      setExpandedId(id);
      setDetail(null);
      setDetailLoading(true);
      gateApi
        .getGateItemDetail(id)
        .then((result) => setDetail(result))
        .catch(() => setDetail(null))
        .finally(() => setDetailLoading(false));
    },
    [expandedId],
  );

  const toggleItemSelected = useCallback((id: string) => {
    setSelectedItemIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // The manual verify-item/verify-batch dispatch — the Verify(N) launcher
  // for the GateItemVerifier, analogous to the Groom(N)/Ops(N) launchers.
  const dispatchVerify = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      setVerifyError(null);
      setVerifyBaseline((prev) => {
        const next = { ...prev };
        for (const id of ids) {
          next[id] = items.find((i) => i.id === id)?.currentDisposition;
        }
        return next;
      });
      gateApi
        .dispatchVerification(ids)
        .then((result) => {
          setVerifyingIds((prev) => {
            const next = new Set(prev);
            result.dispatched.forEach((id) => next.add(id));
            return next;
          });
          if (result.skipped.length > 0) {
            setVerifyError(
              `Skipped: ${result.skipped
                .map((s) => `${s.itemId} (${s.reason})`)
                .join(', ')}`,
            );
          }
          setSelectedItemIds(new Set());
        })
        .catch((err) => {
          setVerifyError(err instanceof Error ? err.message : String(err));
        });
    },
    [items],
  );

  // Polls each in-flight verification's item detail until its disposition
  // moves away from the dispatch-time baseline, reflecting the resulting
  // disposition back into the table without a full-page refresh.
  useEffect(() => {
    if (verifyingIds.size === 0) return;
    const ids = Array.from(verifyingIds);
    const interval = setInterval(() => {
      Promise.all(
        ids.map((id) =>
          gateApi
            .getGateItemDetail(id)
            .then((detail) => ({ id, detail }))
            .catch(() => null),
        ),
      ).then((results) => {
        const settled: string[] = [];
        setItems((prevItems) =>
          prevItems.map((item) => {
            const found = results.find((r) => r && r.id === item.id);
            if (!found) return item;
            const newDisposition = found.detail.item.currentDisposition;
            if (newDisposition !== verifyBaseline[item.id]) {
              settled.push(item.id);
              return {
                ...item,
                currentDisposition: newDisposition,
                state: found.detail.item.state,
                updatedAt: found.detail.item.updatedAt,
              };
            }
            return item;
          }),
        );
        if (settled.length > 0) {
          setVerifyingIds((prev) => {
            const next = new Set(prev);
            settled.forEach((id) => next.delete(id));
            return next;
          });
        }
      });
    }, 5000);
    return () => clearInterval(interval);
  }, [verifyingIds, verifyBaseline]);

  const selectGateChip = useCallback((state: string) => {
    setStateFilter(state);
    setRunnableFilter('');
  }, []);

  const selectSeedChip = useCallback((state: string) => {
    setSeedStateFilter(state);
  }, []);

  const totalPages = Math.max(1, Math.ceil(itemsTotal / PAGE_SIZE));
  const seedTotalPages = Math.max(1, Math.ceil(seedItemsTotal / PAGE_SIZE));

  const seedForSelected = selectedMilestone
    ? seedMilestones.find((m) => m.milestone === selectedMilestone)
    : undefined;
  const gateForSelected = selectedMilestone
    ? milestones.find((m) => m.milestone === selectedMilestone)
    : undefined;
  const compositeStatus: 'green' | 'blocked' | null =
    gateForSelected && seedForSelected
      ? gateForSelected.status === 'green' && seedForSelected.status === 'green'
        ? 'green'
        : 'blocked'
      : null;

  return (
    <div className={styles.panel} data-testid="gate-readiness-panel">
      <div className={styles.header}>
        <h2 className={styles.title}>Gate Readiness</h2>
        {milestones.length > 0 && (
          <select
            className={styles.milestoneSelect}
            value={selectedMilestone ?? ''}
            onChange={(e) => setSelectedMilestone(e.target.value || null)}
            aria-label="Select milestone"
          >
            {milestones.map((m) => (
              <option key={`${m.project}:${m.milestone}`} value={m.milestone}>
                {m.milestone} (
                {m.status === 'green' ? '✅' : `🚫 ${m.blockingCount}`})
              </option>
            ))}
          </select>
        )}
        {compositeStatus && (
          <div
            className={`${styles.statusBadge} ${
              compositeStatus === 'green'
                ? styles.statusGreen
                : styles.statusBlocked
            }`}
            data-testid="composite-readiness-status"
          >
            {compositeStatus === 'green'
              ? '✅ Milestone complete (gate + seed)'
              : '🚫 Milestone incomplete'}
          </div>
        )}
      </div>

      {milestonesLoading && <p className={styles.muted}>Loading milestones…</p>}
      {milestonesError && <p className={styles.error}>{milestonesError}</p>}
      {!milestonesLoading && !milestonesError && milestones.length === 0 && (
        <p className={styles.muted}>No gate items tracked yet.</p>
      )}

      {activeProjectId && (
        <div
          className={styles.deploySection}
          data-testid="deploy-launch-section"
        >
          <div className={styles.deployRow}>
            <button
              className={styles.deployButton}
              onClick={launchDeploy}
              disabled={deployLaunching || deployRun?.status === 'running'}
              data-testid="deploy-launch-button"
            >
              {deployRun?.status === 'running' ? 'Deploying…' : 'Launch Deploy'}
            </button>
            {deployRun && (
              <span
                className={styles.deployRunStatus}
                data-testid="deploy-run-status"
              >
                Run {deployRun.run_id.slice(0, 8)}: {deployRun.status}
                {deployRun.current_step ? ` (${deployRun.current_step})` : ''}
              </span>
            )}
          </div>
          {deployLaunchError && (
            <p className={styles.error}>{deployLaunchError}</p>
          )}
          {deployEvents.length > 0 && (
            <ul
              className={styles.deployEventList}
              data-testid="deploy-run-events"
            >
              {deployEvents.map((ev) => (
                <li key={ev.id}>
                  {ev.step}: {ev.event_type}
                  {ev.disposition ? ` (${ev.disposition})` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {selectedMilestone && (
        <>
          <RollupHeader
            testId="gate-readiness-status"
            title="Gate"
            status={readiness?.status ?? null}
            loading={readinessLoading}
            error={readinessError}
            counts={readiness?.counts ?? {}}
            stateOrder={GATE_STATE_ORDER}
            doneStates={GATE_DONE_STATES}
            activeState={stateFilter}
            onSelectState={selectGateChip}
          />

          <div className={styles.filters}>
            <label className={styles.filterField}>
              State
              <select
                value={stateFilter}
                onChange={(e) => setStateFilter(e.target.value)}
              >
                <option value="">All</option>
                <option value="open">open</option>
                <option value="runnable">runnable</option>
                <option value="pass">pass</option>
                <option value="fail">fail</option>
                <option value="deferred">deferred</option>
                <option value="pending-approval">pending-approval</option>
              </select>
            </label>
            <label className={styles.filterField}>
              Classification
              <select
                value={classificationFilter}
                onChange={(e) => setClassificationFilter(e.target.value)}
              >
                <option value="">All</option>
                {CLASSIFICATION_OPTIONS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.filterField}>
              Runnable
              <select
                value={runnableFilter}
                onChange={(e) => setRunnableFilter(e.target.value)}
              >
                <option value="">All</option>
                <option value="true">Runnable only</option>
                <option value="false">Not runnable</option>
              </select>
            </label>
          </div>

          {itemsLoading && <p className={styles.muted}>Loading items…</p>}
          {itemsError && <p className={styles.error}>{itemsError}</p>}
          {verifyError && <p className={styles.error}>{verifyError}</p>}

          {!itemsLoading && !itemsError && (
            <>
              <div className={styles.filters}>
                <button
                  type="button"
                  onClick={() => dispatchVerify(Array.from(selectedItemIds))}
                  disabled={selectedItemIds.size === 0}
                  data-testid="gate-verify-selected-button"
                >
                  Verify ({selectedItemIds.size})
                </button>
              </div>
              <table
                className={styles.itemsTable}
                data-testid="gate-items-table"
              >
                <thead>
                  <tr>
                    <th></th>
                    <th>Item</th>
                    <th>Classification</th>
                    <th>State</th>
                    <th>Latest disposition</th>
                    <th>Updated</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <Fragment key={item.id}>
                      <tr key={item.id} className={styles.itemRow}>
                        <td onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selectedItemIds.has(item.id)}
                            onChange={() => toggleItemSelected(item.id)}
                            aria-label={`Select ${item.text}`}
                            data-testid={`gate-item-select-${item.id}`}
                          />
                        </td>
                        <td onClick={() => toggleExpanded(item.id)}>
                          {item.text}
                        </td>
                        <td onClick={() => toggleExpanded(item.id)}>
                          {item.classification}
                        </td>
                        <td onClick={() => toggleExpanded(item.id)}>
                          {item.state}
                        </td>
                        <td onClick={() => toggleExpanded(item.id)}>
                          {item.currentDisposition ?? '—'}
                        </td>
                        <td onClick={() => toggleExpanded(item.id)}>
                          {new Date(item.updatedAt).toLocaleString()}
                        </td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            onClick={() => dispatchVerify([item.id])}
                            disabled={verifyingIds.has(item.id)}
                            data-testid={`gate-verify-item-${item.id}`}
                          >
                            {verifyingIds.has(item.id)
                              ? 'Verifying…'
                              : 'Verify'}
                          </button>
                        </td>
                      </tr>
                      {expandedId === item.id && (
                        <tr
                          key={`${item.id}-detail`}
                          className={styles.detailRow}
                        >
                          <td colSpan={7}>
                            {detailLoading && (
                              <p className={styles.muted}>Loading detail…</p>
                            )}
                            {!detailLoading && detail && (
                              <div className={styles.detailBody}>
                                <div>
                                  <strong>Sources</strong>
                                  {detail.sources.length === 0 ? (
                                    <p className={styles.muted}>None</p>
                                  ) : (
                                    <ul>
                                      {detail.sources.map((s) => (
                                        <li key={s.sourceTaskId}>
                                          {s.sourceTaskTitle}
                                          {s.mergeCommit
                                            ? ` (${s.mergeCommit.slice(0, 7)})`
                                            : ''}
                                        </li>
                                      ))}
                                    </ul>
                                  )}
                                </div>
                                <div>
                                  <strong>Event history</strong>
                                  {detail.events.length === 0 ? (
                                    <p className={styles.muted}>None</p>
                                  ) : (
                                    <ul>
                                      {detail.events.map((e, i) => (
                                        <li key={i}>
                                          {e.disposition} —{' '}
                                          {new Date(e.at).toLocaleString()}
                                          {e.operator
                                            ? ` by ${e.operator}`
                                            : ''}
                                        </li>
                                      ))}
                                    </ul>
                                  )}
                                </div>
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                  {items.length === 0 && (
                    <tr>
                      <td colSpan={7} className={styles.muted}>
                        No gate items match these filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>

              <div className={styles.pagination}>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                >
                  Previous
                </button>
                <span>
                  Page {page} of {totalPages} ({itemsTotal} items)
                </span>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                >
                  Next
                </button>
              </div>
            </>
          )}
        </>
      )}

      {selectedMilestone && (
        <>
          <RollupHeader
            testId="seed-readiness-status"
            title="Config-Seed"
            status={seedReadiness?.status ?? null}
            loading={seedReadinessLoading}
            error={seedReadinessError}
            counts={seedReadiness?.counts ?? {}}
            stateOrder={SEED_STATE_ORDER}
            doneStates={SEED_DONE_STATES}
            activeState={seedStateFilter}
            onSelectState={selectSeedChip}
          />

          <div className={styles.filters}>
            <label className={styles.filterField}>
              State
              <select
                value={seedStateFilter}
                onChange={(e) => setSeedStateFilter(e.target.value)}
              >
                <option value="">All</option>
                {SEED_STATE_ORDER.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {seedItemsLoading && <p className={styles.muted}>Loading items…</p>}
          {seedItemsError && <p className={styles.error}>{seedItemsError}</p>}

          {!seedItemsLoading && !seedItemsError && (
            <>
              <table
                className={styles.itemsTable}
                data-testid="seed-items-table"
              >
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>State</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {seedItems.map((item) => (
                    <tr key={item.id} className={styles.itemRow}>
                      <td>{item.spec}</td>
                      <td>{item.state}</td>
                      <td>{new Date(item.updatedAt).toLocaleString()}</td>
                    </tr>
                  ))}
                  {seedItems.length === 0 && (
                    <tr>
                      <td colSpan={3} className={styles.muted}>
                        No config-seed items match these filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>

              <div className={styles.pagination}>
                <button
                  type="button"
                  onClick={() => setSeedPage((p) => Math.max(1, p - 1))}
                  disabled={seedPage <= 1}
                >
                  Previous
                </button>
                <span>
                  Page {seedPage} of {seedTotalPages} ({seedItemsTotal} items)
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setSeedPage((p) => Math.min(seedTotalPages, p + 1))
                  }
                  disabled={seedPage >= seedTotalPages}
                >
                  Next
                </button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
