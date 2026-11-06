import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, ClipboardEvent, KeyboardEvent } from 'react';
import type {
  InvestigationReport,
  InvestigationReportState,
} from '../api/reports';
import { reportsApi } from '../api/reports';
import { investigateApi } from '../api/investigate';
import { fetchAuthenticatedImageUrl } from '../api/projects';
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

/** draft + committed — reports still in-play, as opposed to resolved/abandoned terminal states. */
const ACTIVE_STATES: InvestigationReportState[] = ['draft', 'committed'];

type ReportFilter = InvestigationReportState | 'all' | 'active' | 'dispatched';

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
  const [stateFilter, setStateFilter] = useState<ReportFilter>('active');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drafting, setDrafting] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftSymptom, setDraftSymptom] = useState('');
  const [draftImage, setDraftImage] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [actionInFlightId, setActionInFlightId] = useState<string | null>(null);
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [dispatching, setDispatching] = useState(false);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [imageLoadingId, setImageLoadingId] = useState<string | null>(null);
  const imageUrlsRef = useRef(imageUrls);

  // Object URLs are only revocable client-side memory — revoke every one
  // we minted once the component unmounts, mirroring the createObjectURL
  // contract (nothing else owns their lifetime). The ref is synced in its
  // own effect (never during render) so the cleanup effect below can read
  // the latest map without re-registering on every change.
  useEffect(() => {
    imageUrlsRef.current = imageUrls;
  }, [imageUrls]);

  useEffect(() => {
    return () => {
      Object.values(imageUrlsRef.current).forEach((url) =>
        URL.revokeObjectURL(url),
      );
    };
  }, []);

  const viewReportImage = (reportId: string) => {
    if (imageUrls[reportId]) return;
    setImageLoadingId(reportId);
    fetchAuthenticatedImageUrl(`/api/reports/${reportId}/image`)
      .then((url) => setImageUrls((prev) => ({ ...prev, [reportId]: url })))
      .catch(() => {})
      .finally(() => setImageLoadingId(null));
  };

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
    setDraftImage(null);
    setCreateError(null);
  };

  const loadDraftImageFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') setDraftImage(reader.result);
    };
    reader.readAsDataURL(file);
  };

  const handleSymptomPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item.type.startsWith('image/')) continue;
      const file = item.getAsFile();
      if (!file) continue;
      e.preventDefault();
      loadDraftImageFile(file);
      return;
    }
    // No image item present — fall through to the browser's normal text paste.
  };

  const handleAttachFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) loadDraftImageFile(file);
    e.target.value = '';
  };

  const submitDraft = () => {
    if (!draftTitle.trim()) {
      setCreateError('Title is required');
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
        image: draftImage ?? undefined,
        source: 'operator',
      })
      .then((report) => reportsApi.commit(report.id))
      .then((report) => {
        setReports((prev) => [report, ...prev]);
        setDrafting(false);
      })
      .catch((err) =>
        setCreateError(
          err instanceof Error ? err.message : 'failed to file report',
        ),
      )
      .finally(() => setCreating(false));
  };

  const saveDraft = () => {
    if (!draftTitle.trim()) {
      setCreateError('Title is required');
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
        image: draftImage ?? undefined,
        source: 'operator',
      })
      .then((report) => {
        setReports((prev) => [report, ...prev]);
        setDrafting(false);
      })
      .catch((err) =>
        setCreateError(
          err instanceof Error ? err.message : 'failed to save draft',
        ),
      )
      .finally(() => setCreating(false));
  };

  const handleDraftKeyDown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      submitDraft();
    }
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
      : stateFilter === 'active'
        ? reports.filter((r) => ACTIVE_STATES.includes(r.state))
        : stateFilter === 'dispatched'
          ? reports.filter((r) => r.inFlight)
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
            stateFilter === 'active' ? styles.stateTabActive : ''
          }`}
          onClick={() => setStateFilter('active')}
          data-testid="report-filter-active"
        >
          Active (
          {reports.filter((r) => ACTIVE_STATES.includes(r.state)).length})
        </button>
        <button
          type="button"
          className={`${styles.stateTab} ${
            stateFilter === 'dispatched' ? styles.stateTabActive : ''
          }`}
          onClick={() => setStateFilter('dispatched')}
          data-testid="report-filter-dispatched"
        >
          Dispatched ({reports.filter((r) => r.inFlight).length})
        </button>
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
            onKeyDown={handleDraftKeyDown}
            data-testid="report-draft-title"
          />
          <textarea
            className={styles.draftTextarea}
            placeholder="Symptom"
            value={draftSymptom}
            onChange={(e) => setDraftSymptom(e.target.value)}
            onKeyDown={handleDraftKeyDown}
            onPaste={handleSymptomPaste}
            data-testid="report-draft-symptom"
          />
          <div className={styles.attachRow}>
            <input
              type="file"
              accept="image/*"
              className={styles.attachFileInput}
              onChange={handleAttachFileChange}
              data-testid="report-draft-attach-input"
              id="report-draft-attach-input"
            />
            <label
              htmlFor="report-draft-attach-input"
              className={styles.attachButton}
            >
              Attach image
            </label>
          </div>
          {draftImage && (
            <div
              className={styles.draftImagePreview}
              data-testid="report-draft-image-preview"
            >
              <img src={draftImage} alt="Pasted screenshot" />
              <button
                type="button"
                onClick={() => setDraftImage(null)}
                data-testid="report-draft-image-remove"
              >
                Remove image
              </button>
            </div>
          )}
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
              {creating ? 'Filing…' : 'File report'}
            </button>
            <button
              type="button"
              onClick={saveDraft}
              disabled={creating}
              data-testid="report-draft-save"
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
            {report.image_path && (
              <div className={styles.reportImage}>
                {imageUrls[report.id] ? (
                  <img
                    src={imageUrls[report.id]}
                    alt={`Screenshot for ${report.title}`}
                    data-testid={`report-image-${report.id}`}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      viewReportImage(report.id);
                    }}
                    disabled={imageLoadingId === report.id}
                    data-testid={`report-image-view-${report.id}`}
                  >
                    {imageLoadingId === report.id
                      ? 'Loading…'
                      : 'View screenshot'}
                  </button>
                )}
              </div>
            )}
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
