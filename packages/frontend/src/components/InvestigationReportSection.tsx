import { useCallback, useEffect, useState } from 'react';
import type {
  InvestigationReport,
  InvestigationReportState,
} from '../api/reports';
import { reportsApi } from '../api/reports';
import { investigateApi } from '../api/investigate';
import panelStyles from './DecisionPanel.module.css';
import styles from './InvestigationReportSection.module.css';

interface Props {
  projectId: string;
  milestone: string;
  /** The currently drill-down-selected report id, if any — highlights that card. */
  selectedReportId?: string | null;
  /** Selects a report card *and* jumps the drill-down straight to session mode — the card-level click handler, mirroring the inbox's onSelectIntent wiring. */
  onSelectReport?: (report: InvestigationReport) => void;
}

const STATE_ORDER: InvestigationReportState[] = [
  'draft',
  'committed',
  'resolved',
  'abandoned',
];

const STATE_LABELS: Record<InvestigationReportState, string> = {
  draft: 'Draft',
  committed: 'Committed',
  resolved: 'Resolved',
  abandoned: 'Abandoned',
};

/**
 * A committed report blocks milestone convergence until it resolves or is
 * abandoned (reportStore.ts's blocksMilestoneConvergence) — a draft hasn't
 * entered the gate yet, so only 'committed' is shown as blocking here,
 * mirroring GateReadinessPanel's gate_item 🚫 Blocked badge.
 */
function isConvergenceBlocking(report: InvestigationReport): boolean {
  return report.state === 'committed';
}

/** A committed report with no live dispatch is the operator's batch-select candidate — mirrors reportStore.ts's isDispatchEligible. */
function isDispatchEligible(report: InvestigationReport): boolean {
  return report.state === 'committed' && !report.inFlight;
}

/**
 * This report's title is always report.title — never resolved through
 * cardLabelFor/isGateVerifyIntent's gate-item-text lookup (the source of
 * the inbox's known gate.verify mis-titling defect), since a report is not
 * a staged_intent and carries no gate item ref at all. Its refresh is its
 * own local fetch/poll effect below, entirely independent of
 * useDecisionQueue's staged-intent staleness handling (the inbox's other
 * known defect) — this section shares no fetch/refresh code path with it.
 */
export function InvestigationReportSection({
  projectId,
  milestone,
  selectedReportId = null,
  onSelectReport,
}: Props) {
  const [reports, setReports] = useState<InvestigationReport[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [stateFilter, setStateFilter] = useState<
    InvestigationReportState | 'all'
  >('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drafting, setDrafting] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftSymptom, setDraftSymptom] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [actionInFlightId, setActionInFlightId] = useState<string | null>(null);
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [dispatching, setDispatching] = useState(false);
  const [dispatchError, setDispatchError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    return reportsApi
      .list({ project: projectId, milestone, limit: 100 })
      .then((res) => setReports(res.items))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [projectId, milestone]);

  useEffect(() => {
    setLoaded(false);
    void refresh();
  }, [refresh]);

  // Poll while at least one report has a live dispatched session — reports
  // have no changed-event bus (unlike staged_intent's WS push), so in-flight
  // status is refreshed by re-fetching, same idea as GateReadinessPanel's
  // active-deploy-run poll.
  useEffect(() => {
    if (!reports.some((r) => r.inFlight)) return;
    const interval = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(interval);
  }, [reports, refresh]);

  useEffect(() => {
    setSelected((prev) => {
      const liveIds = new Set(reports.map((r) => r.id));
      let changed = false;
      const next = new Set<string>();
      prev.forEach((id) => {
        if (liveIds.has(id)) next.add(id);
        else changed = true;
      });
      return changed ? next : prev;
    });
  }, [reports]);

  const startDraft = () => {
    setDrafting(true);
    setDraftTitle('');
    setDraftSymptom('');
    setCreateError(null);
  };

  const submitDraft = () => {
    if (!draftTitle.trim() || !draftSymptom.trim()) {
      setCreateError('Title and symptom are both required');
      return;
    }
    setCreating(true);
    setCreateError(null);
    reportsApi
      .create({
        projectId,
        milestoneId: milestone,
        title: draftTitle.trim(),
        symptomText: draftSymptom.trim(),
        source: 'operator',
      })
      .then((report) => {
        setReports((prev) => [report, ...prev]);
        setDrafting(false);
      })
      .catch((err) =>
        setCreateError(
          err instanceof Error ? err.message : 'failed to create report',
        ),
      )
      .finally(() => setCreating(false));
  };

  const commit = (id: string) => {
    setActionInFlightId(id);
    setActionErrors((prev) => ({ ...prev, [id]: '' }));
    reportsApi
      .commit(id)
      .then((report) =>
        setReports((prev) => prev.map((r) => (r.id === id ? report : r))),
      )
      .catch((err) =>
        setActionErrors((prev) => ({
          ...prev,
          [id]: err instanceof Error ? err.message : 'commit failed',
        })),
      )
      .finally(() => setActionInFlightId(null));
  };

  const abandon = (id: string) => {
    setActionInFlightId(id);
    setActionErrors((prev) => ({ ...prev, [id]: '' }));
    reportsApi
      .abandon(id)
      .then((report) =>
        setReports((prev) => prev.map((r) => (r.id === id ? report : r))),
      )
      .catch((err) =>
        setActionErrors((prev) => ({
          ...prev,
          [id]: err instanceof Error ? err.message : 'abandon failed',
        })),
      )
      .finally(() => setActionInFlightId(null));
  };

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const dispatchSelected = () => {
    const reportIds = [...selected];
    if (reportIds.length === 0) return;
    setDispatching(true);
    setDispatchError(null);
    investigateApi
      .launch(reportIds)
      .then(() => {
        setSelected(new Set());
        return refresh();
      })
      .catch((err) =>
        setDispatchError(
          err instanceof Error ? err.message : 'investigate dispatch failed',
        ),
      )
      .finally(() => setDispatching(false));
  };

  if (!loaded) return null;

  const filtered =
    stateFilter === 'all'
      ? reports
      : reports.filter((r) => r.state === stateFilter);

  return (
    <div className={styles.section} data-testid="investigation-report-section">
      <div className={styles.heading}>
        <span>Investigation reports ({reports.length})</span>
        <button
          type="button"
          className={styles.newReportButton}
          onClick={startDraft}
          disabled={drafting}
          data-testid="report-start-draft"
        >
          + New report
        </button>
      </div>

      <div className={styles.stateTabs} role="tablist">
        <button
          type="button"
          className={`${styles.stateTab} ${
            stateFilter === 'all' ? styles.stateTabActive : ''
          }`}
          onClick={() => setStateFilter('all')}
          data-testid="report-filter-all"
        >
          All ({reports.length})
        </button>
        {STATE_ORDER.map((state) => {
          const count = reports.filter((r) => r.state === state).length;
          return (
            <button
              key={state}
              type="button"
              className={`${styles.stateTab} ${
                stateFilter === state ? styles.stateTabActive : ''
              }`}
              onClick={() => setStateFilter(state)}
              data-testid={`report-filter-${state}`}
            >
              {STATE_LABELS[state]} ({count})
            </button>
          );
        })}
      </div>

      {selected.size > 0 && (
        <div className={styles.batchBar} data-testid="report-batch-bar">
          <span>{selected.size} selected for dispatch</span>
          <button
            type="button"
            onClick={dispatchSelected}
            disabled={dispatching}
            data-testid="report-batch-dispatch"
          >
            {dispatching ? 'Launching…' : 'Investigate Selected'}
          </button>
          <button
            type="button"
            className={styles.clearSelectionButton}
            onClick={() => setSelected(new Set())}
            disabled={dispatching}
            data-testid="report-batch-clear"
          >
            Clear
          </button>
          {dispatchError && (
            <span
              className={styles.actionError}
              data-testid="report-batch-dispatch-error"
            >
              {dispatchError}
            </span>
          )}
        </div>
      )}

      {drafting && (
        <div className={panelStyles.group} data-testid="report-draft-form">
          <div className={panelStyles.groupHeader}>
            <span>New investigation report</span>
          </div>
          <input
            type="text"
            className={styles.draftInput}
            placeholder="Title"
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            data-testid="report-draft-title"
          />
          <textarea
            className={styles.draftTextarea}
            placeholder="Symptom"
            value={draftSymptom}
            onChange={(e) => setDraftSymptom(e.target.value)}
            data-testid="report-draft-symptom"
          />
          {createError && (
            <div className={styles.actionError}>{createError}</div>
          )}
          <div className={styles.draftActions}>
            <button
              type="button"
              onClick={submitDraft}
              disabled={creating}
              data-testid="report-draft-submit"
            >
              {creating ? 'Saving…' : 'Save draft'}
            </button>
            <button
              type="button"
              onClick={() => setDrafting(false)}
              disabled={creating}
              data-testid="report-draft-cancel"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {filtered.map((report) => {
        const blocking = isConvergenceBlocking(report);
        return (
          <div
            key={report.id}
            className={`${panelStyles.group}${
              blocking ? ` ${styles.blockingCard}` : ''
            }${selectedReportId === report.id ? ` ${styles.selectedCard}` : ''}`}
            onClick={onSelectReport ? () => onSelectReport(report) : undefined}
            data-testid={`report-card-${report.id}`}
          >
            <div className={panelStyles.groupHeader}>
              {isDispatchEligible(report) && (
                <input
                  type="checkbox"
                  checked={selected.has(report.id)}
                  onChange={() => toggleSelected(report.id)}
                  onClick={(e) => e.stopPropagation()}
                  aria-label={`Select ${report.title}`}
                  data-testid={`report-select-${report.id}`}
                />
              )}
              <span className={styles.cardTitle}>{report.title}</span>
              <span
                className={styles.stateBadge}
                data-testid={`report-state-${report.id}`}
              >
                {STATE_LABELS[report.state]}
              </span>
              {blocking && (
                <span
                  className={styles.blockingBadge}
                  data-testid={`report-blocking-${report.id}`}
                  title="Committed and not yet resolved or abandoned — blocks milestone convergence"
                >
                  🚫 Blocking convergence
                </span>
              )}
              {report.inFlight && (
                <span
                  className={styles.inFlightBadge}
                  data-testid={`report-inflight-${report.id}`}
                  title="A dispatched session is running right now"
                >
                  ● dispatched
                </span>
              )}
            </div>
            <div className={styles.symptomText}>{report.symptom_text}</div>
            {actionErrors[report.id] && (
              <div className={styles.actionError}>
                {actionErrors[report.id]}
              </div>
            )}
            <div className={styles.cardActions}>
              {report.state === 'draft' && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    commit(report.id);
                  }}
                  disabled={actionInFlightId === report.id}
                  data-testid={`report-commit-${report.id}`}
                >
                  {actionInFlightId === report.id ? 'Committing…' : 'Commit'}
                </button>
              )}
              {(report.state === 'draft' || report.state === 'committed') && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    abandon(report.id);
                  }}
                  disabled={actionInFlightId === report.id}
                  data-testid={`report-abandon-${report.id}`}
                >
                  Abandon
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
