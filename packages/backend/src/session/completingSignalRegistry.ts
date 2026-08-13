/**
 * The completing-signal registry: a single, exhaustive-by-construction map
 * from (session_type, task_type, hasOpenPR) to the completing-signal
 * descriptor that tells session/sessionStatusDeriver.ts how to interpret a
 * completing_signal_ledger row for that triple.
 *
 * This centralizes what today is four scattered pieces of logic, taken here
 * as reference inputs to the registry's shape — NOT as call sites this
 * module rewires (that is the sibling migration task's job):
 *  - routes/opsJournal.ts's per-task-type terminal-state sets (OpsJournalState
 *    'resolved').
 *  - orchestration/planningDecisionKinds.ts's DECISION_INTENT_KINDS (plus the
 *    ops_journal and no-op marker kinds it also treats as "staged a
 *    decision").
 *  - orchestration/PlanningOrchestrator.ts's DESIGN_COMPLETING_REASONS
 *    ('planning_approved' / 'planning_no_pending_dispositions' — the only
 *    reasons with authority to close a design/docs/ops task) plus
 *    completeDesignTask/completeDocsTask/completeOpsTask.
 *  - the getPRBySessionId handoff inside completeDocsTask/completeOpsTask: a
 *    docs/ops session that opened its own PR is closed by the PR's outcome
 *    instead of its staged decision.
 *
 * A triple with no entry here throws on lookup rather than silently
 * defaulting — see resolveCompletingSignal.
 */

import type { SessionType } from './sessionPredicates';
import type { DerivedSessionOutcome } from './sessionStatusDeriver';

/**
 * Normalized task-type category a triple's key is built from — mirrors the
 * regex families in sessionPredicates.ts's isTaskTypeCompatibleWithSessionType
 * (CODE_TASK_TYPE / DESIGN_OR_PLANNING_TASK_TYPE / OPS_ELIGIBLE_TASK_TYPE /
 * DOCS_OR_ASSETS_TASK_TYPE), collapsed to one category per session type since
 * each type-bearing session type accepts exactly one category. 'any' is for
 * the type-agnostic session types (groom/split — review/depth_review are
 * deliberately unmapped, see below).
 */
export type TaskTypeCategory =
  | 'code'
  | 'design_or_planning'
  | 'ops_eligible'
  | 'docs_or_assets'
  | 'any';

/**
 * A completing-signal descriptor: which signal_class a ledger row for this
 * triple must carry, and which signal_value -> terminal-status mapping is
 * valid for it ("the terminal-state rule" / "named external-event class").
 * Deliberately produces only terminal DerivedSessionOutcome values — never
 * 'retrying', which stays exclusively a ws/types.ts broadcast-layer concept.
 */
export interface CompletingSignalDescriptor {
  readonly kind: 'staged_intent_terminal' | 'external_pr_event';
  /**
   * signal_value -> the terminal outcome it produces when observed as the
   * most recent completing_signal_ledger row for this triple. A signal_value
   * not present here is a registry-integrity failure at derive time (see
   * sessionStatusDeriver.ts) — fail loudly rather than default.
   */
  readonly reasons: Readonly<Record<string, DerivedSessionOutcome>>;
}

/**
 * The two reasons with authority to complete a design/docs/ops task via a
 * staged decision — see PlanningOrchestrator.ts's DESIGN_COMPLETING_REASONS,
 * which this constant is kept identical to on purpose (closeDeferredOpsTask
 * and PlanningOrchestrator.markTerminal both gate task-closure on
 * membership in that exact set).
 */
export const DESIGN_COMPLETING_REASONS: ReadonlySet<string> = new Set([
  'planning_approved',
  'planning_no_pending_dispositions',
]);

/**
 * An operator explicitly ending a planning session (endSession ->
 * markTerminal('planning_operator_end')) is still a genuine session
 * conclusion (status 'done') even though it carries no authority to close
 * the target task — DESIGN_COMPLETING_REASONS excludes it on purpose. Kept
 * as its own named reason here so the deriver can persist it into
 * terminal_completion_reason like any other reason, per this task's scope
 * item 6 ("populated by the same deriver, for every session type").
 */
export const PLANNING_OPERATOR_END_REASON = 'planning_operator_end';

const STAGED_INTENT_TERMINAL_DESCRIPTOR: CompletingSignalDescriptor = {
  kind: 'staged_intent_terminal',
  reasons: {
    planning_approved: 'done',
    planning_no_pending_dispositions: 'done',
    [PLANNING_OPERATOR_END_REASON]: 'done',
  },
};

const EXTERNAL_PR_EVENT_DESCRIPTOR: CompletingSignalDescriptor = {
  kind: 'external_pr_event',
  reasons: {
    pr_merged: 'done',
    pr_closed_without_merge: 'error',
  },
};

/** Registry key: `${sessionType}:${taskTypeCategory}:${hasOpenPR}`. */
type RegistryKey = `${SessionType}:${TaskTypeCategory}:${'true' | 'false'}`;

function key(
  sessionType: SessionType,
  taskTypeCategory: TaskTypeCategory,
  hasOpenPR: boolean,
): RegistryKey {
  return `${sessionType}:${taskTypeCategory}:${hasOpenPR ? 'true' : 'false'}`;
}

/**
 * Every (session_type, task_type, hasOpenPR) triple in current use.
 * 'review' and 'depth_review' sessions are deliberately absent: they touch
 * no task status and are excluded from sessionDidWork's PR-outcome /
 * stage-only branches (see session/sessionLifecycle.ts's "Not applicable"
 * comment) — they never produce a completing signal for this registry to
 * interpret, so a lookup against them fails loudly rather than being given a
 * default descriptor. A 'standard' session with hasOpenPR=false is likewise
 * absent: a code session is only completable once it has opened a PR (its
 * pre-PR terminal writes, e.g. a crash, are not a "completing signal" this
 * registry governs).
 */
const REGISTRY: Partial<Record<RegistryKey, CompletingSignalDescriptor>> = {
  [key('standard', 'code', true)]: EXTERNAL_PR_EVENT_DESCRIPTOR,

  [key('docs', 'docs_or_assets', true)]: EXTERNAL_PR_EVENT_DESCRIPTOR,
  [key('docs', 'docs_or_assets', false)]: STAGED_INTENT_TERMINAL_DESCRIPTOR,

  [key('ops', 'ops_eligible', true)]: EXTERNAL_PR_EVENT_DESCRIPTOR,
  [key('ops', 'ops_eligible', false)]: STAGED_INTENT_TERMINAL_DESCRIPTOR,

  [key('design', 'design_or_planning', false)]:
    STAGED_INTENT_TERMINAL_DESCRIPTOR,

  [key('groom', 'any', false)]: STAGED_INTENT_TERMINAL_DESCRIPTOR,
  [key('split', 'any', false)]: STAGED_INTENT_TERMINAL_DESCRIPTOR,
};

/** The exact set of triples REGISTRY maps — exported so tests can assert exhaustiveness against "current use" without hand-duplicating the list. */
export const REGISTERED_TRIPLES: ReadonlyArray<{
  sessionType: SessionType;
  taskTypeCategory: TaskTypeCategory;
  hasOpenPR: boolean;
}> = [
  { sessionType: 'standard', taskTypeCategory: 'code', hasOpenPR: true },
  {
    sessionType: 'docs',
    taskTypeCategory: 'docs_or_assets',
    hasOpenPR: true,
  },
  {
    sessionType: 'docs',
    taskTypeCategory: 'docs_or_assets',
    hasOpenPR: false,
  },
  { sessionType: 'ops', taskTypeCategory: 'ops_eligible', hasOpenPR: true },
  { sessionType: 'ops', taskTypeCategory: 'ops_eligible', hasOpenPR: false },
  {
    sessionType: 'design',
    taskTypeCategory: 'design_or_planning',
    hasOpenPR: false,
  },
  { sessionType: 'groom', taskTypeCategory: 'any', hasOpenPR: false },
  { sessionType: 'split', taskTypeCategory: 'any', hasOpenPR: false },
];

/**
 * Resolve the completing-signal descriptor for a triple. Throws — never
 * silently defaults — when the triple is unmapped, per this task's
 * "exhaustive by construction" requirement.
 */
export function resolveCompletingSignal(
  sessionType: SessionType,
  taskTypeCategory: TaskTypeCategory,
  hasOpenPR: boolean,
): CompletingSignalDescriptor {
  const descriptor = REGISTRY[key(sessionType, taskTypeCategory, hasOpenPR)];
  if (!descriptor) {
    throw new Error(
      `[completingSignalRegistry] no completing-signal descriptor mapped for ` +
        `(session_type=${sessionType}, task_type=${taskTypeCategory}, hasOpenPR=${hasOpenPR}). ` +
        `Every triple in current use must be mapped explicitly — add one to ` +
        `REGISTRY (and REGISTERED_TRIPLES) rather than defaulting.`,
    );
  }
  return descriptor;
}
