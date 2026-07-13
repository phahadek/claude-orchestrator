import { Fragment, useState, useEffect, useCallback } from 'react';
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
import styles from './GateReadinessPanel.module.css';

interface Props {
  activeProjectId: string | null;
}

const PAGE_SIZE = 20;

const CLASSIFICATION_OPTIONS: GateItemClassification[] = [
  'needs-triage',
  'Read-Only',
  'Opportunistic',
  'Prod-Mutating',
];

const SEED_STATE_OPTIONS = ['pending', 'applied', 'confirmed', 'blocked'];

export function GateReadinessPanel({ activeProjectId }: Props) {
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
  const [runnableFilter, setRunnableFilter] = useState('');
  const [page, setPage] = useState(1);

  const [items, setItems] = useState<GateItem[]>([]);
  const [itemsTotal, setItemsTotal] = useState(0);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [itemsError, setItemsError] = useState<string | null>(null);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<GateItemDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

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
        setSelectedMilestone((current) =>
          current && result.some((m) => m.milestone === current)
            ? current
            : (result[0]?.milestone ?? null),
        );
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

  // Load readiness (green/blocked + blocking set) for the selected milestone.
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

  // Load config-seed readiness (green/blocked + blocking set) for the selected milestone.
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

      {selectedMilestone && (
        <div className={styles.readinessRow}>
          <div
            className={styles.readinessCard}
            data-testid="gate-readiness-status"
          >
            <h3 className={styles.readinessCardTitle}>Gate</h3>
            {readinessLoading && (
              <p className={styles.muted}>Loading readiness…</p>
            )}
            {readinessError && <p className={styles.error}>{readinessError}</p>}
            {readiness && (
              <>
                <div
                  className={`${styles.statusBadge} ${
                    readiness.status === 'green'
                      ? styles.statusGreen
                      : styles.statusBlocked
                  }`}
                >
                  {readiness.status === 'green'
                    ? '✅ Green — ready'
                    : '🚫 Blocked'}
                </div>
                {readiness.status === 'blocked' && (
                  <ul className={styles.blockingList}>
                    {readiness.blocking.map((b) => (
                      <li key={b.id} className={styles.blockingItem}>
                        <span className={styles.blockingState}>{b.state}</span>
                        <span className={styles.blockingText}>{b.text}</span>
                        <span className={styles.blockingClassification}>
                          {b.classification}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>

          <div
            className={styles.readinessCard}
            data-testid="seed-readiness-status"
          >
            <h3 className={styles.readinessCardTitle}>Config-Seed</h3>
            {seedReadinessLoading && (
              <p className={styles.muted}>Loading readiness…</p>
            )}
            {seedReadinessError && (
              <p className={styles.error}>{seedReadinessError}</p>
            )}
            {seedReadiness && (
              <>
                <div
                  className={`${styles.statusBadge} ${
                    seedReadiness.status === 'green'
                      ? styles.statusGreen
                      : styles.statusBlocked
                  }`}
                >
                  {seedReadiness.status === 'green'
                    ? '✅ Green — ready'
                    : '🚫 Blocked'}
                </div>
                {seedReadiness.status === 'blocked' && (
                  <ul className={styles.blockingList}>
                    {seedReadiness.blocking.map((b) => (
                      <li key={b.id} className={styles.blockingItem}>
                        <span className={styles.blockingState}>{b.state}</span>
                        <span className={styles.blockingText}>{b.spec}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {selectedMilestone && (
        <>
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

          {!itemsLoading && !itemsError && (
            <>
              <table
                className={styles.itemsTable}
                data-testid="gate-items-table"
              >
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Classification</th>
                    <th>State</th>
                    <th>Latest disposition</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <Fragment key={item.id}>
                      <tr
                        key={item.id}
                        className={styles.itemRow}
                        onClick={() => toggleExpanded(item.id)}
                      >
                        <td>{item.text}</td>
                        <td>{item.classification}</td>
                        <td>{item.state}</td>
                        <td>{item.currentDisposition ?? '—'}</td>
                        <td>{new Date(item.updatedAt).toLocaleString()}</td>
                      </tr>
                      {expandedId === item.id && (
                        <tr
                          key={`${item.id}-detail`}
                          className={styles.detailRow}
                        >
                          <td colSpan={5}>
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
                      <td colSpan={5} className={styles.muted}>
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
          <h3 className={styles.readinessCardTitle}>Config-Seed Items</h3>
          <div className={styles.filters}>
            <label className={styles.filterField}>
              State
              <select
                value={seedStateFilter}
                onChange={(e) => setSeedStateFilter(e.target.value)}
              >
                <option value="">All</option>
                {SEED_STATE_OPTIONS.map((s) => (
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
