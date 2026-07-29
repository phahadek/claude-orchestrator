import { useState, useEffect, type ReactNode } from 'react';
import { renderTaskBodyMarkdown } from '@claude-orchestrator/backend/src/tasks/bodyRender';
import type {
  StagedIntent,
  StagedIntentRejectOutcome,
  GroomProposalFields,
} from '../api/stagedIntents';
import { stagedIntentsApi } from '../api/stagedIntents';
import { diffTaskBody, splitSections, type SectionDiff } from './bodyDiff';
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
  /**
   * Suppresses this panel's own apply/approve/reject controls — used when a
   * grouped intent is dispositioned as part of one atomic group-level
   * approval unit (see DecisionPanel's group action bar) rather than
   * individually. The headline, registers, and proposal are still rendered;
   * only the per-item action surface is hidden.
   */
  hideActions?: boolean;
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && /not found/i.test(err.message);
}

const TERMINAL_INTENT_STATES = new Set([
  'committed',
  'rejected',
  'superseded',
  'withdrawn',
]);

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

/** task.patchBodySection's payload — schemas.ts's patchBodySectionPayloadSchema. */
type PatchBodySectionPayload =
  | { taskId: string; section: string; operation: 'append'; content: string }
  | {
      taskId: string;
      section: string;
      operation: 'replace';
      find: string;
      replaceWith: string;
    }
  | { taskId: string; section: string; operation: 'remove' };

function isPatchBodySectionPayload(
  payload: unknown,
): payload is PatchBodySectionPayload {
  if (!payload || typeof payload !== 'object') return false;
  const operation = (payload as { operation?: unknown }).operation;
  return (
    operation === 'append' || operation === 'replace' || operation === 'remove'
  );
}

/**
 * task.patchBodySection's preview — forked from BodySectionDiff rather than
 * routed through it, since a section patch operates on one named section
 * with an operation-specific shape (append/replace/remove) instead of the
 * full structured-sections diff that task.updateBody produces.
 */
function PatchBodySectionDiff({ intent }: { intent: StagedIntent }) {
  const payload = intent.payload as PatchBodySectionPayload;
  const [currentContent, setCurrentContent] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (payload.operation !== 'remove') return;
    let cancelled = false;
    setCurrentContent(null);
    setError(null);
    stagedIntentsApi
      .fetchTaskPage(payload.taskId, intent.projectId)
      .then((stored) => {
        if (cancelled) return;
        const sections = splitSections(stored);
        const lines = (sections.get(payload.section) ?? []).filter(
          (l) => l.trim() !== '',
        );
        setCurrentContent(lines);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load body');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [payload.operation, payload.taskId, payload.section, intent.projectId]);

  return (
    <div
      data-testid="staged-intent-patch-body-section"
      className={styles.bodyDiff}
    >
      <div className={styles.diffSection}>
        <div className={styles.diffSectionHeading}>## {payload.section}</div>
        {payload.operation === 'replace' && (
          <div data-testid="staged-intent-patch-replace">
            <div className={styles.diffRemoved}>- {payload.find}</div>
            <div className={styles.diffAdded}>+ {payload.replaceWith}</div>
          </div>
        )}
        {payload.operation === 'append' && (
          <div data-testid="staged-intent-patch-append">
            <div className={styles.diffAdded}>+ {payload.content}</div>
          </div>
        )}
        {payload.operation === 'remove' && (
          <div data-testid="staged-intent-patch-remove">
            <p className={styles.text}>
              ⚠️ This will remove the entire <strong>{payload.section}</strong>{' '}
              section:
            </p>
            {error && <p className={styles.error}>{error}</p>}
            {!error && currentContent === null && (
              <p className={styles.text}>Loading current content…</p>
            )}
            {!error && currentContent !== null && (
              <>
                {currentContent.length === 0 ? (
                  <p className={styles.text}>(section is already empty)</p>
                ) : (
                  currentContent.map((line, idx) => (
                    <div key={idx} className={styles.diffRemoved}>
                      - {line}
                    </div>
                  ))
                )}
              </>
            )}
          </div>
        )}
      </div>
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

/**
 * The /groom skill's structured proposal (presentation.md's 4/5-point
 * summary) — rendered as labeled fields instead of `decisionProposal`'s
 * single prose paragraph, so the reviewing human sees the same shape the
 * interactive /groom skill presents for sign-off.
 */
function GroomProposalSummary({ proposal }: { proposal: GroomProposalFields }) {
  return (
    <dl
      className={styles.groomProposal}
      data-testid="staged-intent-groom-proposal"
    >
      <dt>Achieves</dt>
      <dd>{proposal.achieves}</dd>
      <dt>Open questions</dt>
      <dd>{proposal.openQuestions}</dd>
      <dt>Automated tests</dt>
      <dd>{proposal.automatedTests}</dd>
      <dt>Manual verification</dt>
      <dd>{proposal.manualVerification}</dd>
      <dt>Operational seed</dt>
      <dd>{proposal.operationalSeed}</dd>
    </dl>
  );
}

function SetStatusHeadline({ intent }: { intent: StagedIntent }) {
  const payload = intent.payload as SetStatusPayload;
  if (payload.status === 'Ready') {
    return (
      <div className={styles.text}>
        <p>
          <strong>Promote to Ready</strong> — {payload.taskId}
        </p>
      </div>
    );
  }
  if (payload.status === 'Deferred') {
    return (
      <div className={styles.text} data-testid="staged-intent-discard-defer">
        <p>
          <strong>⏭️ Propose discard/defer</strong> — {payload.taskId}
        </p>
      </div>
    );
  }
  return (
    <div className={styles.text}>
      <p>
        Set status of <strong>{payload.taskId}</strong> to{' '}
        <strong>{payload.status}</strong>
      </p>
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
  body?: string;
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
      {payload.body ? (
        <pre className={styles.payload}>{payload.body}</pre>
      ) : (
        <p>No body supplied.</p>
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
  fields?: {
    disposition?: string;
    resolution?: unknown;
    findingOrProposal?: unknown;
    evidence?: unknown;
  };
}

function renderJsonField(value: unknown): ReactNode {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  return <pre className={styles.payload}>{JSON.stringify(value, null, 2)}</pre>;
}

/** The ops_journal disposition kind — a dispatched ops session's staging
 *  transition (a parked, unapplied decision awaiting sign-off when state is
 *  staged-proposal), or an operator's device-authed resolve. */
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
      {payload.fields?.findingOrProposal != null && (
        <div data-testid="staged-intent-ops-journal-finding">
          <p>Finding / proposal:</p>
          {renderJsonField(payload.fields.findingOrProposal)}
        </div>
      )}
      {payload.fields?.resolution != null && (
        <div data-testid="staged-intent-ops-journal-resolution">
          <p>Resolution:</p>
          {renderJsonField(payload.fields.resolution)}
        </div>
      )}
    </div>
  );
}

type NamedCompletenessDisposition =
  | 'resolved'
  | 'out-of-scope'
  | 'not-a-decision'
  | 'fold'
  | 'file-sibling'
  | 'sibling-owned';

interface CompletenessDispositionQuestionPayload {
  question: string;
  disposition: NamedCompletenessDisposition;
  reason: string;
  approvalStatus?: 'proposed' | 'approved' | 'rejected';
}

interface CompletenessDispositionPayload {
  taskId: string;
  rowId: number;
  project: string | null;
  milestone: string | null;
  probed: string[];
  questions: CompletenessDispositionQuestionPayload[];
  runAt: string;
}

/** The completeness-critic disposition kind: a design session's critic-pass findings, staged for operator approval before the task's architecture/closing-synthesis writes are allowed to stage. */
function CompletenessDispositionHeadline({ intent }: { intent: StagedIntent }) {
  const payload = intent.payload as CompletenessDispositionPayload;
  return (
    <div
      className={styles.text}
      data-testid="staged-intent-completeness-disposition"
    >
      <p>
        Completeness critic run for <strong>{payload.taskId}</strong>
        {payload.milestone ? ` (${payload.milestone})` : ''} — {payload.runAt}
      </p>
      <p>Probed: {(payload.probed ?? []).join(', ') || 'none recorded'}</p>
      {payload.questions.length === 0 ? (
        <p>No gaps raised — pass run, clean.</p>
      ) : (
        <ul>
          {payload.questions.map((q, idx) => (
            <li key={idx}>
              <strong>{q.disposition}:</strong> {q.question} — {q.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface NoOpPayload {
  taskId: string;
  reason: string;
}

/**
 * The deliberate-no-op terminal path: a dispatched planning session's
 * declaration that it reached terminal with nothing to change. Purely
 * informational/auditable — no operator disposition is required or offered
 * for this kind (see the panel's isNoOp guard below), so the operator's only
 * action is reading the reason.
 */
function NoOpHeadline({ intent }: { intent: StagedIntent }) {
  const payload = intent.payload as NoOpPayload;
  return (
    <div className={styles.text} data-testid="staged-intent-no-op">
      <p>
        No-op: nothing staged for <strong>{payload.taskId}</strong>
      </p>
      <p>Reason: {payload.reason}</p>
    </div>
  );
}

function renderHeadline(intent: StagedIntent): ReactNode {
  switch (intent.kind) {
    case 'completeness.disposition':
      return <CompletenessDispositionHeadline intent={intent} />;
    case 'task.updateBody':
      return <BodySectionDiff intent={intent} />;
    case 'task.patchBodySection':
      return isPatchBodySectionPayload(intent.payload) ? (
        <PatchBodySectionDiff intent={intent} />
      ) : (
        renderFallback(intent.payload)
      );
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
    case 'planning.noOp':
      return <NoOpHeadline intent={intent} />;
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
 * distinct sections, and the disposition actions — Commit (a standalone
 * intent's fused apply), Approve (for group members, gating the group's own
 * Commit), Grant (capability requests), a reason-required reject form with
 * an explicit Pushback/Decline outcome, and an override+reason affordance
 * when the intent is blocked. Commit always dispatches through the general
 * command/stage surface (never a bespoke per-producer write); a grouped
 * intent is never individually committed — the group's Commit is the sole
 * write for its members.
 */
export function StagedIntentPanel({
  intent,
  onApplied,
  onRejected,
  onDismiss,
  onApproved,
  hideActions,
}: Props) {
  const [inFlight, setInFlight] = useState<
    'apply' | 'reject' | 'approve' | 'override' | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [rejectOutcome, setRejectOutcome] =
    useState<StagedIntentRejectOutcome>('pushback');
  const [rejectReason, setRejectReason] = useState('');
  const [showOverride, setShowOverride] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');

  const blocked = intent.annotation?.blocked === true;
  // The grant-approval kind: never applied — dispositioned only through
  // approve / reject / pushback, the existing consent vocabulary.
  const isCapabilityRequest = intent.kind === 'session.requestCapability';
  // Approval is terminal for a completeness-disposition run too — approving
  // it directly advances the underlying completeness_disposition row(s) off
  // `proposed` and unblocks the design task's gated arch.*/closing-synthesis
  // writes; there is no separate apply/commit step.
  const isCompletenessDisposition = intent.kind === 'completeness.disposition';
  const skipsApply = isCapabilityRequest || isCompletenessDisposition;
  // planning.noOp is purely informational/auditable — no operator
  // disposition (commit/approve/reject) is ever offered for it.
  const isNoOp = intent.kind === 'planning.noOp';
  const isGrouped = !!intent.groupId;

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
    const reason = rejectReason.trim();
    if (!reason) return;
    setInFlight('reject');
    setError(null);
    try {
      await stagedIntentsApi.reject(intent.id, {
        outcome: rejectOutcome,
        reason,
      });
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
        {intent.state === 'withdrawn' ? (
          <span className={styles.withdrawnBadge}>withdrawn</span>
        ) : (
          intent.state && (
            <span className={styles.stateBadge}>{intent.state}</span>
          )
        )}
      </div>

      {intent.state === 'withdrawn' && intent.dispositionReason && (
        <p className={styles.withdrawnReason}>
          Withdrawn by the staging session: {intent.dispositionReason}
        </p>
      )}

      {intent.groomProposal ? (
        <GroomProposalSummary proposal={intent.groomProposal} />
      ) : (
        intent.decisionProposal && (
          <p className={styles.rationale}>{intent.decisionProposal}</p>
        )
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

      {hideActions || isNoOp ? null : (
        <>
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

          <div className={styles.rejectForm}>
            <div
              className={styles.outcomeToggle}
              role="radiogroup"
              aria-label="Reject outcome"
            >
              <button
                type="button"
                role="radio"
                aria-checked={rejectOutcome === 'pushback'}
                className={
                  rejectOutcome === 'pushback'
                    ? styles.outcomeOptionActive
                    : styles.outcomeOption
                }
                onClick={() => setRejectOutcome('pushback')}
              >
                Pushback
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={rejectOutcome === 'decline'}
                className={
                  rejectOutcome === 'decline'
                    ? styles.outcomeOptionActive
                    : styles.outcomeOption
                }
                onClick={() => setRejectOutcome('decline')}
              >
                Decline
              </button>
            </div>
            <textarea
              className={styles.feedbackInput}
              placeholder={
                rejectOutcome === 'pushback'
                  ? 'What should the session revise?'
                  : 'Why is this being declined?'
              }
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
            />
          </div>

          <div className={styles.permissionButtons}>
            {!isGrouped && !blocked && !skipsApply && (
              <button
                type="button"
                className={styles.approveButton}
                disabled={inFlight !== null}
                onClick={() => void handleApply()}
              >
                {inFlight === 'apply' ? 'Committing...' : '✓ Commit'}
              </button>
            )}
            {!isGrouped && blocked && !skipsApply && !showOverride && (
              <button
                type="button"
                className={styles.approveButton}
                disabled={inFlight !== null}
                onClick={() => setShowOverride(true)}
              >
                Override block…
              </button>
            )}
            {(isGrouped || skipsApply) && intent.state !== 'approved' && (
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
              disabled={inFlight !== null || !rejectReason.trim()}
              onClick={() => void handleReject()}
            >
              {inFlight === 'reject'
                ? 'Submitting...'
                : rejectOutcome === 'pushback'
                  ? '↩ Pushback'
                  : '✕ Decline'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
