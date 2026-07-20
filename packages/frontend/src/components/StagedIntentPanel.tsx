import { useState, useEffect, type ReactNode } from 'react';
import { renderTaskBodyMarkdown } from '@claude-orchestrator/backend/src/tasks/bodyRender';
import type { StagedIntent } from '../api/stagedIntents';
import { stagedIntentsApi } from '../api/stagedIntents';
import { diffTaskBody, type SectionDiff } from './bodyDiff';
import styles from './StagedIntentPanel.module.css';

interface Props {
  intent: StagedIntent;
  onApplied?: (intent: StagedIntent, result: unknown) => void;
  onRejected?: (intent: StagedIntent) => void;
  /**
   * Called when the server reports the intent no longer exists (already
   * applied/rejected elsewhere, or a stale client-side stub). Distinct from
   * onRejected because nothing was actually rejected — the panel just needs
   * to stop displaying a dead intent instead of getting stuck on an error.
   */
  onDismiss?: (intent: StagedIntent) => void;
  /**
   * Called after a group member is approved, so the enclosing decision
   * panel can refresh the group's live state (e.g. enable "Commit group").
   */
  onApproved?: (intent: StagedIntent) => void;
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && /not found/i.test(err.message);
}

const TERMINAL_INTENT_STATES = new Set(['committed', 'rejected', 'superseded']);

interface TaskMovePayload {
  taskName?: string;
  sourceMilestoneName?: string;
  targetMilestoneName?: string;
  originalDisposition?: 'archive' | 'defer';
  isLaterMove?: boolean;
  cascadeSet?: string[];
}

function isTaskMovePayload(payload: unknown): payload is TaskMovePayload {
  return (
    !!payload && typeof payload === 'object' && 'targetMilestoneName' in payload
  );
}

function renderTaskMovePayload(payload: TaskMovePayload): ReactNode {
  return (
    <div className={styles.text} data-testid="staged-intent-move-payload">
      <p>
        Move <strong>{payload.taskName ?? 'task'}</strong> from{' '}
        <strong>{payload.sourceMilestoneName ?? '—'}</strong> to{' '}
        <strong>{payload.targetMilestoneName ?? '—'}</strong>
      </p>
      <p>
        Original task:{' '}
        {payload.originalDisposition === 'defer'
          ? 'Deferred (tombstone)'
          : 'Archived (clean)'}
      </p>
      {payload.isLaterMove && (
        <div data-testid="staged-intent-cascade-set">
          {payload.cascadeSet && payload.cascadeSet.length > 0 ? (
            <>
              <p>{payload.cascadeSet.length} dependent task(s) move with it:</p>
              <ul>
                {payload.cascadeSet.map((id) => (
                  <li key={id}>{id}</li>
                ))}
              </ul>
            </>
          ) : (
            <p>No dependents move with it.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Per-kind headline renderers ──────────────────────────────────────────

interface UpdateBodyPayload {
  taskId: string;
  sections: Parameters<typeof renderTaskBodyMarkdown>[0];
}

function BodySectionDiff({ intent }: { intent: StagedIntent }) {
  const payload = intent.payload as UpdateBodyPayload;
  const [diff, setDiff] = useState<SectionDiff[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setError(null);
    stagedIntentsApi
      .fetchTaskPage(payload.taskId, intent.projectId)
      .then((stored) => {
        if (cancelled) return;
        const proposed = renderTaskBodyMarkdown(payload.sections);
        setDiff(diffTaskBody(stored, proposed));
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load body');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [payload.taskId, payload.sections, intent.projectId]);

  if (error) return <p className={styles.error}>{error}</p>;
  if (!diff) return <p className={styles.text}>Loading body diff…</p>;

  const changedSections = diff.filter((s) => s.changed);
  if (changedSections.length === 0) {
    return <p className={styles.text}>No section changes.</p>;
  }

  return (
    <div data-testid="staged-intent-body-diff" className={styles.bodyDiff}>
      {changedSections.map((section) => (
        <div key={section.name} className={styles.diffSection}>
          <div className={styles.diffSectionHeading}>## {section.name}</div>
          {section.lines.map((line, idx) => (
            <div
              key={idx}
              className={
                line.kind === 'added'
                  ? styles.diffAdded
                  : line.kind === 'removed'
                    ? styles.diffRemoved
                    : styles.diffUnchanged
              }
            >
              {line.kind === 'added'
                ? '+ '
                : line.kind === 'removed'
                  ? '- '
                  : '  '}
              {line.text}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

interface SetStatusPayload {
  taskId: string;
  status: string;
}

function ViolationsRegister({
  violations,
}: {
  violations: { tier: string; detail: string; location: string }[];
}) {
  return (
    <div
      className={styles.blockingRegister}
      data-testid="staged-intent-blocking-register"
    >
      <div className={styles.registerLabel}>⛔ Blocked — hard violations</div>
      <ul>
        {violations.map((v, idx) => (
          <li key={idx}>
            <strong>{v.location}</strong>: {v.detail}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReasonsRegister({ reasons }: { reasons: string[] }) {
  return (
    <div
      className={styles.blockingRegister}
      data-testid="staged-intent-blocking-register"
    >
      <div className={styles.registerLabel}>⛔ Blocked — grooming gate</div>
      <ul>
        {reasons.map((r, idx) => (
          <li key={idx}>{r}</li>
        ))}
      </ul>
    </div>
  );
}

function AdvisoryRegister({
  advisory,
}: {
  advisory: NonNullable<StagedIntent['advisory']>;
}) {
  return (
    <div
      className={styles.advisoryRegister}
      data-testid="staged-intent-advisory-register"
    >
      <div className={styles.registerLabel}>
        🟡 Advisory ({advisory.status}) — confidence{' '}
        {Math.round(advisory.confidence * 100)}%
      </div>
      {advisory.findings.length > 0 && (
        <ul>
          {advisory.findings.map((f, idx) => (
            <li key={idx}>
              {f.detail}
              {f.location ? ` (${f.location})` : ''}
              {f.quote ? ` — "${f.quote}"` : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SetStatusHeadline({ intent }: { intent: StagedIntent }) {
  const payload = intent.payload as SetStatusPayload;
  return (
    <div className={styles.text}>
      {payload.status === 'Ready' ? (
        <p>
          <strong>Promote to Ready</strong> — {payload.taskId}
        </p>
      ) : (
        <p>
          Set status of <strong>{payload.taskId}</strong> to{' '}
          <strong>{payload.status}</strong>
        </p>
      )}
    </div>
  );
}

interface SetDependsOnPayload {
  taskId: string;
  dependsOn: string[];
}

function SetDependsOnHeadline({ intent }: { intent: StagedIntent }) {
  const payload = intent.payload as SetDependsOnPayload;
  return (
    <div className={styles.text}>
      <p>
        Depends on for <strong>{payload.taskId}</strong>:
      </p>
      {payload.dependsOn.length === 0 ? (
        <p>None — Wave N.</p>
      ) : (
        <ul>
          {payload.dependsOn.map((id) => (
            <li key={id}>{id}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface CreatePayload {
  title: string;
  type?: string;
  priority?: string;
  dependsOn?: string[];
}

function CreateHeadline({ intent }: { intent: StagedIntent }) {
  const payload = intent.payload as CreatePayload;
  return (
    <div className={styles.text}>
      <p>
        Create task: <strong>{payload.title}</strong>
      </p>
      {payload.type && <p>Type: {payload.type}</p>}
      {payload.priority && <p>Priority: {payload.priority}</p>}
      {payload.dependsOn && payload.dependsOn.length > 0 && (
        <p>Depends on: {payload.dependsOn.join(', ')}</p>
      )}
    </div>
  );
}

interface SetPropertiesPayload {
  taskId: string;
  patch: Record<string, unknown>;
}

function SetPropertiesHeadline({ intent }: { intent: StagedIntent }) {
  const payload = intent.payload as SetPropertiesPayload;
  return (
    <div className={styles.text}>
      <p>
        Update properties for <strong>{payload.taskId}</strong>:
      </p>
      <ul>
        {Object.entries(payload.patch ?? {}).map(([key, value]) => (
          <li key={key}>
            {key}: {String(value)}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface ArchivePayload {
  taskId: string;
}

function ArchiveHeadline({ intent }: { intent: StagedIntent }) {
  const payload = intent.payload as ArchivePayload;
  return (
    <p className={styles.text}>
      <strong>Archive</strong> — {payload.taskId}
    </p>
  );
}

interface CapabilityRequestPayload {
  capability: string;
  plan: string;
  evidence: string;
}

/** The grant-approval kind: a dispatched session requesting exactly one write capability. */
function CapabilityRequestHeadline({ intent }: { intent: StagedIntent }) {
  const payload = intent.payload as CapabilityRequestPayload;
  return (
    <div className={styles.text} data-testid="staged-intent-capability-request">
      <p>
        Requests capability: <code>{payload.capability}</code>
      </p>
      <p>Plan: {payload.plan}</p>
      <p>Evidence: {payload.evidence}</p>
    </div>
  );
}

interface JournalSetStatePayload {
  taskId: string;
  state: string;
  fields?: { disposition?: string; resolution?: unknown };
}

/** The ops_journal disposition kind — a dispatched ops session's staging
 *  transition, or an operator's device-authed resolve. */
function JournalSetStateHeadline({ intent }: { intent: StagedIntent }) {
  const payload = intent.payload as JournalSetStatePayload;
  return (
    <div
      className={styles.text}
      data-testid="staged-intent-ops-journal-payload"
    >
      <p>
        ops_journal: set <strong>{payload.taskId}</strong> to{' '}
        <strong>{payload.state}</strong>
      </p>
      {payload.fields?.disposition && (
        <p>Disposition: {payload.fields.disposition}</p>
      )}
    </div>
  );
}

function renderHeadline(intent: StagedIntent): ReactNode {
  switch (intent.kind) {
    case 'task.updateBody':
      return <BodySectionDiff intent={intent} />;
    case 'task.setStatus':
      return <SetStatusHeadline intent={intent} />;
    case 'task.setDependsOn':
      return <SetDependsOnHeadline intent={intent} />;
    case 'task.create':
      return <CreateHeadline intent={intent} />;
    case 'task.setProperties':
      return <SetPropertiesHeadline intent={intent} />;
    case 'task.archive':
      return <ArchiveHeadline intent={intent} />;
    case 'task.move':
      return isTaskMovePayload(intent.payload)
        ? renderTaskMovePayload(intent.payload)
        : renderFallback(intent.payload);
    case 'session.requestCapability':
      return <CapabilityRequestHeadline intent={intent} />;
    case 'journal.setState':
      return <JournalSetStateHeadline intent={intent} />;
    default:
      return renderFallback(intent.payload);
  }
}

function renderFallback(payload: unknown): ReactNode {
  if (payload == null) return null;
  if (typeof payload === 'string')
    return <p className={styles.text}>{payload}</p>;
  return (
    <pre className={styles.payload}>{JSON.stringify(payload, null, 2)}</pre>
  );
}

/**
 * The shared staged-intent display: per-kind headline rendering, the
 * blocking (annotation) and advisory (Tier-3) registers in structurally
 * distinct sections, and the disposition actions — Apply, Reject,
 * Pushback-with-feedback, Approve (for group commit), and an override+reason
 * affordance when the intent is blocked. Apply always dispatches through the
 * general command/stage surface (never a bespoke per-producer write).
 */
export function StagedIntentPanel({
  intent,
  onApplied,
  onRejected,
  onDismiss,
  onApproved,
}: Props) {
  const [inFlight, setInFlight] = useState<
    'apply' | 'reject' | 'approve' | 'override' | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [showPushback, setShowPushback] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [showOverride, setShowOverride] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');

  const blocked = intent.annotation?.blocked === true;
  // The grant-approval kind: never applied — dispositioned only through
  // approve / reject / pushback, the existing consent vocabulary.
  const isCapabilityRequest = intent.kind === 'session.requestCapability';

  const handleApply = async (override?: { reason: string }) => {
    setInFlight(override ? 'override' : 'apply');
    setError(null);
    try {
      const { result } = await stagedIntentsApi.apply(
        intent.id,
        override ? { override: true, reason: override.reason } : undefined,
      );
      onApplied?.(intent, result);
    } catch (err) {
      if (isNotFoundError(err)) {
        onDismiss?.(intent);
        return;
      }
      setError(err instanceof Error ? err.message : 'Failed to apply intent');
    } finally {
      setInFlight(null);
    }
  };

  const handleApprove = async () => {
    setInFlight('approve');
    setError(null);
    try {
      const updated = await stagedIntentsApi.approve(intent.id);
      // A capability-request approve has no separate apply step — it
      // resolves straight to a terminal state (granted + re-dispatched), so
      // it comes off the surface the same way an applied intent does.
      if (updated.state && TERMINAL_INTENT_STATES.has(updated.state)) {
        onApplied?.(intent, updated);
      } else {
        onApproved?.(updated);
      }
    } catch (err) {
      if (isNotFoundError(err)) {
        onDismiss?.(intent);
        return;
      }
      setError(err instanceof Error ? err.message : 'Failed to approve intent');
    } finally {
      setInFlight(null);
    }
  };

  const handleReject = async () => {
    setInFlight('reject');
    setError(null);
    try {
      await stagedIntentsApi.reject(intent.id, feedback.trim() || undefined);
      onRejected?.(intent);
    } catch (err) {
      if (isNotFoundError(err)) {
        onDismiss?.(intent);
        return;
      }
      setError(err instanceof Error ? err.message : 'Failed to reject intent');
    } finally {
      setInFlight(null);
    }
  };

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.kind}>{intent.kind}</span>
        {intent.groupId && (
          <span className={styles.groupBadge} data-testid="staged-intent-group">
            {intent.groupId}
          </span>
        )}
        {intent.state && (
          <span className={styles.stateBadge}>{intent.state}</span>
        )}
      </div>

      {intent.decisionProposal && (
        <p className={styles.rationale}>{intent.decisionProposal}</p>
      )}

      <div className={styles.body}>{renderHeadline(intent)}</div>

      {blocked && intent.annotation && 'violations' in intent.annotation && (
        <ViolationsRegister violations={intent.annotation.violations} />
      )}
      {blocked && intent.annotation && 'reasons' in intent.annotation && (
        <ReasonsRegister reasons={intent.annotation.reasons} />
      )}
      {intent.advisory && <AdvisoryRegister advisory={intent.advisory} />}

      {error && <div className={styles.error}>{error}</div>}

      {showOverride && (
        <div className={styles.overrideBox}>
          <textarea
            className={styles.feedbackInput}
            placeholder="Reason for overriding the block…"
            value={overrideReason}
            onChange={(e) => setOverrideReason(e.target.value)}
          />
          <button
            type="button"
            className={styles.approveButton}
            disabled={inFlight !== null || !overrideReason.trim()}
            onClick={() => void handleApply({ reason: overrideReason })}
          >
            {inFlight === 'override' ? 'Applying…' : 'Apply with override'}
          </button>
        </div>
      )}

      {showPushback ? (
        <div className={styles.overrideBox}>
          <textarea
            className={styles.feedbackInput}
            placeholder="Feedback for the session…"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
          />
        </div>
      ) : (
        <button
          type="button"
          className={styles.pushbackToggle}
          onClick={() => setShowPushback(true)}
        >
          + Add feedback (pushback)
        </button>
      )}

      <div className={styles.permissionButtons}>
        {!blocked && !isCapabilityRequest && (
          <button
            type="button"
            className={styles.approveButton}
            disabled={inFlight !== null}
            onClick={() => void handleApply()}
          >
            {inFlight === 'apply' ? 'Applying...' : '✓ Apply'}
          </button>
        )}
        {blocked && !isCapabilityRequest && !showOverride && (
          <button
            type="button"
            className={styles.approveButton}
            disabled={inFlight !== null}
            onClick={() => setShowOverride(true)}
          >
            Override block…
          </button>
        )}
        {(intent.groupId || isCapabilityRequest) &&
          intent.state !== 'approved' && (
            <button
              type="button"
              className={styles.approveButton}
              disabled={inFlight !== null}
              onClick={() => void handleApprove()}
            >
              {inFlight === 'approve'
                ? 'Approving...'
                : isCapabilityRequest
                  ? '✓ Grant'
                  : 'Approve'}
            </button>
          )}
        <button
          type="button"
          className={styles.denyButton}
          disabled={inFlight !== null}
          onClick={() => void handleReject()}
        >
          {inFlight === 'reject'
            ? 'Rejecting...'
            : feedback.trim()
              ? '↩ Pushback with feedback'
              : '✕ Reject'}
        </button>
      </div>
    </div>
  );
}
