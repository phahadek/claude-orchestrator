import { Fragment, useState, useEffect, useCallback, useRef } from 'react';
import { gateApi } from '../api/gate';
import type {
  GateItem,
  GateItemClassification,
  GateItemDetail,
  GateItemEvidence,
  GateItemVerifySession,
  GateReadiness,
  MilestoneReadiness,
} from '../api/gate';
import { seedApi } from '../api/seed';
import type {
  SeedItem,
  SeedItemClassification,
  SeedItemEventOutcome,
  SeedReadiness,
  SeedMilestoneReadiness,
} from '../api/seed';
import { deployApi } from '../api/deploy';
import type { DeployRun, DeployRunEvent } from '../api/deploy';
import type { ClientMessage } from '@claude-orchestrator/backend/src/ws/types';
import type { ProjectConfig } from '@claude-orchestrator/backend/src/config';
import type { SessionState } from '../hooks/useSessionStore';
import { SessionPanel } from './SessionPanel';
import styles from './GateReadinessPanel.module.css';

interface Props {
  activeProjectId: string | null;
  /** Milestone display name resolved from the top bar's selected board, if any. */
  activeBoardMilestone?: string | null;
  /** Live session states, used to render a verify session's SessionPanel inline. */
  sessions?: SessionState[];
  send?: (msg: ClientMessage) => void;
  setSessionArchived?: (sessionId: string, archived: boolean) => void;
  setSessionFavorited?: (sessionId: string, favorited: boolean) => void;
  project?: ProjectConfig | null;
}

const PAGE_SIZE = 20;

const CLASSIFICATION_OPTIONS: GateItemClassification[] = [
  'needs-triage',
  'Read-Only',
  'Opportunistic',
  'Prod-Mutating',
  'Human-Observation',
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

/** Mirrors the backend's reopenGateItem guard (gateService.ts) — reopen only applies to a resolved item. */
const REOPEN_BLOCKED_STATES = new Set(['open', 'runnable', 'pending-approval']);

const SEED_STATE_ORDER = ['pending', 'applied', 'confirmed', 'blocked'];
const SEED_DONE_STATES = ['confirmed'];

const SEED_CLASSIFICATION_OPTIONS: SeedItemClassification[] = [
  'operational-seed',
  'in-pr',
  'needs-triage',
];

/** Mirrors the outcomes the POST /seed/items/:id/events route accepts (seedService.ts). */
const SEED_EVENT_OUTCOMES: SeedItemEventOutcome[] = [
  'applied',
  'confirmed',
  'blocked',
];

/**
 * Extracts the leading milestone short-token (e.g. "M12") from a board name
 * like "M12 — Orchestrator-run Planning" so it can be matched against a
 * gate's short-token milestone key.
 */
function toMilestoneToken(boardMilestone: string | null | undefined) {
  if (!boardMilestone) return null;
  const match = boardMilestone.match(/^M\d+/i);
  return match ? match[0].toUpperCase() : boardMilestone;
}

function formatEvidenceValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(formatEvidenceValue).join(', ');
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * The pass-evidence-contract downgrade's reason always starts with
 * "<disposition> disposition" (e.g. "pass disposition lacked operational
 * evidence…"), which is the only place the originally-reported disposition
 * survives once it's been downgraded to needs-setup.
 */
function deriveReportedDisposition(reason: string | undefined): string | null {
  if (!reason) return null;
  const match = reason.match(/^(pass|fail|needs-setup)\s+disposition/i);
  return match ? match[1].toLowerCase() : null;
}

function EvidenceFields({ value }: { value: unknown }) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    const text = formatEvidenceValue(value);
    return text ? <p className={styles.evidenceRow}>{text}</p> : null;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return null;
  return (
    <ul className={styles.evidenceFieldList}>
      {entries.map(([key, val]) => (
        <li key={key} className={styles.evidenceRow}>
          <span className={styles.evidenceKey}>{key}:</span>{' '}
          {formatEvidenceValue(val)}
        </li>
      ))}
    </ul>
  );
}

/** Renders a gate item event's evidence — the verifier's actual verdict — legibly, not just as the recorded disposition. */
function EventEvidence({
  evidence,
  recordedDisposition,
}: {
  evidence?: GateItemEvidence;
  recordedDisposition: string;
}) {
  if (!evidence) return null;

  if (typeof evidence === 'string') {
    return (
      <details className={styles.evidenceDetails}>
        <summary className={styles.evidenceSummary}>Evidence</summary>
        <p className={`${styles.evidenceRow} ${styles.evidenceProse}`}>
          {evidence}
        </p>
      </details>
    );
  }

  const { reason, reportedEvidence, verifierEvidence, ...rest } = evidence;
  const nested = reportedEvidence ?? verifierEvidence;
  const reportedDisposition = deriveReportedDisposition(reason);
  const hasRest = Object.keys(rest).length > 0;

  if (reason === undefined && nested === undefined && !hasRest) return null;

  return (
    <details className={styles.evidenceDetails}>
      <summary className={styles.evidenceSummary}>Evidence</summary>
      <div className={styles.evidenceBody}>
        {reportedDisposition && reportedDisposition !== recordedDisposition && (
          <p className={styles.evidenceRow}>
            Reported: <strong>{reportedDisposition}</strong> (recorded as{' '}
            {recordedDisposition})
          </p>
        )}
        {reason && <p className={styles.evidenceRow}>Reason: {reason}</p>}
        {nested !== undefined && <EvidenceFields value={nested} />}
        {hasRest && <EvidenceFields value={rest} />}
      </div>
    </details>
  );
}

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
  /** Count of items with a live verify session right now — rendered as a standalone badge, never a progress-bar segment (in-flight is not a gate_item state). */
  inFlightCount?: number;
  /** Exact count of items whose latest_disposition is needs-setup — rendered as a standalone, clickable badge (not a counts key: these items already sit inside the `runnable` chip and must stay there). */
  awaitingSetupCount?: number;
  /** Clicking the awaiting-setup badge drives the awaitingSetup list filter. */
  onSelectAwaitingSetup?: () => void;
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
  inFlightCount,
  awaitingSetupCount,
  onSelectAwaitingSetup,
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
        {!!inFlightCount && (
          <div
            className={styles.inFlightBadge}
            data-testid={`${testId}-inflight-count`}
          >
            Verifying: {inFlightCount}
          </div>
        )}
        {!!awaitingSetupCount && (
          <button
            type="button"
            className={styles.awaitingSetupBadge}
            data-testid={`${testId}-awaiting-setup-count`}
            onClick={onSelectAwaitingSetup}
            title="Items whose latest verification attempt abstained with needs-setup — still runnable, but excluded from every automated pull until an operator resolves the setup gap."
          >
            Awaiting setup: {awaitingSetupCount}
          </button>
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
  sessions = [],
  send = () => {},
  setSessionArchived = () => {},
  setSessionFavorited = () => {},
  project = null,
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
  const [awaitingSetupFilter, setAwaitingSetupFilter] = useState('');
  const [page, setPage] = useState(1);

  const [items, setItems] = useState<GateItem[]>([]);
  const [itemsTotal, setItemsTotal] = useState(0);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [itemsError, setItemsError] = useState<string | null>(null);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<GateItemDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [verifySessions, setVerifySessions] = useState<GateItemVerifySession[]>(
    [],
  );
  const [expandedVerifySessionIds, setExpandedVerifySessionIds] = useState<
    Set<string>
  >(new Set());

  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(
    new Set(),
  );
  const [verifyingIds, setVerifyingIds] = useState<Set<string>>(new Set());
  const [verifyBaseline, setVerifyBaseline] = useState<
    Record<string, string | undefined>
  >({});
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const [operatorName, setOperatorName] = useState('');
  const [dispositionMutatingIds, setDispositionMutatingIds] = useState<
    Set<string>
  >(new Set());
  const [dispositionError, setDispositionError] = useState<string | null>(null);

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
  const [seedClassificationFilter, setSeedClassificationFilter] =
    useState('');
  const [seedPage, setSeedPage] = useState(1);

  const [seedItems, setSeedItems] = useState<SeedItem[]>([]);
  const [seedItemsTotal, setSeedItemsTotal] = useState(0);
  const [seedItemsLoading, setSeedItemsLoading] = useState(false);
  const [seedItemsError, setSeedItemsError] = useState<string | null>(null);

  const [seedDispositionMutatingIds, setSeedDispositionMutatingIds] = useState<
    Set<string>
  >(new Set());
  const [seedDispositionError, setSeedDispositionError] = useState<
    string | null
  >(null);

  const [deployLaunching, setDeployLaunching] = useState(false);
  const [deployLaunchError, setDeployLaunchError] = useState<string | null>(
    null,
  );
  const [deployRun, setDeployRun] = useState<DeployRun | null>(null);
  const [deployEvents, setDeployEvents] = useState<DeployRunEvent[]>([]);
  const [dismissedDeployRunId, setDismissedDeployRunId] = useState<
    string | null
  >(null);

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
          const topBarMilestoneToken = toMilestoneToken(
            activeBoardMilestoneRef.current,
          );
          if (
            topBarMilestoneToken &&
            result.some((m) => m.milestone === topBarMilestoneToken)
          ) {
            return topBarMilestoneToken;
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
    const topBarMilestoneToken = toMilestoneToken(activeBoardMilestone);
    if (
      topBarMilestoneToken &&
      milestones.some((m) => m.milestone === topBarMilestoneToken)
    ) {
      setSelectedMilestone(topBarMilestoneToken);
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
    if (!selectedMilestone || !activeProjectId) {
      setReadiness(null);
      return;
    }
    let cancelled = false;
    setReadinessLoading(true);
    setReadinessError(null);
    gateApi
      .getGateReadiness(activeProjectId, selectedMilestone)
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
  }, [activeProjectId, selectedMilestone]);

  // Load config-seed readiness (green/blocked + per-state counts) for the selected milestone.
  useEffect(() => {
    if (!selectedMilestone || !activeProjectId) {
      setSeedReadiness(null);
      return;
    }
    let cancelled = false;
    setSeedReadinessLoading(true);
    setSeedReadinessError(null);
    seedApi
      .getSeedReadiness(activeProjectId, selectedMilestone)
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
  }, [activeProjectId, selectedMilestone]);

  // Reset to page 1 whenever the milestone or filters change.
  useEffect(() => {
    setPage(1);
  }, [
    selectedMilestone,
    stateFilter,
    classificationFilter,
    runnableFilter,
    awaitingSetupFilter,
  ]);

  // Reset seed items to page 1 whenever the milestone or seed filter changes.
  useEffect(() => {
    setSeedPage(1);
  }, [selectedMilestone, seedStateFilter, seedClassificationFilter]);

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
        awaitingSetup:
          awaitingSetupFilter === ''
            ? undefined
            : awaitingSetupFilter === 'true',
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
    awaitingSetupFilter,
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
        classification: seedClassificationFilter || undefined,
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
  }, [
    activeProjectId,
    selectedMilestone,
    seedStateFilter,
    seedClassificationFilter,
    seedPage,
  ]);

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

  const toggleExpanded = useCallback(
    (id: string) => {
      if (expandedId === id) {
        setExpandedId(null);
        setDetail(null);
        setVerifySessions([]);
        return;
      }
      setExpandedId(id);
      setDetail(null);
      setDetailLoading(true);
      setVerifySessions([]);
      gateApi
        .getGateItemDetail(id)
        .then((result) => setDetail(result))
        .catch(() => setDetail(null))
        .finally(() => setDetailLoading(false));
      gateApi
        .getVerifySessions(id)
        .then((result) => setVerifySessions(result))
        .catch(() => setVerifySessions([]));
    },
    [expandedId],
  );

  const jumpToSession = useCallback((sessionId: string) => {
    window.dispatchEvent(
      new CustomEvent('selectSession', { detail: { sessionId } }),
    );
  }, []);

  const toggleVerifySessionExpanded = useCallback((itemId: string) => {
    setExpandedVerifySessionIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }, []);

  const toggleItemSelected = useCallback((id: string) => {
    setSelectedItemIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Select All adds every currently-shown (filtered) gate item to the
  // existing verify selection; Clear empties it.
  const selectAllItems = useCallback(() => {
    setSelectedItemIds((prev) => {
      const next = new Set(prev);
      for (const item of items) next.add(item.id);
      return next;
    });
  }, [items]);

  const clearItemSelection = useCallback(() => {
    setSelectedItemIds(new Set());
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
          next[id] = items.find((i) => i.id === id)?.latestDisposition;
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

  // Polls each in-flight verification's item detail until its latest
  // disposition moves away from the dispatch-time baseline, reflecting the
  // resulting disposition back into the table without a full-page refresh.
  // latestDisposition (not currentDisposition) is the baseline/compare field
  // so a non-resolving needs-setup verdict — which never advances
  // currentDisposition — still settles the poll.
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
        // Computed up front from `results` (not mutated from inside the
        // setItems updater below and read back synchronously afterward) —
        // a functional setState updater runs on React's own schedule, not
        // necessarily before the next line of this callback, so relying on
        // a side effect inside it to communicate back was a race that could
        // leave verifyingIds never cleared despite the table already
        // reflecting the settled disposition.
        const settled = results
          .filter(
            (r): r is { id: string; detail: GateItemDetail } =>
              r !== null &&
              r.detail.item.latestDisposition !== verifyBaseline[r.id],
          )
          .map((r) => r.id);
        if (settled.length === 0) return;
        setItems((prevItems) =>
          prevItems.map((item) => {
            const found = results.find((r) => r && r.id === item.id);
            if (!found || !settled.includes(item.id)) return item;
            return {
              ...item,
              currentDisposition: found.detail.item.currentDisposition,
              latestDisposition: found.detail.item.latestDisposition,
              state: found.detail.item.state,
              updatedAt: found.detail.item.updatedAt,
            };
          }),
        );
        setVerifyingIds((prev) => {
          const next = new Set(prev);
          settled.forEach((id) => next.delete(id));
          return next;
        });
      });
    }, 5000);
    return () => clearInterval(interval);
  }, [verifyingIds, verifyBaseline]);

  // Reflects a mutated gate item back into the table/expanded-detail and
  // re-reads the milestone's readiness rollup — the state machine itself
  // lives entirely server-side (appendGateItemEvent / reopenGateItem); this
  // only re-syncs the UI to whatever it decided.
  const applyItemMutation = useCallback(
    (updated: GateItem) => {
      setItems((prev) =>
        prev.map((item) =>
          item.id === updated.id ? { ...item, ...updated } : item,
        ),
      );
      if (expandedId === updated.id) {
        gateApi
          .getGateItemDetail(updated.id)
          .then((result) => setDetail(result))
          .catch(() => {});
      }
      if (selectedMilestone && activeProjectId) {
        gateApi
          .getGateReadiness(activeProjectId, selectedMilestone)
          .then((result) => setReadiness(result))
          .catch(() => {});
      }
    },
    [expandedId, selectedMilestone, activeProjectId],
  );

  const withDispositionMutation = useCallback(
    (id: string, run: () => Promise<GateItem>) => {
      setDispositionError(null);
      setDispositionMutatingIds((prev) => new Set(prev).add(id));
      return run()
        .then((updated) => {
          applyItemMutation(updated);
        })
        .catch((err) => {
          setDispositionError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          setDispositionMutatingIds((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        });
    },
    [applyItemMutation],
  );

  // Reflects a mutated seed item back into the table and re-reads the
  // milestone's seed readiness rollup — mirrors applyItemMutation above, but
  // for the seed axis, whose state machine lives in seedService.ts.
  const applySeedItemMutation = useCallback(
    (updated: SeedItem) => {
      setSeedItems((prev) =>
        prev.map((item) =>
          item.id === updated.id ? { ...item, ...updated } : item,
        ),
      );
      if (selectedMilestone && activeProjectId) {
        seedApi
          .getSeedReadiness(activeProjectId, selectedMilestone)
          .then((result) => setSeedReadiness(result))
          .catch(() => {});
      }
    },
    [selectedMilestone, activeProjectId],
  );

  const withSeedDispositionMutation = useCallback(
    (id: string, run: () => Promise<SeedItem>) => {
      setSeedDispositionError(null);
      setSeedDispositionMutatingIds((prev) => new Set(prev).add(id));
      return run()
        .then((updated) => {
          applySeedItemMutation(updated);
        })
        .catch((err) => {
          setSeedDispositionError(
            err instanceof Error ? err.message : String(err),
          );
        })
        .finally(() => {
          setSeedDispositionMutatingIds((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        });
    },
    [applySeedItemMutation],
  );

  const recordSeedDisposition = useCallback(
    (id: string, outcome: SeedItemEventOutcome, filedFollowon?: string) => {
      withSeedDispositionMutation(id, () =>
        seedApi.recordSeedItemEvent(id, {
          outcome,
          filedFollowon,
          operator: operatorName || undefined,
        }),
      );
    },
    [withSeedDispositionMutation, operatorName],
  );

  // The `blocked` outcome requires a filedFollowon (appendSeedItemEvent's
  // guard) — prompt for it up front rather than letting the POST 400.
  const blockSeedItemHandler = useCallback(
    (item: SeedItem) => {
      const filedFollowon = window.prompt(
        `Record "${item.spec}" as blocked — enter the follow-on task ID:`,
      );
      if (!filedFollowon) return;
      recordSeedDisposition(item.id, 'blocked', filedFollowon);
    },
    [recordSeedDisposition],
  );

  const recordDisposition = useCallback(
    (id: string, disposition: 'pass' | 'fail' | 'deferred') => {
      withDispositionMutation(id, () =>
        gateApi.recordEvent(id, {
          disposition,
          operator: operatorName || undefined,
        }),
      );
    },
    [withDispositionMutation, operatorName],
  );

  const reopenItemHandler = useCallback(
    (item: GateItem) => {
      if (
        item.state === 'pass' &&
        !window.confirm(
          `Reopen "${item.text}"? It currently passes — reopening will pull it back to open for re-verification.`,
        )
      ) {
        return;
      }
      withDispositionMutation(item.id, () =>
        gateApi.reopenItem(item.id, { operator: operatorName || undefined }),
      );
    },
    [withDispositionMutation, operatorName],
  );

  const approveItemHandler = useCallback(
    (id: string) => {
      withDispositionMutation(id, () =>
        gateApi.approveItem(id, { operator: operatorName || undefined }),
      );
    },
    [withDispositionMutation, operatorName],
  );

  const reclassifyItemHandler = useCallback(
    (id: string, classification: GateItemClassification) => {
      withDispositionMutation(id, () =>
        gateApi.reclassifyItem(id, {
          classification,
          operator: operatorName || undefined,
        }),
      );
    },
    [withDispositionMutation, operatorName],
  );

  const selectGateChip = useCallback((state: string) => {
    setStateFilter(state);
    setRunnableFilter('');
    setAwaitingSetupFilter('');
  }, []);

  const selectAwaitingSetupFilter = useCallback(() => {
    setStateFilter('');
    setRunnableFilter('');
    setAwaitingSetupFilter('true');
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
          {deployLaunchError && (
            <p className={styles.error}>{deployLaunchError}</p>
          )}
          {deployRun &&
            deployRun.status === 'failed' &&
            deployRun.run_id !== dismissedDeployRunId &&
            (() => {
              const failedEvent = [...deployEvents]
                .reverse()
                .find((ev) => ev.event_type === 'step_failed');
              return (
                <p
                  className={styles.error}
                  data-testid="deploy-run-failure-reason"
                >
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
            deployEvents.length > 0 && (
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
            inFlightCount={items.filter((item) => item.verifyInFlight).length}
            awaitingSetupCount={readiness?.awaitingSetupCount ?? 0}
            onSelectAwaitingSetup={selectAwaitingSetupFilter}
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
            <label className={styles.filterField}>
              Awaiting setup
              <select
                value={awaitingSetupFilter}
                onChange={(e) => setAwaitingSetupFilter(e.target.value)}
                data-testid="gate-awaiting-setup-filter"
              >
                <option value="">All</option>
                <option value="true">Awaiting setup only</option>
                <option value="false">Not awaiting setup</option>
              </select>
            </label>
          </div>

          {itemsLoading && <p className={styles.muted}>Loading items…</p>}
          {itemsError && <p className={styles.error}>{itemsError}</p>}
          {verifyError && <p className={styles.error}>{verifyError}</p>}
          {dispositionError && (
            <p className={styles.error} data-testid="gate-disposition-error">
              {dispositionError}
            </p>
          )}

          {!itemsLoading && !itemsError && (
            <>
              <div className={styles.filters}>
                <label className={styles.filterField}>
                  Operator
                  <input
                    type="text"
                    value={operatorName}
                    onChange={(e) => setOperatorName(e.target.value)}
                    placeholder="you@example.com"
                    data-testid="gate-operator-input"
                  />
                </label>
                <button
                  type="button"
                  onClick={selectAllItems}
                  disabled={items.length === 0}
                  data-testid="gate-select-all-button"
                >
                  Select All
                </button>
                <button
                  type="button"
                  onClick={clearItemSelection}
                  disabled={selectedItemIds.size === 0}
                  data-testid="gate-clear-selection-button"
                >
                  Clear
                </button>
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
                      <tr
                        key={item.id}
                        className={`${styles.itemRow} ${
                          item.latestDisposition === 'needs-setup'
                            ? styles.awaitingSetupRow
                            : ''
                        }`}
                      >
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
                          {item.latestDisposition === 'needs-setup' && (
                            <span
                              className={styles.awaitingSetupIndicator}
                              data-testid={`gate-item-awaiting-setup-${item.id}`}
                              title="Latest verification attempt abstained with needs-setup"
                            >
                              ⚠ awaiting setup
                            </span>
                          )}
                          {item.verifyInFlight && (
                            <span
                              className={styles.inFlightIndicator}
                              data-testid={`gate-item-inflight-${item.id}`}
                              title="A verify session is running right now"
                            >
                              ● verifying
                            </span>
                          )}
                        </td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <select
                            value={item.classification}
                            onChange={(e) =>
                              reclassifyItemHandler(
                                item.id,
                                e.target.value as GateItemClassification,
                              )
                            }
                            disabled={dispositionMutatingIds.has(item.id)}
                            aria-label={`Reclassify ${item.text}`}
                            data-testid={`gate-item-reclassify-${item.id}`}
                            className={styles.reclassifySelect}
                          >
                            {CLASSIFICATION_OPTIONS.map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td onClick={() => toggleExpanded(item.id)}>
                          {item.state}
                        </td>
                        <td onClick={() => toggleExpanded(item.id)}>
                          {item.latestDisposition ?? '—'}
                        </td>
                        <td onClick={() => toggleExpanded(item.id)}>
                          {new Date(item.updatedAt).toLocaleString()}
                        </td>
                        <td
                          onClick={(e) => e.stopPropagation()}
                          className={styles.itemActions}
                        >
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
                          <button
                            type="button"
                            onClick={() => recordDisposition(item.id, 'pass')}
                            disabled={dispositionMutatingIds.has(item.id)}
                            data-testid={`gate-item-pass-${item.id}`}
                          >
                            Pass
                          </button>
                          <button
                            type="button"
                            onClick={() => recordDisposition(item.id, 'fail')}
                            disabled={dispositionMutatingIds.has(item.id)}
                            data-testid={`gate-item-fail-${item.id}`}
                          >
                            Fail
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              recordDisposition(item.id, 'deferred')
                            }
                            disabled={dispositionMutatingIds.has(item.id)}
                            data-testid={`gate-item-defer-${item.id}`}
                          >
                            Defer
                          </button>
                          {!REOPEN_BLOCKED_STATES.has(item.state) && (
                            <button
                              type="button"
                              onClick={() => reopenItemHandler(item)}
                              disabled={dispositionMutatingIds.has(item.id)}
                              data-testid={`gate-item-reopen-${item.id}`}
                            >
                              Reopen
                            </button>
                          )}
                          {item.state === 'pending-approval' && (
                            <button
                              type="button"
                              onClick={() => approveItemHandler(item.id)}
                              disabled={dispositionMutatingIds.has(item.id)}
                              data-testid={`gate-item-approve-${item.id}`}
                            >
                              Approve
                            </button>
                          )}
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
                                {verifySessions.length > 0 && (
                                  <div data-testid="gate-item-verify-session">
                                    <strong>Verify session</strong>
                                    <p>
                                      {verifySessions[0].sessionStatus}
                                      {' — '}
                                      <button
                                        type="button"
                                        onClick={() =>
                                          jumpToSession(
                                            verifySessions[0].sessionId,
                                          )
                                        }
                                        data-testid={`gate-item-verify-session-jump-${item.id}`}
                                      >
                                        View session
                                      </button>{' '}
                                      <button
                                        type="button"
                                        onClick={() =>
                                          toggleVerifySessionExpanded(item.id)
                                        }
                                        aria-expanded={expandedVerifySessionIds.has(
                                          item.id,
                                        )}
                                        data-testid={`gate-item-verify-session-toggle-${item.id}`}
                                      >
                                        {expandedVerifySessionIds.has(item.id)
                                          ? '▼ Hide session'
                                          : '▶ Show session'}
                                      </button>
                                    </p>
                                    {expandedVerifySessionIds.has(item.id) && (
                                      <div
                                        data-testid={`gate-item-verify-session-body-${item.id}`}
                                      >
                                        {(() => {
                                          const liveSession = sessions.find(
                                            (s) =>
                                              s.sessionId ===
                                              verifySessions[0].sessionId,
                                          );
                                          return liveSession ? (
                                            <SessionPanel
                                              session={liveSession}
                                              send={send}
                                              setSessionArchived={
                                                setSessionArchived
                                              }
                                              setSessionFavorited={
                                                setSessionFavorited
                                              }
                                              project={project}
                                              showTaskName={false}
                                            />
                                          ) : (
                                            <p className={styles.muted}>
                                              Transcript not available — session
                                              not loaded.
                                            </p>
                                          );
                                        })()}
                                      </div>
                                    )}
                                  </div>
                                )}
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
                                    <ul className={styles.eventList}>
                                      {detail.events.map((e, i) => (
                                        <li
                                          key={i}
                                          className={styles.eventItem}
                                        >
                                          {e.disposition} —{' '}
                                          {new Date(e.at).toLocaleString()}
                                          {e.operator
                                            ? ` by ${e.operator}`
                                            : ''}
                                          <EventEvidence
                                            evidence={e.evidence}
                                            recordedDisposition={e.disposition}
                                          />
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
            <label className={styles.filterField}>
              Classification
              <select
                value={seedClassificationFilter}
                onChange={(e) => setSeedClassificationFilter(e.target.value)}
                data-testid="seed-classification-filter"
              >
                <option value="">All</option>
                {SEED_CLASSIFICATION_OPTIONS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {seedItemsLoading && <p className={styles.muted}>Loading items…</p>}
          {seedItemsError && <p className={styles.error}>{seedItemsError}</p>}
          {seedDispositionError && (
            <p className={styles.error} data-testid="seed-disposition-error">
              {seedDispositionError}
            </p>
          )}

          {!seedItemsLoading && !seedItemsError && (
            <>
              <table
                className={styles.itemsTable}
                data-testid="seed-items-table"
              >
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Classification</th>
                    <th>State</th>
                    <th>Updated</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {seedItems.map((item) => (
                    <tr key={item.id} className={styles.itemRow}>
                      <td>{item.spec}</td>
                      <td>{item.classification ?? ''}</td>
                      <td>{item.state}</td>
                      <td>{new Date(item.updatedAt).toLocaleString()}</td>
                      <td className={styles.itemActions}>
                        {SEED_EVENT_OUTCOMES.map((outcome) =>
                          outcome === 'blocked' ? (
                            <button
                              key={outcome}
                              type="button"
                              onClick={() => blockSeedItemHandler(item)}
                              disabled={seedDispositionMutatingIds.has(item.id)}
                              data-testid={`seed-item-blocked-${item.id}`}
                            >
                              Blocked
                            </button>
                          ) : (
                            <button
                              key={outcome}
                              type="button"
                              onClick={() =>
                                recordSeedDisposition(item.id, outcome)
                              }
                              disabled={seedDispositionMutatingIds.has(item.id)}
                              data-testid={`seed-item-${outcome}-${item.id}`}
                            >
                              {outcome === 'applied' ? 'Applied' : 'Confirmed'}
                            </button>
                          ),
                        )}
                      </td>
                    </tr>
                  ))}
                  {seedItems.length === 0 && (
                    <tr>
                      <td colSpan={5} className={styles.muted}>
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
