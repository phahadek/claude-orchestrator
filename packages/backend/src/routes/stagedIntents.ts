import { Router } from 'express';
import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { getTaskBackend } from '../tasks/TaskBackend';
import {
  BackendTaskWriteCommands,
  getCachedType,
  type TaskStatus,
  type TaskType,
  type MoveTaskContent,
  type MoveTaskMilestoneRef,
  type MoveTaskTargetMilestone,
  type CreateTaskCommandFields,
} from '../tasks/TaskWriteCommands';
import type {
  TaskPropertiesPatch,
  PatchBodySectionOperation,
} from '../tasks/TaskBackend';
import type { TaskBodySections } from '../tasks/bodyRender';
import {
  checkReadiness,
  composeProposedBody,
  ReadinessGateError,
  parseManualVerificationItems,
  checkAccretionContentMatch,
  type ReadinessViolation,
} from '../tasks/readinessGate';
import {
  GroomingGateError,
  checkGroomingPromotionGate,
  type GroomingGateEntry,
} from '../groom/groomGate';
import type {
  StagedIntentRow,
  StagedIntentState,
  StagedIntentRejectOutcome,
  DecisionPickOnePayload,
  StagedIntentAnswer,
  GroomProposalFields,
  CompletenessDispositionQuestion,
  CompletenessProbedGapClass,
} from '../db/types';
import {
  hashIntentPayload,
  insertStagedIntent,
  getStagedIntent as getStagedIntentRow,
  listStagedIntentsByProject,
  listAllActiveStagedIntents,
  listStagedIntentsByGroup,
  listStagedIntentsBySession,
  findActiveStagedIntentForTask,
  findActiveStagedIntentByTitleForSession,
  findActiveDecisionPickOneForSession,
  transitionStagedIntent,
  supersedeStagedIntent,
  setStagedIntentAnnotation,
  setStagedIntentGroup,
  clearStagedIntentGroup,
  getTaskCache,
  getSession,
  updateCompletenessDispositionApproval,
  deleteCompletenessDisposition,
} from '../db/queries';
import { parseTaskId, normalizeTaskId } from '../tasks/taskId';
import { NotionApiError } from '../notion/types';
import { recordEvent } from '../audit/AuditLog';
import type {
  GateContributionSourceTask,
  GateContributionItemInput,
  GateContributionDecision,
  SeedContributionSourceTask,
  SeedContributionItemInput,
  SeedContributionDecision,
} from '../tasks/TaskWriteCommands';
import {
  setEntryState,
  getEntry as getOpsJournalEntry,
  isValidOpsTransition,
  ALLOWED_TRANSITIONS,
  type OpsState,
} from '../ops/opsJournal';
import { classifyReadyProposal } from '../tasks/deferralClassifier';
import type { PlanningOrchestrator } from '../orchestration/PlanningOrchestrator';
import type { SessionManager } from '../session/SessionManager';
import {
  BackendArchWriteCommands,
  StaleArchUnitVersionError,
  ArchUnitAlreadySupersededError,
  type NewArchUnitCommandFields,
} from '../architecture/ArchWriteCommands';
import type { ArchUnitUpdateFields } from '../architecture/ArchUnitStore';
import type { ArchUnitKind, ArchUnitStatus } from '../db/types';
import type { ServerMessage } from '../ws/types';
import { logger } from '../logger';
import {
  isToolShapedCapability,
  parseSessionRecordReadCapability,
} from '../session/orchestrator-config';

// ── Broadcast infrastructure ─────────────────────────────────────────────────
// Mirrors tasks.ts's task_updated wiring: REST stays the fetch/apply source of
// truth, WS only notifies clients (e.g. SessionPanel's decision panel) that a
// refetch-worthy change happened, carrying a live snapshot of the intent.
let stagedIntentBroadcastFn: ((msg: ServerMessage) => void) | null = null;

export function setStagedIntentBroadcast(
  fn: (msg: ServerMessage) => void,
): void {
  stagedIntentBroadcastFn = fn;
}

function broadcastIntentChange(intent: StagedIntent): void {
  stagedIntentBroadcastFn?.({ type: 'staged_intent_changed', intent });
}

function broadcastIntentById(id: string): void {
  const row = getStagedIntentRow(id);
  if (row) broadcastIntentChange(rowToApi(row));
}

/**
 * The durable replacement for groom-gate.mjs's self-reported hard_block_deps
 * array field: a task.setStatus->Ready apply is only allowed when its intent
 * group also carries a task.setDependsOn for the same task, forcing an
 * explicit dep-classification decision (an empty array is a valid "no deps").
 * Checked against the durable store, so a sibling committed in an earlier
 * apply in the same group still satisfies the invariant for a later apply.
 */
class DependsOnCompletenessError extends Error {
  constructor(taskId: string) {
    super(
      `[stagedIntents] task.setStatus -> Ready for task "${taskId}" is blocked: ` +
        'its intent group has no task.setDependsOn for this task. Stage an explicit ' +
        'dependency classification (an empty array is a valid "no deps") in the same group before promoting.',
    );
    this.name = 'DependsOnCompletenessError';
  }
}

function hasGroupDependsOn(groupId: string, taskId: string): boolean {
  const ACTIVE: StagedIntentState[] = ['staged', 'approved', 'committed'];
  return listStagedIntentsByGroup(groupId).some((row) => {
    if (row.kind !== 'task.setDependsOn' || !ACTIVE.includes(row.state)) {
      return false;
    }
    const payload = JSON.parse(row.payload) as SetDependsOnPayload;
    return payload.taskId === taskId;
  });
}

/**
 * True when the group already stages a live gate.accrete/seed.stage intent
 * for this task — group-commit ordering (`ordered` in commitGroupIntents)
 * always applies it, for real, before the arming task.setStatus -> Ready
 * intent, so its durable marker will exist by the time the real
 * TaskWriteCommands.setStatus gate check runs. Used only by
 * precheckGroupCommit, at commit time, to skip the corresponding accretion
 * check ahead of that real application — the real check always still runs,
 * against the real marker, once the group's non-arming intents have
 * actually applied. runStageTimeReadyChecks does NOT use this: at stage
 * time a setStatus-first ordering means the accretions may not be staged
 * yet, so it defers the contribution check entirely for any grouped flip
 * rather than relying on this staged-order-sensitive lookup.
 */
function hasGroupAccretionIntent(
  groupId: string,
  taskId: string,
  kind: 'gate.accrete' | 'seed.stage',
): boolean {
  const ACTIVE: StagedIntentState[] = ['staged', 'approved', 'committed'];
  return listStagedIntentsByGroup(groupId).some((row) => {
    if (row.kind !== kind || !ACTIVE.includes(row.state)) return false;
    return extractTaskId(row.kind, JSON.parse(row.payload)) === taskId;
  });
}

/**
 * The group's live gate.accrete payload for this task, when one is staged —
 * used by the strip⇔accrete content-match precheck to read the actual
 * accreted item texts (visible in the staged payload before the real
 * accretion has necessarily landed), the same "both sides visible in the
 * proposed group" read hasGroupAccretionIntent's ACTIVE-state lookup already
 * relies on.
 */
function getGroupGateAccretePayload(
  groupId: string,
  taskId: string,
): GateAccretePayload | undefined {
  const ACTIVE: StagedIntentState[] = ['staged', 'approved', 'committed'];
  const row = listStagedIntentsByGroup(groupId).find((r) => {
    if (r.kind !== 'gate.accrete' || !ACTIVE.includes(r.state)) return false;
    return extractTaskId('gate.accrete', JSON.parse(r.payload)) === taskId;
  });
  return row ? (JSON.parse(row.payload) as GateAccretePayload) : undefined;
}

/**
 * The seed.stage twin of getGroupGateAccretePayload — the group's live
 * seed.stage payload for this task, when one is staged, used by the
 * seed_contribution content-match precheck.
 */
function getGroupSeedStagePayload(
  groupId: string,
  taskId: string,
): SeedStagePayload | undefined {
  const ACTIVE: StagedIntentState[] = ['staged', 'approved', 'committed'];
  const row = listStagedIntentsByGroup(groupId).find((r) => {
    if (r.kind !== 'seed.stage' || !ACTIVE.includes(r.state)) return false;
    return extractTaskId('seed.stage', JSON.parse(r.payload)) === taskId;
  });
  return row ? (JSON.parse(row.payload) as SeedStagePayload) : undefined;
}

/** The exact heading text bodyRender.ts writes for the section (see bodyRender.ts:298,463). */
const MANUAL_VERIFICATION_SECTION = '👁️ Manual verification';

function isManualVerificationSection(section: string): boolean {
  return (
    section.trim().toLowerCase() === MANUAL_VERIFICATION_SECTION.toLowerCase()
  );
}

/**
 * The Manual-verification-strip twin of DependsOnCompletenessError: a
 * task.setStatus->Ready apply is only allowed when, for a task whose
 * pre-groom body carried a "### 👁️ Manual verification" section
 * (`groomingGate.hasManualVerificationSection`), its intent group also
 * carries a live task.patchBodySection remove targeting that heading —
 * forcing the strip to actually be staged rather than silently left in the
 * body post-promotion.
 */
class ManualVerificationStripCompletenessError extends Error {
  constructor(taskId: string) {
    super(
      `[stagedIntents] task.setStatus -> Ready for task "${taskId}" is blocked: ` +
        'its pre-groom body carries a "### 👁️ Manual verification" section and its intent group has no ' +
        'task.patchBodySection removing it. Stage a grouped remove patch for that section before promoting.',
    );
    this.name = 'ManualVerificationStripCompletenessError';
  }
}

/**
 * True when the group already stages a live task.patchBodySection remove
 * targeting the Manual verification heading for this task — same shape as
 * hasGroupDependsOn, checked against the durable store so a sibling
 * committed in an earlier apply in the same group still satisfies the
 * invariant for a later apply.
 */
function hasGroupManualVerificationStrip(
  groupId: string,
  taskId: string,
): boolean {
  const ACTIVE: StagedIntentState[] = ['staged', 'approved', 'committed'];
  return listStagedIntentsByGroup(groupId).some((row) => {
    if (row.kind !== 'task.patchBodySection' || !ACTIVE.includes(row.state)) {
      return false;
    }
    const payload = JSON.parse(row.payload) as PatchBodySectionPayload;
    return (
      payload.taskId === taskId &&
      payload.operation === 'remove' &&
      isManualVerificationSection(payload.section)
    );
  });
}

/**
 * Kinds whose payload carries a `taskId` naming an existing task this
 * session intends to mutate — the set a dispatched session must be bound to
 * its own `sessions.task_id` for. task.create is deliberately excluded: a
 * groom/design session legitimately files sibling and follow-on tasks, and a
 * new task has no id yet to compare.
 */
const SESSION_TASK_BINDING_KINDS: ReadonlySet<string> = new Set([
  'task.updateBody',
  'task.patchBodySection',
  'task.setStatus',
  'task.setProperties',
  'task.setDependsOn',
  'planning.noOp',
]);

/**
 * The confirmed-bug guard: a dispatched planning session staged a
 * task.updateBody whose payload taskId was a different, unrelated task,
 * picked from its candidate-blockers list by mistake — a raw string
 * mismatch this class of bug always is, since the two id-spaces
 * (hyphenated/bare, notion:-prefixed/bare) otherwise let a mistaken id slip
 * past an == comparison. Thrown at stage time, before any row reaches
 * `staged`, the same shape as DependsOnCompletenessError /
 * ManualVerificationStripCompletenessError above.
 */
export class SessionTaskBindingError extends Error {
  constructor(kind: string, sessionTaskId: string, payloadTaskId: string) {
    super(
      `[stagedIntents] "${kind}" targets task "${payloadTaskId}", but the dispatching session's own task is ` +
        `"${sessionTaskId}" — a session may only stage a task-write against its own task, or a task it ` +
        'created earlier in the same intent group.',
    );
    this.name = 'SessionTaskBindingError';
  }
}

/**
 * True when the group already stages a live task.create intent from this
 * same session — the "create-then-wire" escape hatch: a task.create intent
 * carries no id of its own to compare (extractTaskId returns null for it),
 * so once it commits and the resulting task is wired up by a later grouped
 * intent (e.g. task.setDependsOn) in the same group, that grouped intent's
 * taskId legitimately differs from the session's own task_id.
 */
function hasGroupTaskCreateForSession(
  groupId: string,
  sessionId: string,
): boolean {
  const ACTIVE: StagedIntentState[] = ['staged', 'approved', 'committed'];
  return listStagedIntentsByGroup(groupId).some(
    (row) =>
      row.kind === 'task.create' &&
      row.session_id === sessionId &&
      ACTIVE.includes(row.state),
  );
}

/**
 * Stage-time enforcement of the session/task binding: for every kind in
 * SESSION_TASK_BINDING_KINDS, the payload's taskId must normalize to the
 * same task as the dispatching session's own `sessions.task_id` (see
 * taskId.ts's normalizeTaskId — comparing on the full normalized id, never a
 * prefix, is what catches two ids sharing a long structured prefix but
 * differing in full). A session with no bound task (human-driven surfaces
 * pass no sessionId) or no recorded task_id is not checked — there is
 * nothing to bind against.
 */
function assertSessionTaskBinding(
  kind: string,
  payload: unknown,
  sessionId: string | null | undefined,
  groupId: string | null | undefined,
): void {
  if (!sessionId || !SESSION_TASK_BINDING_KINDS.has(kind)) return;
  const payloadTaskId = (payload as { taskId?: unknown } | null)?.taskId;
  if (typeof payloadTaskId !== 'string' || !payloadTaskId) return;

  const session = getSession(sessionId);
  if (!session?.task_id) return;

  if (normalizeTaskId(payloadTaskId) === normalizeTaskId(session.task_id)) {
    return;
  }
  if (groupId && hasGroupTaskCreateForSession(groupId, sessionId)) return;

  throw new SessionTaskBindingError(kind, session.task_id, payloadTaskId);
}

/**
 * The general staged-intent surface: a single chokepoint producers (Groom(N),
 * Ops(N), and future callers) stage generic { kind, payload } intents through,
 * and a human applies or rejects. Apply always dispatches through
 * TaskWriteCommands — never a bespoke per-producer write.
 *
 * Backed by the durable staged_intent table (db/schema.ts, db/queries.ts):
 * per-intent lifecycle staged -> approved -> committed | rejected |
 * superseded, content-idempotent dedup, and per-intent supersede tombstones.
 */
export interface StagedIntent {
  id: string;
  kind: string;
  payload: unknown;
  projectId: string;
  createdAt: number;
  /** The originating session, for panel correlation + pushback routing. Null for human-staged intents. */
  sessionId?: string | null;
  /** Current lifecycle state. */
  state: StagedIntentState;
  /** Pointer to the intent this one replaces, if any. */
  supersedes?: string | null;
  /**
   * Set when the last apply attempt was hard-blocked by the readiness gate
   * (violations) or the grooming promotion gate (reasons).
   */
  annotation?:
    | { blocked: true; violations: ReadinessViolation[] }
    | { blocked: true; reasons: string[] }
    | null;
  /**
   * Correlates multiple intents that form one structural-change unit (e.g. a
   * split's updateBody + createTask + setDependsOn intents), so the shared
   * display can present/apply them as a group rather than unrelated rows.
   */
  groupId?: string | null;
  /**
   * The human-facing rationale/summary the decision surface renders beside
   * the payload — the producer's proposal for why this intent should be
   * applied, distinct from `annotation` (a blocked-apply diagnostic).
   */
  decisionProposal?: string | null;
  /**
   * The /groom skill's structured proposal fields (presentation.md's
   * 4/5-point summary), carried by a dispatched groom session's Ready-flip
   * decision in place of a free-prose `decisionProposal`.
   */
  groomProposal?: GroomProposalFields | null;
  /**
   * Tier-3 semantic readiness advisory (paraphrased-deferral classifier) —
   * a caution signal distinct from `annotation`'s deterministic hard-block
   * channel. The surface reads annotation -> hard-block, advisory -> caution;
   * the two never coexist (Tier-3 only runs when the deterministic tiers
   * are not already blocking).
   */
  advisory?: {
    tier: 'semantic';
    status: 'pending' | 'clean' | 'flagged' | 'errored';
    confidence: number;
    findings: { detail: string; location?: string; quote?: string }[];
    model: string;
    checkedAt: number;
  } | null;
  /** Operator-supplied rationale for a reject disposition (pushback | decline). Null until rejected. */
  dispositionReason?: string | null;
  /** The operator's answer to a decision.pickOne question-intent. Null until answered. */
  answer?: StagedIntentAnswer | null;
}

function rowToApi(row: StagedIntentRow): StagedIntent {
  return {
    id: row.id,
    kind: row.kind,
    payload: JSON.parse(row.payload) as unknown,
    projectId: row.project_id,
    createdAt: row.created_at,
    sessionId: row.session_id,
    state: row.state,
    supersedes: row.supersedes,
    annotation: row.annotation
      ? (JSON.parse(row.annotation) as StagedIntent['annotation'])
      : null,
    groupId: row.group_id,
    decisionProposal: row.decision_proposal,
    groomProposal: row.groom_proposal
      ? (JSON.parse(row.groom_proposal) as GroomProposalFields)
      : null,
    advisory: row.advisory
      ? (JSON.parse(row.advisory) as StagedIntent['advisory'])
      : null,
    dispositionReason: row.disposition_reason,
    answer: row.answer ? (JSON.parse(row.answer) as StagedIntentAnswer) : null,
  };
}

/**
 * Kinds carry their target task at `payload.taskId`, except task.create — a
 * new task has no pre-existing id, so it dedups on title instead (see
 * extractTitleKey) — and gate.accrete/seed.stage, whose source task lives at
 * `payload.sourceTask.id`.
 */
function extractTaskId(kind: string, payload: unknown): string | null {
  if (kind === 'task.create' || kind === 'arch.createUnit') return null;
  if (kind === 'gate.accrete' || kind === 'seed.stage') {
    const sourceTaskId = (payload as { sourceTask?: { id?: unknown } } | null)
      ?.sourceTask?.id;
    return typeof sourceTaskId === 'string' ? sourceTaskId : null;
  }
  if (kind === 'arch.updateUnit' || kind === 'arch.supersedeUnit') {
    const unitId = (payload as { unitId?: unknown } | null)?.unitId;
    return typeof unitId === 'string' ? unitId : null;
  }
  if (kind === 'task.patchBodySection') {
    const p = payload as { taskId?: unknown; section?: unknown } | null;
    if (typeof p?.taskId !== 'string' || typeof p?.section !== 'string') {
      return null;
    }
    // Scoped to (taskId, section) rather than just taskId: two patches on
    // different sections of the same task must both stay active rather than
    // one superseding the other, while same-section patches still supersede
    // via the existing tombstone mechanism above.
    return `${p.taskId}::${p.section.trim()}`;
  }
  const taskId = (payload as { taskId?: unknown } | null)?.taskId;
  return typeof taskId === 'string' ? taskId : null;
}

/**
 * task.create/arch.createUnit's dedup identity: a not-yet-created task has no
 * id, but within one session a re-stage of the same proposed task is
 * identifiable by its (normalized) title — see
 * findActiveStagedIntentByTitleForSession. Narrower than decision.pickOne's
 * per-session rule, which would wrongly collapse distinct same-session tasks
 * that just happen to share no title.
 */
function extractTitleKey(kind: string, payload: unknown): string | null {
  if (kind !== 'task.create' && kind !== 'arch.createUnit') return null;
  const title = (payload as { title?: unknown } | null)?.title;
  if (typeof title !== 'string') return null;
  const normalized = title.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

/**
 * decision.pickOne's dedup identity: a question carries no taskId, so — like
 * task.create's title-keying above — it dedups on its own content within the
 * session, here the full normalized prompt rather than a truncation, so that
 * two distinct questions sharing a prefix never collide. A reworded question
 * is not caught by this key and instead relies on the caller passing
 * `explicitSupersedes` to retire its prior draft, the same escape a retitled
 * task.create uses.
 */
function extractPromptKey(kind: string, payload: unknown): string | null {
  if (kind !== 'decision.pickOne') return null;
  const prompt = (payload as { prompt?: unknown } | null)?.prompt;
  if (typeof prompt !== 'string') return null;
  const normalized = prompt.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

type CreateTaskPayload = CreateTaskCommandFields;
interface SetStatusPayload {
  taskId: string;
  status: TaskStatus;
  /** The /groom skill's size_check / type_check disposition — see groomGate.ts. */
  groomingGate?: GroomingGateEntry;
}
interface SetDependsOnPayload {
  taskId: string;
  dependsOn: string[];
}
interface UpdateBodyPayload {
  taskId: string;
  sections: TaskBodySections;
}
type PatchBodySectionPayload = {
  taskId: string;
  section: string;
} & PatchBodySectionOperation;
interface SetPropertiesPayload {
  taskId: string;
  patch: TaskPropertiesPatch;
}
interface SetTypePayload {
  taskId: string;
  type: TaskType;
}
interface ArchivePayload {
  taskId: string;
}
interface MoveTaskPayload {
  taskId: string;
  content: MoveTaskContent;
  sourceMilestone: MoveTaskMilestoneRef;
  targetMilestone: MoveTaskTargetMilestone;
  originalDisposition: 'archive' | 'defer';
}
interface GateAccretePayload {
  sourceTask: GateContributionSourceTask;
  items: GateContributionItemInput[];
  classification: GateContributionDecision;
  /** Required (and validated non-empty) when classification is 'none'/'n/a'. */
  reason?: string;
}
interface SeedStagePayload {
  sourceTask: SeedContributionSourceTask;
  seeds: SeedContributionItemInput[];
  decision: SeedContributionDecision;
}
interface JournalSetStatePayload {
  taskId: string;
  state: OpsState;
  fields?: Parameters<typeof setEntryState>[2];
}
/**
 * How a dispatched session expresses a capability request: the exact
 * tool/command or read it wants — a Bash command prefix, a named MCP write
 * verb, or the one grantable own-record read
 * (`read:session-record:<targetSessionId>`, see
 * `session/orchestrator-config.ts#sessionRecordReadCapability`) — never a
 * category, the plan it intends to use it for, and the evidence behind the
 * request. The target session (whose grant this becomes, once approved) is
 * always this intent's own session_id (set by the staging auth context),
 * never a payload field — a session cannot request a grant onto another
 * session, even for a read whose target-session-id parameter names a
 * different session's records.
 */
interface CapabilityRequestPayload {
  capability: string;
  plan: string;
  evidence: string;
}

/**
 * Payload for the completeness.disposition staged intent — the operator-
 * approvable twin of the durable completeness_disposition write (see
 * mcp/tools/completenessTools.ts / routes/design.ts, and
 * db/queries.ts's buildCompletenessDispositionRow). `rowId` names the
 * already-durably-written completeness_disposition row this intent's
 * approval/rejection advances — the write happens immediately at critic
 * time (disposition-don't-drop), independent of and before this intent is
 * ever disposed of.
 */
export interface CompletenessDispositionIntentPayload {
  taskId: string;
  rowId: number;
  project: string | null;
  milestone: string | null;
  probed: CompletenessProbedGapClass[];
  questions: CompletenessDispositionQuestion[];
  runAt: string;
}

/** The kind/topic/regions/status envelope shared by all three arch.* kinds. */
interface ArchUnitMetadataPayload {
  kind: ArchUnitKind;
  topic: string;
  regions: string[];
  status?: ArchUnitStatus;
}
interface ArchCreateUnitPayload {
  title: string;
  metadata: ArchUnitMetadataPayload;
  body: string;
}
interface ArchUpdateUnitPayload {
  unitId: string;
  /** The unit's version this edit was composed against — optimistic concurrency. */
  baseVersion: number;
  title?: string;
  metadata?: Partial<ArchUnitMetadataPayload>;
  body?: string;
}
interface ArchSupersedeUnitPayload {
  unitId: string;
  /** The unit's version this supersede was composed against — optimistic concurrency. */
  baseVersion: number;
  replacement: ArchCreateUnitPayload;
}

function toNewArchUnitFields(
  payload: ArchCreateUnitPayload,
): NewArchUnitCommandFields {
  return {
    title: payload.title,
    kind: payload.metadata.kind,
    topic: payload.metadata.topic,
    regions: payload.metadata.regions,
    status: payload.metadata.status,
    body: payload.body,
  };
}

function toArchUnitUpdateFields(
  payload: ArchUpdateUnitPayload,
): ArchUnitUpdateFields {
  return {
    title: payload.title,
    kind: payload.metadata?.kind,
    topic: payload.metadata?.topic,
    regions: payload.metadata?.regions,
    status: payload.metadata?.status,
    body: payload.body,
  };
}

/**
 * Locks the capability vocabulary at stage time (see the design task "Lock
 * the capability vocabulary for dispatched planning sessions"): a
 * session.requestCapability's `capability` must be tool-shaped
 * (`isToolShapedCapability` — `Bash(...)`/`mcp__...`) or the registered
 * own-record-read prefix (`parseSessionRecordReadCapability` —
 * `read:session-record:<id>`), since those are the only shapes that ever
 * actually widen a session's access. A non-conforming string (e.g.
 * "banana") is rejected here, before the row ever reaches `staged`, rather
 * than being durably granted and silently never taking effect. This is
 * distinct from and does not replace `isGrantable`'s denylist check, which
 * stays at grant/approval time for well-formed-but-denylisted requests
 * (e.g. `Write`).
 */
class CapabilityRequestValidationError extends Error {
  constructor(capability: string) {
    super(
      `[stagedIntents] session.requestCapability rejected: "${capability}" is not a ` +
        'supported capability shape — expected a tool-shaped capability ' +
        '("Bash(...)" or "mcp__...") or "read:session-record:<id>"',
    );
    this.name = 'CapabilityRequestValidationError';
  }
}

function validateCapabilityRequestPayload(
  payload: unknown,
): asserts payload is CapabilityRequestPayload {
  const p = payload as Partial<CapabilityRequestPayload> | null;
  const capability = p?.capability;
  if (typeof capability !== 'string') {
    throw new CapabilityRequestValidationError(String(capability));
  }
  if (
    !isToolShapedCapability(capability) &&
    parseSessionRecordReadCapability(capability) === null
  ) {
    throw new CapabilityRequestValidationError(capability);
  }
}

/**
 * Payload for the `planning.noOp` staged intent — a dispatched planning
 * session's deliberate declaration that it reached terminal with nothing to
 * change, distinct from a silent park. Rendered on the decision surface as
 * informational/auditable and requires no operator disposition (see
 * StagedIntentPanel.tsx's NoOpHeadline) — its purpose is to make a
 * legitimate empty run visible to the operator, not to gate anything.
 */
interface NoOpPayload {
  taskId: string;
  reason: string;
}

/**
 * The no-op-as-escape-hatch guard: a bare `{}` or an empty reason would let
 * a session declare "nothing to do" without ever having to say why, which
 * defeats the point of the marker (the operator sees it and can judge
 * whether the reasoning holds up).
 */
class NoOpValidationError extends Error {
  constructor(reason: string) {
    super(`[stagedIntents] planning.noOp rejected: ${reason}`);
    this.name = 'NoOpValidationError';
  }
}

function validateNoOpPayload(payload: unknown): asserts payload is NoOpPayload {
  const p = payload as Partial<NoOpPayload> | null;
  if (typeof p?.taskId !== 'string' || !p.taskId.trim()) {
    throw new NoOpValidationError('payload.taskId is required');
  }
  if (typeof p?.reason !== 'string' || !p.reason.trim()) {
    throw new NoOpValidationError(
      'payload.reason is required — a one-line why-nothing-to-change explanation',
    );
  }
}

/**
 * Validates a decision.pickOne payload/staging request — throws
 * DecisionPickOneValidationError on the first violation. A question-intent
 * writes no task store, so it must carry its own substantive justification
 * (decisionProposal) and per-option descriptions rather than leaning on a
 * task-store diff for context; it also cannot belong to a group, since a
 * group is a structural-change unit and this stages no write at all.
 */
class DecisionPickOneValidationError extends Error {
  constructor(reason: string) {
    super(`[stagedIntents] decision.pickOne rejected: ${reason}`);
    this.name = 'DecisionPickOneValidationError';
  }
}

function validateDecisionPickOnePayload(
  payload: unknown,
  groupId: string | null | undefined,
  decisionProposal: string | null | undefined,
): asserts payload is DecisionPickOnePayload {
  if (groupId) {
    throw new DecisionPickOneValidationError(
      'a decision.pickOne question cannot belong to a group — it stages no concrete write',
    );
  }
  if (!decisionProposal?.trim()) {
    throw new DecisionPickOneValidationError(
      'a substantive decisionProposal (why this fork needs an operator decision) is required',
    );
  }
  const p = payload as Partial<DecisionPickOnePayload> | null;
  if (!p || typeof p.prompt !== 'string' || !p.prompt.trim()) {
    throw new DecisionPickOneValidationError('payload.prompt is required');
  }
  if (!Array.isArray(p.options) || p.options.length < 1) {
    throw new DecisionPickOneValidationError(
      'payload.options must list at least one candidate option',
    );
  }
  for (const opt of p.options) {
    if (!opt || typeof opt.label !== 'string' || !opt.label.trim()) {
      throw new DecisionPickOneValidationError(
        'every option requires a non-empty label',
      );
    }
    if (typeof opt.description !== 'string' || !opt.description.trim()) {
      throw new DecisionPickOneValidationError(
        `option "${opt.label}" requires a substantive description`,
      );
    }
  }
  if (typeof p.allowFreeForm !== 'boolean') {
    throw new DecisionPickOneValidationError(
      'payload.allowFreeForm must be a boolean',
    );
  }
}

/**
 * A session.requestCapability twin of DecisionPickOneValidationError: a
 * capability request applies via SessionManager.grantCapability + a
 * session respawn (see resumeCapabilityRequester), never via applyIntent —
 * it cannot share atomicity with a set of task-store writes, so it must not
 * belong to a group. Refusing this at stage time is what keeps
 * commitGroupIntents/applyIntent from ever seeing the kind at all (the
 * `default:` unknown-kind throw there stays reserved for a genuinely
 * unrecognised kind). A sibling of CapabilityRequestValidationError (the
 * capability-shape guard above) rather than a reuse of it, since this
 * guards a structural property (groupId) rather than the payload shape.
 */
class CapabilityRequestGroupValidationError extends Error {
  constructor(reason: string) {
    super(`[stagedIntents] session.requestCapability rejected: ${reason}`);
    this.name = 'CapabilityRequestGroupValidationError';
  }
}

function validateCapabilityRequestDoesNotCarryGroup(
  groupId: string | null | undefined,
): void {
  if (groupId) {
    throw new CapabilityRequestGroupValidationError(
      'a session.requestCapability cannot belong to a group — it applies via ' +
        'SessionManager.grantCapability + a session respawn, not via a group commit',
    );
  }
}

/**
 * Thrown by validateAndNormalizeTaskReferences when a staged intent's task
 * reference (taskId or a dependsOn entry) is malformed or does not resolve
 * to an existing task — surfaced at stage time so a corrupted or unprefixed
 * id never reaches apply, where it would otherwise fail as a raw provider
 * 404 or a parser exception (see taskId.ts's parseTaskId) days later, after
 * an operator has already spent the staged/apply review window on it.
 */
class TaskReferenceValidationError extends Error {
  constructor(message: string) {
    super(`[stagedIntents] ${message}`);
    this.name = 'TaskReferenceValidationError';
  }
}

/**
 * Prefix marking a `task.setDependsOn` `dependsOn` entry as a group-local
 * symbolic reference to a sibling `task.create` intent staged in the same
 * group, rather than a literal task id — the create-then-wire affordance: a
 * session that stages a `task.create` for a just-discovered prerequisite can
 * stage the dependency edge onto it in the same breath, instead of handing
 * the operator a manual "apply the create, then point Depends On at the
 * resulting id" follow-up. The reference names the sibling intent by its own
 * staged-intent id (already unique, no new alias namespace needed) and is
 * resolved to the real created task id by the commit loop
 * (`commitGroupIntents`) — it is never written to the backend as-is.
 */
const SYMBOLIC_CREATE_REF_PREFIX = 'staged-intent:';

function parseSymbolicCreateRef(value: string): string | null {
  if (!value.startsWith(SYMBOLIC_CREATE_REF_PREFIX)) return null;
  const intentId = value.slice(SYMBOLIC_CREATE_REF_PREFIX.length).trim();
  return intentId || null;
}

/**
 * Builds a symbolic reference to a staged (not-yet-applied) `task.create`
 * intent's eventual real task id — see `parseSymbolicCreateRef` above.
 * Exported for splitSession.ts, whose sibling-depends-on-sibling case needs
 * this both as a `task.setDependsOn` subject `taskId` and as a `dependsOn`
 * entry; `commitGroupIntents` resolves either.
 */
export function symbolicCreateRef(intentId: string): string {
  return `${SYMBOLIC_CREATE_REF_PREFIX}${intentId}`;
}

/**
 * Stage-time validation for a symbolic `dependsOn` entry: it must resolve to
 * a live `task.create` intent staged in the *same* group. Never resolves
 * across groups — that would open a second route to the cross-task write
 * already tracked by 3ab22f91-52f3-81d8-a55b-f4a23b4ec80a — and never
 * resolves to a non-`task.create` intent or one that has been withdrawn/
 * rejected/superseded.
 */
function assertSymbolicCreateRefResolves(
  intentId: string,
  groupId: string | null | undefined,
  fieldLabel: string,
): void {
  const ACTIVE: StagedIntentState[] = ['staged', 'approved', 'committed'];
  const referenced = groupId ? getStagedIntentRow(intentId) : null;
  if (
    !groupId ||
    !referenced ||
    referenced.kind !== 'task.create' ||
    referenced.group_id !== groupId ||
    !ACTIVE.includes(referenced.state)
  ) {
    throw new TaskReferenceValidationError(
      `${fieldLabel} "${SYMBOLIC_CREATE_REF_PREFIX}${intentId}" does not resolve to a live ` +
        'task.create intent in this same staged-intent group',
    );
  }
}

/**
 * Thrown when a gate.accrete's resolved source task, or a
 * task.patchBodySection remove targeting the Manual verification section, is
 * a 🔎 Investigation. An Investigation self-verifies in-session — its
 * acceptance criteria belong in its own "👁️ Manual verification" body
 * section, never relocated to the milestone gate — so neither write is
 * accepted at all, rather than silently dropped, which would let the
 * criteria go missing with no visible trace. 🔧 Operational is unaffected:
 * it legitimately accretes, per the operator's 2026-07-27 decision.
 */
class InvestigationAccretionRejectedError extends Error {
  constructor(kind: string, taskId: string) {
    super(
      `[stagedIntents] ${kind} rejected for task "${taskId}": its Type is 🔎 Investigation, ` +
        'which self-verifies in-session and must never accrete to the Manual Verification Gate ' +
        'or have its "👁️ Manual verification" section stripped.',
    );
    this.name = 'InvestigationAccretionRejectedError';
  }
}

/**
 * Thrown when a journal.setState intent's transition is illegal from the
 * journal's *current* state at stage time — the same authority
 * (`isValidOpsTransition`, reading `ALLOWED_TRANSITIONS`) apply time already
 * enforces, run here so the session (or the operator reviewing the decision
 * surface) sees the rejection immediately rather than after an operator
 * disposition has been spent staging/approving an intent that can never
 * apply. This never replaces the apply-time check in setEntryState — the
 * journal's state can still change between stage and apply (e.g. a sibling
 * intent applies first), so apply time remains the sole hard authority.
 */
class OpsJournalTransitionRejectedError extends Error {
  constructor(taskId: string, from: OpsState, to: OpsState) {
    const legalTargets = ALLOWED_TRANSITIONS[from];
    const legalTargetsText = legalTargets.length
      ? legalTargets.map((s) => `"${s}"`).join(', ')
      : `(none — "${from}" is terminal)`;
    super(
      `[stagedIntents] journal.setState rejected for task "${taskId}": "${from}" -> "${to}" ` +
        `is not a legal ops_journal transition. Current state is "${from}"; legal targets are: ` +
        `${legalTargetsText}.`,
    );
    this.name = 'OpsJournalTransitionRejectedError';
  }
}

/**
 * Parses/normalizes one raw task-reference id. A bare id (no `source:`
 * prefix) is unambiguous — every unprefixed id surfacing in this system
 * originates from Notion (board rows, groom-context bundles) — so it is
 * normalized to `notion:<id>` rather than rejected. A prefixed id must parse
 * cleanly via taskId.ts's parseTaskId or is rejected outright: guessing at a
 * malformed prefixed id risks resolving a near-miss uuid to a real but wrong
 * task, the exact failure class the full-id matching rule exists to prevent.
 */
function normalizeOrRejectTaskId(raw: unknown, fieldLabel: string): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new TaskReferenceValidationError(
      `${fieldLabel} must be a non-empty task id string, got ${JSON.stringify(raw)}`,
    );
  }
  if (raw.includes(':')) {
    try {
      parseTaskId(raw);
    } catch (err) {
      throw new TaskReferenceValidationError(
        `${fieldLabel} "${raw}" is not a recognized task id — expected ` +
          `"source:externalId" (source one of notion/yaml/jira/github): ${(err as Error).message}`,
      );
    }
    return raw;
  }
  return normalizeTaskId(raw);
}

/**
 * Live-existence check for a normalized task id. The task cache (cheap,
 * synchronous, populated by TaskCacheRefresher) is checked first; a miss
 * falls back to a live backend fetch before rejecting, so a cold or
 * never-populated cache never spuriously rejects a real task id.
 */
async function assertTaskIdResolves(
  taskId: string,
  projectId: string,
): Promise<void> {
  if (getTaskCache(taskId)) return;
  try {
    const page = await getTaskBackend(projectId).fetchTaskPage(taskId);
    if (page !== null && page !== undefined) return;
  } catch {
    // falls through to the rejection below
  }
  throw new TaskReferenceValidationError(
    `task id "${taskId}" does not resolve to an existing task`,
  );
}

/** Kinds whose payload.taskId is a subject reference that must resolve to an existing task. */
const SUBJECT_TASK_ID_KINDS: ReadonlySet<string> = new Set([
  'task.setStatus',
  'task.updateBody',
  'task.patchBodySection',
  'task.setProperties',
  'task.setDependsOn',
  'planning.noOp',
]);

/**
 * Stage-time validation + normalization of every task reference a staged
 * intent's payload carries: the taskId subject (skipped for task.create,
 * which names no pre-existing task) and every dependsOn entry
 * (task.setDependsOn's subject dependencies, task.create's proposed
 * dependencies). Mirrors the existing-source-task check gate/seed
 * accretion already run before accepting a contribution — a mis-keyed or
 * unprefixed id is caught here, before the intent is ever staged, instead
 * of surfacing as an apply-time provider error after an operator's review
 * window has already been spent. A dependsOn entry may instead be a
 * `SYMBOLIC_CREATE_REF_PREFIX`-prefixed group-local reference to a sibling
 * task.create intent (by that intent's own staged-intent id) — validated
 * against `groupId` and left as-is (never normalized to a real task id;
 * there isn't one yet) for the commit loop to resolve. Returns the payload
 * with every literal dependsOn entry normalized to prefixed form — the
 * shape apply time requires, since
 * NotionClient.setDependsOn parses each entry with no bare-id fallback
 * (taskId.ts's toExternalId, unlike normalizeTaskId, throws on a bare id).
 * The taskId subject is validated (existence + shape) but left as the
 * caller supplied it: every backend already normalizes its own taskId
 * argument internally (see NotionTaskBackend), so rewriting it here would
 * only risk diverging from what downstream code expects verbatim. Throws
 * TaskReferenceValidationError on anything unparseable or unresolvable. A
 * no-op for kinds that carry no task reference in scope (seed.stage keys off
 * sourceTask, arch.* off unitId — neither is a board task reference), except
 * gate.accrete and a Manual-verification-removing task.patchBodySection,
 * which this also checks — before any other validation — for a resolved 🔎
 * Investigation source/subject task, throwing
 * InvestigationAccretionRejectedError if so (see that class).
 */
export async function validateAndNormalizeTaskReferences(
  kind: string,
  payload: unknown,
  projectId: string,
  groupId?: string | null,
): Promise<unknown> {
  if (kind === 'gate.accrete') {
    const sourceTaskId = (payload as { sourceTask?: { id?: unknown } } | null)
      ?.sourceTask?.id;
    if (typeof sourceTaskId === 'string') {
      if (getCachedType(sourceTaskId) === '🔎 Investigation') {
        throw new InvestigationAccretionRejectedError(kind, sourceTaskId);
      }
    }
  }

  if (kind === 'task.patchBodySection') {
    const p = payload as {
      taskId?: unknown;
      section?: unknown;
      operation?: unknown;
    } | null;
    if (
      typeof p?.taskId === 'string' &&
      typeof p?.section === 'string' &&
      p.operation === 'remove' &&
      isManualVerificationSection(p.section) &&
      getCachedType(p.taskId) === '🔎 Investigation'
    ) {
      throw new InvestigationAccretionRejectedError(kind, p.taskId);
    }
  }

  if (kind === 'journal.setState') {
    const p = payload as { taskId?: unknown; state?: unknown } | null;
    if (typeof p?.taskId === 'string' && typeof p?.state === 'string') {
      const entry = getOpsJournalEntry(p.taskId);
      const targetState = p.state as OpsState;
      if (entry && !isValidOpsTransition(entry.state, targetState)) {
        throw new OpsJournalTransitionRejectedError(
          p.taskId,
          entry.state,
          targetState,
        );
      }
    }
  }

  if (!SUBJECT_TASK_ID_KINDS.has(kind) && kind !== 'task.create') {
    return payload;
  }
  const p = { ...(payload as Record<string, unknown>) };

  if (SUBJECT_TASK_ID_KINDS.has(kind)) {
    const normalized = normalizeOrRejectTaskId(p.taskId, 'taskId');
    await assertTaskIdResolves(normalized, projectId);
  }

  if (kind === 'task.setDependsOn' || kind === 'task.create') {
    const rawDependsOn = p.dependsOn;
    if (rawDependsOn !== undefined) {
      if (!Array.isArray(rawDependsOn)) {
        throw new TaskReferenceValidationError(
          'dependsOn must be an array of task ids',
        );
      }
      const normalizedDependsOn: string[] = [];
      for (const [i, dep] of rawDependsOn.entries()) {
        // Symbolic references are accepted only for task.setDependsOn — an
        // existing task wiring onto a sibling task.create. task.create's own
        // dependsOn names dependencies of the task being created itself; a
        // symbolic reference there would be a sibling-create-depends-on-
        // sibling-create (a symbolic *subject* id) case, out of this task's
        // scope (see e3d05d03-6a79-4a48-86cd-defcbfd51aed) and unresolved by
        // the commit loop below.
        const symbolicIntentId =
          kind === 'task.setDependsOn' && typeof dep === 'string'
            ? parseSymbolicCreateRef(dep)
            : null;
        if (symbolicIntentId) {
          assertSymbolicCreateRefResolves(
            symbolicIntentId,
            groupId,
            `dependsOn[${i}]`,
          );
          normalizedDependsOn.push(dep as string);
          continue;
        }
        const normalized = normalizeOrRejectTaskId(dep, `dependsOn[${i}]`);
        await assertTaskIdResolves(normalized, projectId);
        normalizedDependsOn.push(normalized);
      }
      p.dependsOn = normalizedDependsOn;
    }
  }

  return p;
}

/**
 * Intent kinds accepted by POST /staged-intents. `intent.withdraw` is not
 * actually staged through this route — it acts immediately on an existing
 * intent (see withdrawIntent below) — but it is a real member of the kind
 * registry so it can be advertised in a dispatched session's injected
 * procedure (renderIntentKindInvocations) and satisfy the
 * planningIntentKindsParity guard (every PLANNING_INTENT_KINDS entry must be
 * a KNOWN_INTENT_KINDS member).
 */
export const KNOWN_INTENT_KINDS: ReadonlySet<string> = new Set([
  'task.create',
  'task.setStatus',
  'task.setDependsOn',
  'task.updateBody',
  'task.patchBodySection',
  'task.setProperties',
  'task.setType',
  'task.archive',
  'task.move',
  'gate.accrete',
  'seed.stage',
  'decision.pickOne',
  'journal.setState',
  'arch.createUnit',
  'arch.updateUnit',
  'arch.supersedeUnit',
  'session.requestCapability',
  'completeness.disposition',
  'intent.withdraw',
  'planning.noOp',
]);

/**
 * Stage a task-write intent into the durable store — the single chokepoint
 * both the human-facing POST /staged-intents route and the loopback session
 * stage endpoint (POST /api/task-intents) write through. Never touches the
 * task backend; staging is purely bookkeeping until a human applies (or
 * rejects) the intent.
 *
 * Content-idempotent banked approval: for kinds that carry a taskId (every
 * kind except task.create), a re-emission that exactly matches the standing
 * staged/approved intent for the same (projectId, kind, taskId) is a no-op —
 * the existing row (and its approval, if any) is returned untouched, except
 * that a groupId carried by the re-emission which the existing row lacks (or
 * differs from) is applied to the existing row in place — groupId is settable
 * grouping metadata, not part of the content-idempotent identity. A
 * re-emission that differs on payload supersedes the standing intent
 * (tombstoning it) and re-enters `staged`, requiring fresh approval.
 * decision.pickOne carries no taskId (it is a question, not a task write),
 * so it dedups instead on (sessionId, normalized prompt) — see
 * extractPromptKey / findActiveDecisionPickOneForSession — the same shape as
 * task.create/arch.createUnit below, so several independent questions can
 * stay live in one session while a re-staged one still retires its own
 * prior draft. task.create/arch.createUnit carry no taskId either (nothing
 * exists yet to key on), so they dedup on (sessionId, normalized title)
 * instead — see extractTitleKey / findActiveStagedIntentByTitleForSession. A caller can
 * also pass `explicitSupersedes` to retire a specific prior intent by id —
 * the only way to supersede a draft whose title is also changing, since
 * title-keying alone can't identify it. Superseding (either path) is a
 * bookkeeping tombstone, not an operator decision: it never emits a
 * staged_intent_disposition audit event and never calls
 * PlanningOrchestrator.handleDisposition.
 */
const GROOM_PROPOSAL_FIELDS = [
  'achieves',
  'openQuestions',
  'automatedTests',
  'manualVerification',
  'operationalSeed',
] as const;

/** Validates the /groom skill's structured proposal shape — every field must be present and a string. */
function parseGroomProposal(value: unknown): GroomProposalFields | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const field of GROOM_PROPOSAL_FIELDS) {
    if (typeof record[field] !== 'string') return null;
  }
  return {
    achieves: record.achieves as string,
    openQuestions: record.openQuestions as string,
    automatedTests: record.automatedTests as string,
    manualVerification: record.manualVerification as string,
    operationalSeed: record.operationalSeed as string,
  };
}

/**
 * States an explicit `explicitSupersedes` pointer may target — wider than
 * ACTIVE_STATES (staged/approved) because a needs_revision intent is exactly
 * the thing a caller's explicit pointer most needs to retire: it's the state
 * a stage-time validation block leaves behind, and the state machine
 * (STAGED_INTENT_TRANSITIONS in db/queries.ts) already permits
 * needs_revision -> superseded. The implicit (payload-hash/title/prompt)
 * lookup paths below intentionally keep the narrower ACTIVE_STATES filter —
 * a blocked intent must not be silently resurrected as an implicit target,
 * only a caller that names it explicitly may retire it.
 */
const EXPLICIT_SUPERSEDES_ALLOWED_STATES: StagedIntentState[] = [
  'staged',
  'approved',
  'needs_revision',
];

/**
 * Names the supported alternative for a refused explicit-supersede target, so
 * the error tells the caller what to do instead of only what it cannot do.
 * - committed: the change already applied — history must not be rewritten by
 *   a supersede; stage a new corrective intent instead.
 * - rejected: an operator explicitly declined this intent (decline); staging
 *   a variant is precisely what should not happen — raise it with the
 *   operator instead of re-staging.
 * - withdrawn: the staging session itself already withdrew this intent;
 *   stage a fresh intent instead of superseding a row that's already gone.
 * - superseded: already retired by another supersede; target the newer
 *   intent, or stage fresh.
 */
function explicitSupersedesAlternative(state: StagedIntentState): string {
  switch (state) {
    case 'committed':
      return 'a committed intent cannot be superseded — stage a new corrective intent instead';
    case 'rejected':
      return 'this intent was declined by the operator — stage a new intent (or raise it with the operator) instead of superseding it';
    case 'withdrawn':
      return 'this intent was already withdrawn — stage a fresh intent instead of superseding it';
    case 'superseded':
      return 'this intent was already superseded — target its replacement, or stage a fresh intent';
    default:
      return 'stage a new intent instead';
  }
}

/** An explicit `explicitSupersedes` pointer that cannot be honoured — never silently dropped. */
export class ExplicitSupersedesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExplicitSupersedesError';
  }
}

/**
 * The design terminal-artifacts kinds DESIGN_TERMINAL_ARTIFACTS_ORDERING
 * (procedureCore.ts) requires the completeness critic's findings be accepted
 * before: the three arch.* writes, task.updateBody — which in a design
 * session is staged exactly once, as the closing synthesis (see
 * "design-closing-synthesis" in procedureCore.ts), so this never conflicts
 * with a groom/ops session's unrelated task.updateBody use — and task.create,
 * the follow-on-task set DESIGN_TERMINAL_ARTIFACTS_ORDERING also names as a
 * terminal artifact. task.create carries no bound taskId of its own to check
 * against (extractTaskId returns null for it — see assertCompletenessApproval,
 * which checks the *session's* bound task instead), so gating it here closes
 * task …3012260f's ordering hole: a follow-on task could otherwise be staged
 * (and, in a group, committed) minutes before the disposition that was
 * supposed to gate it was even approved.
 */
const COMPLETENESS_GATED_KINDS: ReadonlySet<string> = new Set([
  'arch.createUnit',
  'arch.updateUnit',
  'arch.supersedeUnit',
  'task.updateBody',
  'task.create',
]);

/**
 * Thrown at stage time when a design session attempts one of
 * COMPLETENESS_GATED_KINDS before its bound task's completeness.disposition
 * intent has been approved — tightens DESIGN_TERMINAL_ARTIFACTS_ORDERING
 * from "the critic has run" to "the critic's findings were accepted".
 */
class CompletenessApprovalRequiredError extends Error {
  constructor(kind: string, taskId: string) {
    super(
      `[stagedIntents] "${kind}" for design task "${taskId}" is blocked: the completeness critic's ` +
        'dispositions for this task have not been approved yet. Stage a completeness.disposition ' +
        'intent (if one is not already staged) and get operator approval before staging architecture ' +
        'or closing-synthesis writes.',
    );
    this.name = 'CompletenessApprovalRequiredError';
  }
}

/**
 * Stage-time enforcement of the completeness-critic approval gate: for a
 * COMPLETENESS_GATED_KINDS write from a dispatched design session, at least
 * one of that session's completeness.disposition intents for its own bound
 * task must be `committed` (approve is terminal for this kind — see the
 * POST /staged-intents/:id/approve completeness.disposition branch). Scoped
 * to a session bound to a task (`sessions.task_id`) whose session_type is
 * `design` — a human-staged intent with no originating session, or any
 * non-design session, is not checked here, mirroring
 * assertSessionTaskBinding's own scoping. A rejected completeness.disposition
 * intent does not strand the session: re-running the critic stages a fresh
 * intent (the prior one is terminal, so it is never matched by the dedup
 * lookup in stageIntent), which this then re-checks the same way — no second
 * critic run is required, only a fresh disposition + approval.
 */
function assertCompletenessApproval(
  kind: string,
  sessionId: string | null | undefined,
): void {
  if (!COMPLETENESS_GATED_KINDS.has(kind) || !sessionId) return;
  const session = getSession(sessionId);
  if (!session?.task_id || session.session_type !== 'design') return;
  const taskId = normalizeTaskId(session.task_id);

  const approved = listStagedIntentsBySession(sessionId).some((row) => {
    if (row.kind !== 'completeness.disposition' || row.state !== 'committed') {
      return false;
    }
    const payload = JSON.parse(
      row.payload,
    ) as CompletenessDispositionIntentPayload;
    return normalizeTaskId(payload.taskId) === taskId;
  });
  if (!approved) {
    throw new CompletenessApprovalRequiredError(kind, taskId);
  }
}

export function stageIntent(
  kind: string,
  payload: unknown,
  projectId: string,
  groupId?: string | null,
  sessionId?: string | null,
  decisionProposal?: string | null,
  groomProposal?: GroomProposalFields | null,
  explicitSupersedes?: string | null,
): StagedIntent {
  if (kind === 'decision.pickOne') {
    validateDecisionPickOnePayload(payload, groupId, decisionProposal);
  }
  if (kind === 'session.requestCapability') {
    validateCapabilityRequestPayload(payload);
    validateCapabilityRequestDoesNotCarryGroup(groupId);
  }
  if (kind === 'planning.noOp') {
    validateNoOpPayload(payload);
  }

  assertSessionTaskBinding(kind, payload, sessionId, groupId);
  assertCompletenessApproval(kind, sessionId);

  const taskId = extractTaskId(kind, payload);
  const titleKey = extractTitleKey(kind, payload);
  const promptKey = extractPromptKey(kind, payload);
  const payloadHash = hashIntentPayload(payload);
  const now = Date.now();
  const groomProposalJson = groomProposal
    ? JSON.stringify(groomProposal)
    : null;

  let explicitValid: StagedIntentRow | undefined;
  if (explicitSupersedes && sessionId) {
    const explicit = getStagedIntentRow(explicitSupersedes);
    if (!explicit) {
      throw new ExplicitSupersedesError(
        `explicit supersedes target "${explicitSupersedes}" was not found`,
      );
    }
    if (explicit.kind !== kind) {
      throw new ExplicitSupersedesError(
        `explicit supersedes target "${explicitSupersedes}" has kind "${explicit.kind}", expected "${kind}"`,
      );
    }
    if (explicit.project_id !== projectId) {
      throw new ExplicitSupersedesError(
        `explicit supersedes target "${explicitSupersedes}" belongs to a different project`,
      );
    }
    if (explicit.session_id !== sessionId) {
      throw new ExplicitSupersedesError(
        `explicit supersedes target "${explicitSupersedes}" belongs to a different session`,
      );
    }
    if (!EXPLICIT_SUPERSEDES_ALLOWED_STATES.includes(explicit.state)) {
      throw new ExplicitSupersedesError(
        `explicit supersedes target "${explicitSupersedes}" is in state "${explicit.state}" and cannot be ` +
          `superseded; ${explicitSupersedesAlternative(explicit.state)}`,
      );
    }
    explicitValid = explicit;
  }

  const existing = explicitValid
    ? explicitValid
    : taskId
      ? findActiveStagedIntentForTask(projectId, kind, taskId)
      : promptKey && sessionId
        ? findActiveDecisionPickOneForSession(sessionId, promptKey)
        : titleKey && sessionId
          ? findActiveStagedIntentByTitleForSession(
              projectId,
              kind,
              sessionId,
              titleKey,
            )
          : undefined;

  if (existing) {
    if (existing !== explicitValid && existing.payload_hash === payloadHash) {
      if (groupId && groupId !== existing.group_id) {
        const grouped = setStagedIntentGroup(existing.id, groupId);
        broadcastIntentChange(rowToApi(grouped));
        return rowToApi(grouped);
      }
      return rowToApi(existing);
    }
    const newRow: StagedIntentRow = {
      id: randomUUID(),
      kind,
      payload: JSON.stringify(payload ?? null),
      payload_hash: payloadHash,
      task_id: taskId,
      project_id: projectId,
      session_id: sessionId ?? null,
      group_id: groupId ?? null,
      state: 'staged',
      supersedes: null,
      annotation: null,
      decision_proposal: decisionProposal ?? null,
      groom_proposal: groomProposalJson,
      advisory: null,
      disposition_reason: null,
      answer: null,
      created_at: now,
      updated_at: now,
    };
    const superseded = rowToApi(supersedeStagedIntent(existing.id, newRow));
    broadcastIntentChange(superseded);
    return superseded;
  }

  const row: StagedIntentRow = {
    id: randomUUID(),
    kind,
    payload: JSON.stringify(payload ?? null),
    payload_hash: payloadHash,
    task_id: taskId,
    project_id: projectId,
    session_id: sessionId ?? null,
    group_id: groupId ?? null,
    state: 'staged',
    supersedes: null,
    annotation: null,
    decision_proposal: decisionProposal ?? null,
    groom_proposal: groomProposalJson,
    advisory: null,
    disposition_reason: null,
    answer: null,
    created_at: now,
    updated_at: now,
  };
  insertStagedIntent(row);
  const staged = rowToApi(row);
  broadcastIntentChange(staged);
  return staged;
}

/** States a session may still withdraw from — mirrors ACTIVE_STATES below (declared later in this file). */
const WITHDRAWABLE_STATES: StagedIntentState[] = ['staged', 'approved'];

/**
 * Thrown by withdrawIntent when the withdrawal cannot be honoured — never
 * silently dropped, mirroring ExplicitSupersedesError's shape above.
 */
export class IntentWithdrawError extends Error {
  constructor(message: string) {
    super(`[stagedIntents] ${message}`);
    this.name = 'IntentWithdrawError';
  }
}

/**
 * A session's self-caught-mistake escape hatch (the confirmed-bug fix): a
 * dispatched planning session can withdraw an intent it staged itself,
 * before an operator has disposed of it, instead of the only channel being
 * prose in its closing message that carries no weight in the apply path.
 * Unlike a reject disposition, this is not an operator action — it requires
 * no operator involvement and never resumes the session (there is nothing
 * for the session to be told; it already knows why, since it asked for
 * this). Authorised only against the calling session's own intents, reusing
 * the same ownership-check shape as explicitSupersedes (stageIntent above:
 * `explicit.session_id !== sessionId`). Moves the intent straight to the
 * terminal `withdrawn` state with the supplied reason recorded as its
 * `dispositionReason`, so the decision surface shows why the intent
 * disappeared rather than it silently vanishing.
 */
export function withdrawIntent(
  intentId: string,
  reason: string,
  sessionId: string,
): StagedIntent {
  const trimmedReason = reason.trim();
  if (!trimmedReason) {
    throw new IntentWithdrawError(
      'a non-empty reason is required to withdraw an intent',
    );
  }

  const row = getStagedIntentRow(intentId);
  if (!row) {
    throw new IntentWithdrawError(`staged intent "${intentId}" was not found`);
  }
  if (row.session_id !== sessionId) {
    throw new IntentWithdrawError(
      `staged intent "${intentId}" was not staged by this session and cannot be withdrawn by it`,
    );
  }
  if (!WITHDRAWABLE_STATES.includes(row.state)) {
    throw new IntentWithdrawError(
      `staged intent "${intentId}" is in state "${row.state}" and cannot be withdrawn`,
    );
  }

  const withdrawn = transitionStagedIntent(intentId, 'withdrawn', {
    dispositionReason: trimmedReason,
  });
  const withdrawnIntent = rowToApi(withdrawn);
  broadcastIntentChange(withdrawnIntent);

  recordEvent({
    event_type: 'staged_intent_disposition',
    actor_type: 'ai',
    actor_id: sessionId,
    project_id: withdrawnIntent.projectId,
    task_id: row.task_id,
    payload: { intentId, disposition: 'withdrawn', reason: trimmedReason },
  });

  return withdrawnIntent;
}

/**
 * Archive and the structural intents (body/property rewrites) are
 * human-apply-only — applied through the device-auth apply path, never a
 * session credential. See Technical Architecture § Authority-vs-drift.
 */
const HUMAN_APPLY_ONLY_KINDS: ReadonlySet<string> = new Set([
  'task.updateBody',
  'task.patchBodySection',
  'task.setProperties',
  'task.setType',
  'task.archive',
  'task.move',
  'gate.accrete',
  'seed.stage',
  'journal.setState',
  'arch.createUnit',
  'arch.updateUnit',
  'arch.supersedeUnit',
]);

type ApplyActorType = 'human' | 'session';

class HumanApplyOnlyError extends Error {
  constructor(kind: string) {
    super(
      `[stagedIntents] "${kind}" is human-apply-only and cannot be applied by a session credential`,
    );
    this.name = 'HumanApplyOnlyError';
  }
}

async function applyIntent(
  intent: StagedIntent,
  override?: { reason: string },
  actorType: ApplyActorType = 'human',
  triageMilestoneLabel?: string,
): Promise<unknown> {
  if (HUMAN_APPLY_ONLY_KINDS.has(intent.kind) && actorType !== 'human') {
    throw new HumanApplyOnlyError(intent.kind);
  }

  const backend = getTaskBackend(intent.projectId);
  const commands = new BackendTaskWriteCommands(backend, intent.projectId);
  const archCommands = new BackendArchWriteCommands();

  switch (intent.kind) {
    case 'task.create': {
      const payload = intent.payload as CreateTaskPayload;
      const id = await commands.createTask(payload, { source: 'human' });
      return { id };
    }
    case 'task.setStatus': {
      const payload = intent.payload as SetStatusPayload;
      if (
        payload.status === 'Ready' &&
        (!intent.groupId || !hasGroupDependsOn(intent.groupId, payload.taskId))
      ) {
        throw new DependsOnCompletenessError(payload.taskId);
      }
      if (
        payload.status === 'Ready' &&
        payload.groomingGate?.hasManualVerificationSection &&
        (!intent.groupId ||
          !hasGroupManualVerificationStrip(intent.groupId, payload.taskId))
      ) {
        throw new ManualVerificationStripCompletenessError(payload.taskId);
      }
      // approve-by-standard (planning/triage.ts): a task.setStatus intent
      // carrying a recorded triage verdict is eligible for the standard
      // readiness_override reason instead of an operator-authored one — see
      // resolveReadinessOverride in TaskWriteCommands.ts, which only honors
      // this when no explicit `override` is also supplied.
      const triageCleanDesign =
        payload.groomingGate?.triage && triageMilestoneLabel
          ? { milestoneLabel: triageMilestoneLabel }
          : undefined;
      await commands.setStatus(payload.taskId, payload.status, {
        source: 'human',
        readinessOverride: override,
        groomingGate: payload.groomingGate,
        triageCleanDesign,
      });
      return { ok: true };
    }
    case 'task.setDependsOn': {
      const payload = intent.payload as SetDependsOnPayload;
      await commands.setDependsOn(payload.taskId, payload.dependsOn, {
        source: 'human',
      });
      return { ok: true };
    }
    case 'task.updateBody': {
      const payload = intent.payload as UpdateBodyPayload;
      await commands.updateBody(payload.taskId, payload.sections, {
        source: 'human',
      });
      return { ok: true };
    }
    case 'task.patchBodySection': {
      const payload = intent.payload as PatchBodySectionPayload;
      await commands.patchBodySection(
        payload.taskId,
        payload.section,
        payload,
        {
          source: 'human',
        },
      );
      return { ok: true };
    }
    case 'task.setProperties': {
      const payload = intent.payload as SetPropertiesPayload;
      await commands.setProperties(payload.taskId, payload.patch, {
        source: 'human',
      });
      return { ok: true };
    }
    case 'task.setType': {
      const payload = intent.payload as SetTypePayload;
      await commands.setType(payload.taskId, payload.type, {
        source: 'human',
      });
      return { ok: true };
    }
    case 'task.archive': {
      const payload = intent.payload as ArchivePayload;
      await commands.archive(payload.taskId, { source: 'human' });
      return { ok: true };
    }
    case 'task.move': {
      const payload = intent.payload as MoveTaskPayload;
      const result = await commands.moveTask(
        {
          taskId: payload.taskId,
          content: payload.content,
          sourceMilestone: payload.sourceMilestone,
          targetMilestone: payload.targetMilestone,
          originalDisposition: payload.originalDisposition,
        },
        { source: 'human', readinessOverride: override },
      );
      return result;
    }
    case 'gate.accrete': {
      const payload = intent.payload as GateAccretePayload;
      return commands.accreteGateContribution(
        payload.sourceTask,
        payload.items,
        payload.classification,
        payload.reason,
      );
    }
    case 'seed.stage': {
      const payload = intent.payload as SeedStagePayload;
      return commands.stageSeedContribution(
        payload.sourceTask,
        payload.seeds,
        payload.decision,
      );
    }
    case 'journal.setState': {
      const payload = intent.payload as JournalSetStatePayload;
      setEntryState(payload.taskId, payload.state, payload.fields);
      return { ok: true };
    }
    case 'arch.createUnit': {
      const payload = intent.payload as ArchCreateUnitPayload;
      const unit = await archCommands.createUnit(toNewArchUnitFields(payload));
      return { id: unit.id, version: unit.version };
    }
    case 'arch.updateUnit': {
      const payload = intent.payload as ArchUpdateUnitPayload;
      const unit = await archCommands.updateUnit(
        payload.unitId,
        payload.baseVersion,
        toArchUnitUpdateFields(payload),
      );
      return { id: unit.id, version: unit.version };
    }
    case 'arch.supersedeUnit': {
      const payload = intent.payload as ArchSupersedeUnitPayload;
      const result = await archCommands.supersedeUnit(
        payload.unitId,
        payload.baseVersion,
        toNewArchUnitFields(payload.replacement),
      );
      return {
        previousId: result.previous.id,
        nextId: result.next.id,
        nextVersion: result.next.version,
      };
    }
    default:
      throw new Error(`[stagedIntents] unknown intent kind "${intent.kind}"`);
  }
}

/**
 * Approval -> grant -> re-dispatch for a session.requestCapability intent:
 * durably grants exactly the requested capability (never broader, never a
 * resolved/apply scope) to the requesting session and resumes it via the
 * existing feedback-inbox -> re-turn wiring, the approval noted in the
 * resume input. No-ops (grants nothing) if the intent has no originating
 * session or no sessionManager was wired in.
 */
/**
 * Rejects one staged intent row — pushback | decline, with a durable reason —
 * and notifies the originating session/orchestrator. Shared by the per-item
 * `/:id/reject` route (the reject-form / decision.pickOne surface, unchanged
 * per the grooming decision) and the group-level `/group/:groupId/reject`
 * route (the new atomic group-disposition surface), so both dispose through
 * the exact same transition + audit + notify path.
 */
/**
 * Transitions one staged intent row to `rejected` and records the audit
 * trail — the state-mutation half of a reject, with no session notification.
 * Split out so the group-reject route can apply this per row while sending a
 * single coalesced notification for the whole group, instead of one per row.
 */
function transitionRejectedIntent(
  row: StagedIntentRow,
  outcome: StagedIntentRejectOutcome,
  reason: string,
): { intent: StagedIntent; row: StagedIntentRow } {
  // pushback (including an apply-time failure, which is always pushback) is
  // revisable — it lands in needs_revision, the same state the stage-time
  // verification block leaves behind, so the staging session can supersede
  // it. decline is terminal: the operator outright rejected the intent, and
  // a session re-staging a variant is precisely what should not happen, so
  // it stays in rejected, which EXPLICIT_SUPERSEDES_ALLOWED_STATES excludes.
  const targetState: StagedIntentState =
    outcome === 'pushback' ? 'needs_revision' : 'rejected';
  const rejected = transitionStagedIntent(row.id, targetState, {
    dispositionReason: reason,
  });
  const rejectedIntent = rowToApi(rejected);
  broadcastIntentChange(rejectedIntent);

  recordEvent({
    event_type: 'staged_intent_disposition',
    actor_type: 'human',
    actor_id: null,
    project_id: rejectedIntent.projectId,
    task_id: row.task_id,
    payload: { intentId: row.id, disposition: outcome, reason },
  });

  return { intent: rejectedIntent, row: rejected };
}

async function rejectStagedIntentRow(
  row: StagedIntentRow,
  outcome: StagedIntentRejectOutcome,
  reason: string,
  sessionManager: SessionManager | undefined,
  planningOrchestrator: PlanningOrchestrator | undefined,
): Promise<StagedIntent> {
  const { intent: rejectedIntent, row: rejected } = transitionRejectedIntent(
    row,
    outcome,
    reason,
  );

  // Removes the underlying completeness_disposition row outright — not just
  // the intent — so the store never carries a row the operator explicitly
  // declined (task …3012260f, defect 5: the row is durably written before
  // the intent that gates it, so rejecting the intent must not leave that
  // row behind as an orphan). A session left in `needs_revision` (pushback)
  // or terminal `rejected` (decline) can, either way, re-run
  // completeness.disposition to stage a fresh intent with a fresh row — no
  // second critic pass required.
  if (rejectedIntent.kind === 'completeness.disposition') {
    const payload =
      rejectedIntent.payload as CompletenessDispositionIntentPayload;
    deleteCompletenessDisposition(payload.rowId);
  }

  if (rejectedIntent.kind === 'session.requestCapability') {
    await resumeCapabilityRequester(
      sessionManager,
      rejectedIntent,
      outcome,
      reason,
    );
  } else {
    await planningOrchestrator?.handleDisposition({
      intent: rejected,
      disposition: outcome,
      reason,
    });
  }
  return rejectedIntent;
}

async function resumeCapabilityRequester(
  sessionManager: SessionManager | undefined,
  intent: StagedIntent,
  outcome: 'approved' | StagedIntentRejectOutcome,
  reason?: string | null,
): Promise<void> {
  if (!sessionManager || !intent.sessionId) return;
  const payload = intent.payload as CapabilityRequestPayload;

  if (outcome === 'approved') {
    await sessionManager.grantCapability(intent.sessionId, payload.capability);
  }

  const message =
    outcome === 'approved'
      ? `Capability request approved: "${payload.capability}" has been granted for this session.`
      : outcome === 'pushback'
        ? `Capability request "${payload.capability}" was sent back for revision. Feedback: ${reason ?? ''}`
        : `Capability request "${payload.capability}" was declined. Reason: ${reason ?? ''}`;

  try {
    await sessionManager.enqueueFeedback(
      intent.sessionId,
      'operator-disposition',
      message,
    );
  } catch (err) {
    logger.error(
      `[stagedIntents] resume failed for session ${intent.sessionId.slice(0, 8)} after capability-request ${outcome}: ${err}`,
    );
  }
}

/**
 * Notion's object_not_found message ("Could not find page with ID: X. Make
 * sure the relevant pages and databases are shared with your integration.")
 * is accurate for a genuine sharing gap but is the far more common apply-time
 * fault: a staged intent referencing a task id that was mistyped or never
 * existed. Recognizes that specific shape and renames the fault to what a
 * session can actually act on — the unresolvable id — instead of sending it
 * off chasing a sharing setting that was never the problem.
 */
export function translateApplyError(
  err: unknown,
  intent: StagedIntent,
): string {
  const raw = err instanceof Error ? err.message : String(err);
  const notFoundMatch = raw.match(
    /Could not find (?:page|database) with ID:\s*([0-9a-fA-F-]+)/,
  );
  const isNotFound =
    (err instanceof NotionApiError && err.statusCode === 404) ||
    notFoundMatch !== null;
  if (!isNotFound) return raw;

  const taskId =
    extractTaskId(intent.kind, intent.payload) ?? notFoundMatch?.[1] ?? null;
  return taskId
    ? `Could not apply "${intent.kind}": task id "${taskId}" does not resolve to an ` +
        'existing task. Re-stage this intent against the correct task id.'
    : `Could not apply "${intent.kind}": the referenced task id does not resolve to ` +
        'an existing task. Re-stage this intent against the correct task id.';
}

/**
 * Apply-time twin of routeStageTimeBlock's redrive: an unexpected exception
 * from applyIntent (a provider failure the stage-time gates didn't catch) used
 * to reach the operator as a raw exception with the intent left dangling —
 * no route back to the session that staged it. This rejects the intent (so
 * it can never be silently re-applied — a corrected intent must be freshly
 * staged and freshly disposed by the operator, never auto-retried here) and
 * routes the translated failure to the originating session through the same
 * pushback path PlanningOrchestrator.handleDisposition already uses for an
 * operator pushback — reusing its enqueue-and-resume mechanics rather than
 * adding a parallel one. handleDisposition itself no-ops (logs only) when
 * the intent has no originating session or that session no longer exists; in
 * either case `redriven` comes back false so the caller still surfaces the
 * translated error to the operator instead of treating the failure as
 * silently handled.
 */
async function routeApplyTimeFailure(
  row: StagedIntentRow,
  err: unknown,
  planningOrchestrator: PlanningOrchestrator | undefined,
): Promise<{ reason: string; redriven: boolean }> {
  const intent = rowToApi(row);
  const reason = translateApplyError(err, intent);

  // No originating session — nothing to redrive; leave the human-staged
  // surface's existing behavior (intent stays approved/staged, retryable)
  // untouched, mirroring routeStageTimeBlock's own no-session bail-out.
  if (!row.session_id) return { reason, redriven: false };

  const { row: rejected } = transitionRejectedIntent(row, 'pushback', reason);
  broadcastIntentChange(rowToApi(rejected));

  const redriven = Boolean(getSession(row.session_id));
  if (planningOrchestrator) {
    await planningOrchestrator.handleDisposition({
      intent: rejected,
      disposition: 'pushback',
      reason,
    });
  }
  return { reason, redriven };
}

/** Active surface = staged | approved. Terminal states (committed/rejected) and the superseded tombstone are hidden, matching the old delete-on-resolve Map semantics. */
const ACTIVE_STATES: StagedIntentState[] = ['staged', 'approved'];

function getActiveStagedIntent(id: string): StagedIntentRow | undefined {
  const row = getStagedIntentRow(id);
  return row && ACTIVE_STATES.includes(row.state) ? row : undefined;
}

/** A task.setStatus -> Ready intent — the single arming write that must commit LAST within a group. */
function isArmingReadyIntent(row: StagedIntentRow): boolean {
  if (row.kind !== 'task.setStatus') return false;
  const payload = JSON.parse(row.payload) as SetStatusPayload;
  return payload.status === 'Ready';
}

/**
 * Locates the heading-bounded range of `section` in a flattened markdown
 * body: the heading line's index and the exclusive index of the next
 * heading (or the end of the body). Case/whitespace-insensitive match on
 * the heading text, mirroring NotionClient's locateHeadingSection but
 * against plain text rather than live blocks — modeled on (not a reuse of)
 * readinessGate's own heading walk and the frontend's BodySectionDiff
 * splitter, since neither is a shared section-splitter this can call into.
 */
function findMarkdownSectionRange(
  lines: string[],
  section: string,
): { start: number; end: number } | null {
  const target = section.trim().toLowerCase();
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].match(/^#{1,6}\s*(.+)$/);
    if (!heading) continue;
    if (start === -1) {
      if (heading[1].trim().toLowerCase() === target) start = i;
      continue;
    }
    end = i;
    break;
  }
  return start === -1 ? null : { start, end };
}

/**
 * Staging-time preview of a task.patchBodySection apply: splices the
 * patch's result into the stored body at the target heading's boundaries,
 * without ever touching Notion. Best-effort — when the patch can't be
 * simulated (section/find text absent for replace, section absent for
 * remove) the stored body is returned unchanged, since apply time remains
 * the sole authority that fails explicitly.
 */
export function composePatchBodySectionPreview(
  storedBody: string,
  section: string,
  patch: PatchBodySectionOperation,
): string {
  const lines = storedBody.split('\n');
  const range = findMarkdownSectionRange(lines, section);

  if (patch.operation === 'remove') {
    if (!range) return storedBody;
    return [...lines.slice(0, range.start), ...lines.slice(range.end)].join(
      '\n',
    );
  }

  if (patch.operation === 'append') {
    if (!range) {
      return [
        storedBody.trimEnd(),
        '',
        `## ${section}`,
        '',
        patch.content,
      ].join('\n');
    }
    return [
      ...lines.slice(0, range.end),
      patch.content,
      ...lines.slice(range.end),
    ].join('\n');
  }

  // replace
  if (!range) return storedBody;
  const sectionText = lines.slice(range.start + 1, range.end).join('\n');
  if (!sectionText.includes(patch.find)) return storedBody;
  const mutated = sectionText.replace(patch.find, patch.replaceWith);
  return [
    ...lines.slice(0, range.start + 1),
    mutated,
    ...lines.slice(range.end),
  ].join('\n');
}

/**
 * Composes the proposed body a Ready readiness check should see: the stored
 * page body with any live (staged/approved) task.updateBody for this task in
 * the same group applied over it, or else every live task.patchBodySection
 * for this task spliced in at their target headings — used by both the
 * eager approve-time check and (implicitly, via commit ordering)
 * authoritative at commit time.
 */
async function computeProposedBody(
  backend: ReturnType<typeof getTaskBackend>,
  groupId: string | null | undefined,
  taskId: string,
): Promise<string> {
  const stored = (await backend.fetchTaskPage(taskId)) ?? '';
  if (!groupId) return stored;
  const groupIntents = listStagedIntentsByGroup(groupId);
  const updateBodyRow = groupIntents.find(
    (row) =>
      row.kind === 'task.updateBody' &&
      ACTIVE_STATES.includes(row.state) &&
      (JSON.parse(row.payload) as UpdateBodyPayload).taskId === taskId,
  );
  if (updateBodyRow) {
    const payload = JSON.parse(updateBodyRow.payload) as UpdateBodyPayload;
    return composeProposedBody(stored, payload.sections);
  }
  const patchRows = groupIntents.filter(
    (row) =>
      row.kind === 'task.patchBodySection' &&
      ACTIVE_STATES.includes(row.state) &&
      (JSON.parse(row.payload) as PatchBodySectionPayload).taskId === taskId,
  );
  return patchRows.reduce((body, row) => {
    const payload = JSON.parse(row.payload) as PatchBodySectionPayload;
    return composePatchBodySectionPreview(body, payload.section, payload);
  }, stored);
}

/**
 * Stage-time eager validation for a task.setStatus -> Ready intent: runs the
 * same grooming-promotion-gate and readiness-gate checks the commit-time path
 * (applyIntent's task.setStatus case) enforces, but only to annotate the
 * intent — never to block the stage itself. Surfacing the gap here, in the
 * response to the session's own stage call, lets a session that mis-filled a
 * field self-correct in-turn (re-stage a corrected intent) instead of the
 * gap only being discovered later by the operator reviewing the decision
 * surface. checkGroomingPromotionGate + checkReadiness at commit time remain
 * the sole hard authority — this never replaces that check, only precedes
 * it. Shared by both stage-time surfaces (POST /staged-intents and the
 * session loopback POST /task-intents), since both stage through the same
 * `stageIntent` chokepoint.
 */
export async function runStageTimeReadyChecks(
  intent: StagedIntent,
): Promise<StagedIntent> {
  if (intent.kind !== 'task.setStatus') return intent;
  const payload = intent.payload as SetStatusPayload;
  if (payload.status !== 'Ready') return intent;

  const resolvedType =
    getCachedType(payload.taskId) ?? payload.groomingGate?.type;

  const gateResult = checkGroomingPromotionGate(
    payload.groomingGate ?? {},
    payload.taskId,
    resolvedType,
    // A grouped Ready-flip defers gate/seed contribution enforcement to the
    // commit-time precheck (precheckGroupCommit) and turn-end group
    // re-verify: at stage time the group's gate.accrete/seed.stage intents
    // may not have been staged yet (a setStatus-first ordering), so checking
    // applied markers here would spuriously block a flip whose accretions
    // are about to land in the same group. Only an ungrouped flip is checked
    // strictly at stage time.
    intent.groupId
      ? { skipGateContributionCheck: true, skipSeedContributionCheck: true }
      : undefined,
  );
  if (!gateResult.allowed) {
    setStagedIntentAnnotation(
      intent.id,
      JSON.stringify({ blocked: true, reasons: gateResult.reasons }),
    );
    const annotated = getStagedIntentRow(intent.id);
    return annotated ? rowToApi(annotated) : intent;
  }

  const backend = getTaskBackend(intent.projectId);
  const body = await computeProposedBody(
    backend,
    intent.groupId,
    payload.taskId,
  );
  const violations = checkReadiness(body, resolvedType);
  if (violations.length > 0) {
    setStagedIntentAnnotation(
      intent.id,
      JSON.stringify({ blocked: true, violations }),
    );
    const annotated = getStagedIntentRow(intent.id);
    return annotated ? rowToApi(annotated) : intent;
  }

  return intent;
}

/** Bounded auto-revise: the 2nd consecutive verification failure for a group escalates to the operator instead of looping forever. */
const MAX_AUTO_REVISE_ROUNDS = 2;

/** Consecutive verification-failure count per group — in-memory only (mirrors PlanningOrchestrator's own turn bookkeeping), reset on a pass or an escalation. */
const groupRevisionRounds = new Map<string, number>();

export interface GroupVerificationOutcome {
  groupId: string;
  sessionId: string | null;
  passed: boolean;
  /** True once MAX_AUTO_REVISE_ROUNDS was hit — the group surfaced to the operator despite failing, rather than being fed back to the session again. */
  escalated: boolean;
  errors: string[];
}

function describeBlockedAnnotation(
  annotation: StagedIntent['annotation'],
): string | null {
  if (!annotation?.blocked) return null;
  return 'violations' in annotation
    ? annotation.violations.map((v) => v.detail).join('; ')
    : annotation.reasons.join('; ');
}

function formatStageTimeBlockFeedback(
  intent: StagedIntent,
  detail: string,
): string {
  return (
    `Staged intent ${intent.id} (${intent.kind}) failed stage-time validation ` +
    `and was sent back for revision:\n- ${detail}`
  );
}

/**
 * Stage-time twin of verifyGroup's hide-and-route: runs
 * runStageTimeReadyChecks and, on a block, immediately routes the reasons to
 * the intent's originating session via enqueueFeedback (rather than waiting
 * for turn-park) and hides the intent from the operator's staged/approved
 * list by moving it to `needs_revision` — bounded by the same
 * MAX_AUTO_REVISE_ROUNDS budget verifyGroup enforces, keyed by the intent's
 * group (or its own id, when ungrouped, since there is nothing to correlate
 * rounds against). Once the cap is hit the intent is left in `staged` (and
 * no further feedback is sent) so it surfaces to the operator instead of
 * looping forever, mirroring PlanningOrchestrator.verifyAndRoutePendingGroups
 * only feeding back non-escalated outcomes.
 */
export async function routeStageTimeBlock(
  intent: StagedIntent,
  sessionManager: SessionManager | undefined,
): Promise<StagedIntent> {
  const checked = await runStageTimeReadyChecks(intent);
  const detail = describeBlockedAnnotation(checked.annotation);
  // No originating session — nothing to auto-correct and re-verify this via
  // a later turn-park, so hiding it would strand it in needs_revision
  // forever. Leave the human-staged surface's existing behavior untouched.
  if (!detail || !checked.sessionId) return checked;

  const key = checked.groupId ?? checked.id;
  const round = (groupRevisionRounds.get(key) ?? 0) + 1;
  const escalated = round >= MAX_AUTO_REVISE_ROUNDS;
  if (escalated) {
    groupRevisionRounds.delete(key);
    return checked;
  }
  groupRevisionRounds.set(key, round);

  // 'staged' -> 'needs_revision' isn't a direct transition (mirrors
  // verifyGroup's own pending_verification hop at turn-park).
  transitionStagedIntent(checked.id, 'pending_verification');
  const hidden = transitionStagedIntent(checked.id, 'needs_revision');
  const hiddenIntent = rowToApi(hidden);
  broadcastIntentChange(hiddenIntent);

  if (checked.sessionId && sessionManager) {
    try {
      await sessionManager.enqueueFeedback(
        checked.sessionId,
        'verification-error',
        formatStageTimeBlockFeedback(hiddenIntent, detail),
      );
    } catch (err) {
      logger.error(
        `[stagedIntents] resume failed for session ${checked.sessionId.slice(0, 8)} after stage-time block: ${err}`,
      );
    }
  }

  return hiddenIntent;
}

async function verifyGroup(
  groupId: string,
  sessionId: string | null,
): Promise<GroupVerificationOutcome> {
  const members = listStagedIntentsByGroup(groupId).filter(
    (row) => row.state === 'staged',
  );
  for (const row of members) {
    transitionStagedIntent(row.id, 'pending_verification');
  }

  const errors: string[] = [];
  for (const row of members) {
    const checked = await runStageTimeReadyChecks(rowToApi(row));
    const detail = describeBlockedAnnotation(checked.annotation);
    if (detail) {
      errors.push(`${row.kind} (${row.task_id ?? row.id}): ${detail}`);
    }
  }

  if (errors.length === 0) {
    for (const row of members) {
      broadcastIntentChange(rowToApi(transitionStagedIntent(row.id, 'staged')));
    }
    groupRevisionRounds.delete(groupId);
    // Advisory-only: never awaited into the gate. classifyReadyProposal
    // fails open internally, but the `.catch` guards against an unhandled
    // rejection (e.g. a body-fetch error) crashing the process — either way
    // this can never block or delay group surfacing.
    void classifyReadyProposal(groupId).catch(() => {});
    return { groupId, sessionId, passed: true, escalated: false, errors };
  }

  const round = (groupRevisionRounds.get(groupId) ?? 0) + 1;
  const escalated = round >= MAX_AUTO_REVISE_ROUNDS;
  if (escalated) {
    groupRevisionRounds.delete(groupId);
  } else {
    groupRevisionRounds.set(groupId, round);
  }
  for (const row of members) {
    broadcastIntentChange(
      rowToApi(
        transitionStagedIntent(row.id, escalated ? 'staged' : 'needs_revision'),
      ),
    );
  }
  return { groupId, sessionId, passed: false, escalated, errors };
}

/**
 * Group-level verify gate run at turn-end (see
 * PlanningOrchestrator.onSessionParked, the "group submitted" signal): for
 * every proposal group the session staged something into this turn, re-runs
 * runStageTimeReadyChecks across the group's live members and gates the
 * whole group on the result — a clean group is (re)surfaced to the operator,
 * a blocked one is hidden (moved to `needs_revision`) so its errors can be
 * routed back to the session instead, bounded to MAX_AUTO_REVISE_ROUNDS
 * consecutive failures per group before escalating to the operator anyway.
 */
export async function verifyDispatchedGroupsForSession(
  sessionId: string,
): Promise<GroupVerificationOutcome[]> {
  const groupIds = [
    ...new Set(
      listStagedIntentsBySession(sessionId)
        .filter((row) => row.state === 'staged')
        .map((row) => row.group_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  const outcomes: GroupVerificationOutcome[] = [];
  for (const groupId of groupIds) {
    outcomes.push(await verifyGroup(groupId, sessionId));
  }
  return outcomes;
}

interface GroupCommitOptions {
  override: boolean;
  reason: string;
  actorType: ApplyActorType;
  /**
   * Skip the "every live intent already approved" precondition. Used by the
   * approve-by-standard batch commit path — a clean interactive-type row has
   * no per-item human approval step to satisfy, by design.
   */
  autoApprove?: boolean;
  /** Threaded to applyIntent's task.setStatus case — see approve-by-standard. */
  triageMilestoneLabel?: string;
}

interface GroupCommitResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Mirrors `resolveReadinessOverride` in TaskWriteCommands.ts (not imported —
 * that module's override resolution is private to `setStatus`): true when
 * the real apply would bypass the readiness gate, either because the caller
 * passed an explicit operator override, or because this is an
 * approve-by-standard batch commit (`triageMilestoneLabel` set) for a task
 * carrying a recorded triage verdict on an interactive (📐 Design) type. The
 * precheck must recognize both paths — otherwise a legitimate
 * approve-by-standard commit would be wrongly 409'd before ever reaching
 * `applyIntent`.
 */
function readinessOverrideWouldApply(
  payload: SetStatusPayload,
  opts: GroupCommitOptions,
): boolean {
  if (opts.override) return true;
  if (payload.groomingGate?.triage && opts.triageMilestoneLabel) {
    return getCachedType(payload.taskId) === '📐 Design';
  }
  return false;
}

/**
 * Whole-group pre-commit gate check: re-derives, for every arming
 * task.setStatus -> Ready intent in the group, the exact same gates
 * `applyIntent`'s task.setStatus case would hit (the DependsOn-completeness
 * invariant, the grooming promotion gate, and the readiness gate against the
 * composed proposed body) — but purely as a read, before any member intent
 * is applied. This is what makes group commit genuinely all-or-nothing: the
 * confirmed bug (setDependsOn committed, setStatus -> Ready blocked) came
 * from discovering the arming intent's gate failure only after a sibling had
 * already been applied and marked committed. Running the same check first
 * means a doomed commit never touches the task store at all.
 */
async function precheckGroupCommit(
  groupId: string,
  ordered: StagedIntentRow[],
  opts: GroupCommitOptions,
): Promise<GroupCommitResult | null> {
  for (const row of ordered) {
    if (!isArmingReadyIntent(row)) continue;
    const payload = JSON.parse(row.payload) as SetStatusPayload;

    if (!hasGroupDependsOn(groupId, payload.taskId)) {
      const err = new DependsOnCompletenessError(payload.taskId);
      return { status: 409, body: { error: err.message, precheck: true } };
    }

    if (
      payload.groomingGate?.hasManualVerificationSection &&
      !hasGroupManualVerificationStrip(groupId, payload.taskId)
    ) {
      const err = new ManualVerificationStripCompletenessError(payload.taskId);
      return { status: 409, body: { error: err.message, precheck: true } };
    }

    if (payload.groomingGate?.hasManualVerificationSection) {
      const gatePayload = getGroupGateAccretePayload(groupId, payload.taskId);
      if (
        gatePayload &&
        gatePayload.classification !== 'none' &&
        gatePayload.classification !== 'n/a'
      ) {
        const backend = getTaskBackend(row.project_id);
        const storedBody = (await backend.fetchTaskPage(payload.taskId)) ?? '';
        const strippedItems = parseManualVerificationItems(storedBody);
        const accretedItems = gatePayload.items.map((item) => item.text);
        const match = checkAccretionContentMatch(
          'gate_contribution',
          strippedItems,
          accretedItems,
        );
        if (!match.ok) {
          setStagedIntentAnnotation(
            row.id,
            JSON.stringify({ blocked: true, reasons: match.reasons }),
          );
          broadcastIntentById(row.id);
          return {
            status: 409,
            body: {
              error: new GroomingGateError(match.reasons).message,
              reasons: match.reasons,
              precheck: true,
            },
          };
        }
      }
    }

    if (payload.groomingGate?.seedContributionCandidates?.length) {
      const seedPayload = getGroupSeedStagePayload(groupId, payload.taskId);
      if (seedPayload && seedPayload.decision === 'seeds') {
        const strippedItems =
          payload.groomingGate.seedContributionCandidates.map((c) => c.spec);
        const accretedItems = seedPayload.seeds.map((s) => s.spec);
        const match = checkAccretionContentMatch(
          'seed_contribution',
          strippedItems,
          accretedItems,
        );
        if (!match.ok) {
          setStagedIntentAnnotation(
            row.id,
            JSON.stringify({ blocked: true, reasons: match.reasons }),
          );
          broadcastIntentById(row.id);
          return {
            status: 409,
            body: {
              error: new GroomingGateError(match.reasons).message,
              reasons: match.reasons,
              precheck: true,
            },
          };
        }
      }
    }

    const gateResult = checkGroomingPromotionGate(
      payload.groomingGate ?? {},
      payload.taskId,
      getCachedType(payload.taskId) ?? payload.groomingGate?.type,
      {
        skipGateContributionCheck: hasGroupAccretionIntent(
          groupId,
          payload.taskId,
          'gate.accrete',
        ),
        skipSeedContributionCheck: hasGroupAccretionIntent(
          groupId,
          payload.taskId,
          'seed.stage',
        ),
      },
    );
    if (!gateResult.allowed) {
      setStagedIntentAnnotation(
        row.id,
        JSON.stringify({ blocked: true, reasons: gateResult.reasons }),
      );
      broadcastIntentById(row.id);
      return {
        status: 409,
        body: {
          error: new GroomingGateError(gateResult.reasons).message,
          reasons: gateResult.reasons,
          precheck: true,
        },
      };
    }

    if (!readinessOverrideWouldApply(payload, opts)) {
      const backend = getTaskBackend(row.project_id);
      const body = await computeProposedBody(backend, groupId, payload.taskId);
      const violations = checkReadiness(body, getCachedType(payload.taskId));
      if (violations.length > 0) {
        setStagedIntentAnnotation(
          row.id,
          JSON.stringify({ blocked: true, violations }),
        );
        broadcastIntentById(row.id);
        return {
          status: 409,
          body: {
            error: new ReadinessGateError(violations).message,
            violations,
            precheck: true,
          },
        };
      }
    }
  }
  return null;
}

/**
 * Atomic, dependency-ordered commit of one task's intent group: applies
 * every live intent all-or-nothing, non-arming kinds first and
 * task.setStatus -> Ready last. Shared by the single-group commit route and
 * the approve-by-standard batch commit route (one call per group, each
 * group's outcome independent of its siblings) so both surfaces apply,
 * annotate, and audit through the exact same path.
 */
async function commitGroupIntents(
  groupId: string,
  opts: GroupCommitOptions,
  planningOrchestrator?: PlanningOrchestrator,
): Promise<GroupCommitResult> {
  const live = listStagedIntentsByGroup(groupId).filter((r) =>
    ACTIVE_STATES.includes(r.state),
  );
  if (live.length === 0) {
    return {
      status: 404,
      body: { error: `no live staged intents found for group "${groupId}"` },
    };
  }
  // Defense-in-depth alongside the stage-time refusal in stageIntent: a
  // session.requestCapability applies via SessionManager.grantCapability + a
  // session respawn, never via applyIntent, so it must never reach the
  // apply loop below — where it would otherwise fall through applyIntent's
  // `default:` unknown-kind throw and wedge the whole group (every other
  // live member left uncommitted behind it in `ordered`).
  const strayCapabilityRequest = live.find(
    (r) => r.kind === 'session.requestCapability',
  );
  if (strayCapabilityRequest) {
    return {
      status: 409,
      body: {
        error:
          `[stagedIntents] group "${groupId}" contains a session.requestCapability ` +
          `intent ("${strayCapabilityRequest.id}") — it cannot be committed as part of a group; ` +
          'approve or reject it individually via POST /staged-intents/:id/approve or /:id/reject',
        precheck: true,
      },
    };
  }
  if (!opts.autoApprove) {
    const notApproved = live.filter((r) => r.state !== 'approved');
    if (notApproved.length > 0) {
      return {
        status: 409,
        body: {
          error: `group "${groupId}" has ${notApproved.length} intent(s) not yet approved`,
          pendingIds: notApproved.map((r) => r.id),
        },
      };
    }
  }

  const ordered = [
    ...live.filter((r) => !isArmingReadyIntent(r)),
    ...live.filter((r) => isArmingReadyIntent(r)),
  ];

  const precheckFailure = await precheckGroupCommit(groupId, ordered, opts);
  if (precheckFailure) {
    return {
      status: precheckFailure.status,
      body: {
        ...precheckFailure.body,
        committed: [],
        remaining: ordered.map((r) => r.id),
      },
    };
  }

  const committed: string[] = [];
  // Populated as each task.create in this group applies — keyed by that
  // intent's own staged-intent id (the symbolic-reference token, see
  // SYMBOLIC_CREATE_REF_PREFIX), consumed below to resolve a later
  // task.setDependsOn's symbolic taskId *subject* (splitSession.ts's
  // sibling-depends-on-sibling case, where the dependency's subject is
  // itself a not-yet-created task.create in this same group — the harder
  // twin of the dependsOn-entry case already handled here) and its symbolic
  // dependsOn entries, to real created task ids before that intent is
  // applied. `ordered` places every task.create ahead of any intent that
  // references it (splitSession.ts always stages a sibling's task.create
  // before any task.setDependsOn naming that sibling — see
  // stageSplitIntents), so the id is always present here.
  const createdTaskIds = new Map<string, string>();
  for (const row of ordered) {
    const intent = rowToApi(row);
    try {
      if (intent.kind === 'task.setDependsOn') {
        const payload = intent.payload as SetDependsOnPayload;
        const resolveSymbolic = (value: string): string => {
          const symbolicIntentId = parseSymbolicCreateRef(value);
          if (!symbolicIntentId) return value;
          const resolved = createdTaskIds.get(symbolicIntentId);
          if (!resolved) {
            throw new TaskReferenceValidationError(
              `"${value}" references a task.create intent that has not applied ` +
                'yet in this commit',
            );
          }
          return resolved;
        };
        intent.payload = {
          ...payload,
          taskId: resolveSymbolic(payload.taskId),
          dependsOn: payload.dependsOn.map(resolveSymbolic),
        };
      }
      const result = await applyIntent(
        intent,
        opts.override ? { reason: opts.reason } : undefined,
        opts.actorType,
        opts.triageMilestoneLabel,
      );
      if (intent.kind === 'task.create') {
        createdTaskIds.set(intent.id, (result as { id: string }).id);
      }
      const committedRow = transitionStagedIntent(intent.id, 'committed', {
        annotation: null,
      });
      broadcastIntentChange(rowToApi(committedRow));
      await planningOrchestrator?.handleDisposition({
        intent: committedRow,
        disposition: 'approve',
      });
      committed.push(intent.id);
    } catch (err) {
      const remaining = ordered
        .map((r) => r.id)
        .filter((id) => id !== intent.id && !committed.includes(id));

      if (err instanceof ReadinessGateError) {
        setStagedIntentAnnotation(
          intent.id,
          JSON.stringify({ blocked: true, violations: err.violations }),
        );
        broadcastIntentById(intent.id);
        return {
          status: 409,
          body: {
            error: err.message,
            violations: err.violations,
            committed,
            failedId: intent.id,
            remaining,
          },
        };
      }
      if (err instanceof GroomingGateError) {
        setStagedIntentAnnotation(
          intent.id,
          JSON.stringify({ blocked: true, reasons: err.reasons }),
        );
        broadcastIntentById(intent.id);
        return {
          status: 409,
          body: {
            error: err.message,
            reasons: err.reasons,
            committed,
            failedId: intent.id,
            remaining,
          },
        };
      }
      if (err instanceof HumanApplyOnlyError) {
        return {
          status: 403,
          body: {
            error: err.message,
            committed,
            failedId: intent.id,
            remaining,
          },
        };
      }
      if (
        err instanceof DependsOnCompletenessError ||
        err instanceof ManualVerificationStripCompletenessError
      ) {
        return {
          status: 409,
          body: {
            error: err.message,
            committed,
            failedId: intent.id,
            remaining,
          },
        };
      }
      if (
        err instanceof StaleArchUnitVersionError ||
        err instanceof ArchUnitAlreadySupersededError
      ) {
        setStagedIntentAnnotation(
          intent.id,
          JSON.stringify({ blocked: true, reasons: [err.message] }),
        );
        return {
          status: 409,
          body: {
            error: err.message,
            committed,
            failedId: intent.id,
            remaining,
          },
        };
      }
      const { reason, redriven } = await routeApplyTimeFailure(
        row,
        err,
        planningOrchestrator,
      );
      return {
        status: 500,
        body: {
          error: reason,
          committed,
          failedId: intent.id,
          remaining,
          redrivenToSession: redriven,
        },
      };
    }
  }

  return { status: 200, body: { ok: true, committed } };
}

export function createStagedIntentsRouter(
  planningOrchestrator?: PlanningOrchestrator,
  sessionManager?: SessionManager,
): Router {
  const router = Router();

  // ── GET /api/staged-intents ─────────────────────────────────────────────
  // ?sessionId=<id> is the SessionPanel decision-panel lens: correlates
  // proposals back to the session that produced them, active states only.
  router.get('/staged-intents', (req: Request, res: Response) => {
    const projectId =
      typeof req.query.projectId === 'string' ? req.query.projectId : null;
    const sessionId =
      typeof req.query.sessionId === 'string' ? req.query.sessionId : null;
    const rows = sessionId
      ? listStagedIntentsBySession(sessionId).filter((r) =>
          ACTIVE_STATES.includes(r.state),
        )
      : projectId
        ? listStagedIntentsByProject(projectId)
        : listAllActiveStagedIntents();
    res.json({ intents: rows.map(rowToApi) });
  });

  // ── POST /api/staged-intents ─────────────────────────────────────────────
  router.post('/staged-intents', async (req: Request, res: Response) => {
    const body = req.body as {
      kind?: unknown;
      payload?: unknown;
      projectId?: unknown;
      groupId?: unknown;
      decisionProposal?: unknown;
      groomProposal?: unknown;
      supersedes?: unknown;
    };
    const kind = typeof body.kind === 'string' ? body.kind : null;
    const projectId =
      typeof body.projectId === 'string' ? body.projectId : null;
    const groupId = typeof body.groupId === 'string' ? body.groupId : null;
    const decisionProposal =
      typeof body.decisionProposal === 'string' ? body.decisionProposal : null;
    const groomProposal = parseGroomProposal(body.groomProposal);
    const supersedes =
      typeof body.supersedes === 'string' ? body.supersedes : null;

    if (!kind) {
      res.status(400).json({ error: 'kind is required' });
      return;
    }
    if (!KNOWN_INTENT_KINDS.has(kind)) {
      res.status(400).json({ error: `unknown intent kind "${kind}"` });
      return;
    }
    if (!projectId) {
      res.status(400).json({ error: 'projectId is required' });
      return;
    }

    let normalizedPayload: unknown;
    try {
      normalizedPayload = await validateAndNormalizeTaskReferences(
        kind,
        body.payload,
        projectId,
        groupId,
      );
    } catch (err) {
      if (
        err instanceof TaskReferenceValidationError ||
        err instanceof InvestigationAccretionRejectedError ||
        err instanceof OpsJournalTransitionRejectedError
      ) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const intent = stageIntent(
      kind,
      normalizedPayload,
      projectId,
      groupId,
      null,
      decisionProposal,
      groomProposal,
      supersedes,
    );

    const checked = await runStageTimeReadyChecks(intent);
    res.status(201).json(checked);
  });

  // ── POST /api/staged-intents/:id/apply ───────────────────────────────────
  // Human / device-authenticated surface only — the only place `override` is
  // accepted. Auto-dispatched, stage-only producers never call this route.
  // Approve->Commit unification: a grouped intent (group_id set) is only
  // ever written atomically via the group's commit route — apply is
  // standalone-intents-only, server-enforced below.
  router.post(
    '/staged-intents/:id/apply',
    async (req: Request, res: Response) => {
      const row = getActiveStagedIntent(String(req.params.id));
      if (!row) {
        res.status(404).json({ error: 'staged intent not found' });
        return;
      }
      if (row.group_id) {
        res.status(409).json({
          error: `staged intent "${row.id}" belongs to group "${row.group_id}" — grouped intents must be committed atomically via POST /staged-intents/group/:groupId/commit`,
        });
        return;
      }
      if (row.kind === 'decision.pickOne') {
        res.status(409).json({
          error: `staged intent "${row.id}" is a decision.pickOne question — it writes no task store; resolve it via POST /staged-intents/:id/answer`,
        });
        return;
      }
      if (row.kind === 'completeness.disposition') {
        res.status(409).json({
          error: `staged intent "${row.id}" is a completeness.disposition run — approval is terminal for it (no separate apply step); resolve it via POST /staged-intents/:id/approve or /reject`,
        });
        return;
      }
      const intent = rowToApi(row);

      const body = req.body as {
        override?: unknown;
        reason?: unknown;
        actorType?: unknown;
      };
      const override = body?.override === true;
      const reason = typeof body?.reason === 'string' ? body.reason : '';
      if (override && !reason.trim()) {
        res
          .status(400)
          .json({ error: 'reason is required when override is true' });
        return;
      }
      const actorType: ApplyActorType =
        body?.actorType === 'session' ? 'session' : 'human';

      try {
        const result = await applyIntent(
          intent,
          override ? { reason } : undefined,
          actorType,
        );
        const committed = transitionStagedIntent(intent.id, 'committed', {
          annotation: null,
        });
        broadcastIntentChange(rowToApi(committed));
        await planningOrchestrator?.handleDisposition({
          intent: committed,
          disposition: 'approve',
        });
        res.json({ ok: true, result });
      } catch (err) {
        if (err instanceof ReadinessGateError) {
          setStagedIntentAnnotation(
            intent.id,
            JSON.stringify({ blocked: true, violations: err.violations }),
          );
          broadcastIntentById(intent.id);
          res.status(409).json({
            error: err.message,
            violations: err.violations,
          });
          return;
        }
        if (err instanceof GroomingGateError) {
          setStagedIntentAnnotation(
            intent.id,
            JSON.stringify({ blocked: true, reasons: err.reasons }),
          );
          broadcastIntentById(intent.id);
          res.status(409).json({
            error: err.message,
            reasons: err.reasons,
          });
          return;
        }
        if (err instanceof HumanApplyOnlyError) {
          res.status(403).json({ error: err.message });
          return;
        }
        if (
          err instanceof DependsOnCompletenessError ||
          err instanceof ManualVerificationStripCompletenessError
        ) {
          res.status(409).json({ error: err.message });
          return;
        }
        if (
          err instanceof StaleArchUnitVersionError ||
          err instanceof ArchUnitAlreadySupersededError
        ) {
          setStagedIntentAnnotation(
            intent.id,
            JSON.stringify({ blocked: true, reasons: [err.message] }),
          );
          res.status(409).json({ error: err.message });
          return;
        }
        const { reason, redriven } = await routeApplyTimeFailure(
          row,
          err,
          planningOrchestrator,
        );
        res.status(500).json({ error: reason, redrivenToSession: redriven });
      }
    },
  );

  // ── POST /api/staged-intents/:id/approve ─────────────────────────────────
  // Marks the intent approved — nothing is written to the task backend. For
  // a task.setStatus -> Ready intent, eagerly runs the readiness gate against
  // the composed proposed body (a live sibling task.updateBody in the same
  // group, if any) so blocks/advisories surface at review time rather than
  // as a surprise 409 on commit. This eager check never blocks the approve
  // itself — the commit-time check remains the sole authority.
  router.post(
    '/staged-intents/:id/approve',
    async (req: Request, res: Response) => {
      const row = getActiveStagedIntent(String(req.params.id));
      if (!row) {
        res.status(404).json({ error: 'staged intent not found' });
        return;
      }
      const intent = rowToApi(row);

      // A capability-request has no separate apply step — approval is the
      // terminal action: it grants exactly the requested capability and
      // re-dispatches the requesting session in one step.
      if (intent.kind === 'session.requestCapability') {
        const committed = transitionStagedIntent(intent.id, 'committed', {
          annotation: null,
        });
        const committedIntent = rowToApi(committed);
        broadcastIntentChange(committedIntent);
        await resumeCapabilityRequester(
          sessionManager,
          committedIntent,
          'approved',
        );
        res.json(committedIntent);
        return;
      }

      // A completeness.disposition run has no separate apply step either —
      // approval is terminal: it advances the underlying
      // completeness_disposition row(s) off `proposed` to `approved` and
      // unblocks the design session's gated arch.*/closing-synthesis writes
      // (see assertCompletenessApproval above).
      if (intent.kind === 'completeness.disposition') {
        const payload = intent.payload as CompletenessDispositionIntentPayload;
        updateCompletenessDispositionApproval(payload.rowId, 'approved');
        const committed = transitionStagedIntent(intent.id, 'committed', {
          annotation: null,
        });
        const committedIntent = rowToApi(committed);
        broadcastIntentChange(committedIntent);
        await planningOrchestrator?.handleDisposition({
          intent: committed,
          disposition: 'approve',
        });
        res.json(committedIntent);
        return;
      }

      // A decision.pickOne question has no approve step of its own — it is
      // resolved only by POST /staged-intents/:id/answer.
      if (intent.kind === 'decision.pickOne') {
        res.status(409).json({
          error: `staged intent "${intent.id}" is a decision.pickOne question — resolve it via POST /staged-intents/:id/answer`,
        });
        return;
      }

      let annotation: StagedIntent['annotation'] = null;
      if (intent.kind === 'task.setStatus') {
        const payload = intent.payload as SetStatusPayload;
        if (payload.status === 'Ready') {
          const backend = getTaskBackend(intent.projectId);
          const body = await computeProposedBody(
            backend,
            intent.groupId,
            payload.taskId,
          );
          const violations = checkReadiness(
            body,
            getCachedType(payload.taskId),
          );
          if (violations.length > 0) {
            annotation = { blocked: true, violations };
          }
        }
      }

      const updated = transitionStagedIntent(intent.id, 'approved', {
        annotation: annotation ? JSON.stringify(annotation) : null,
      });
      const updatedIntent = rowToApi(updated);
      broadcastIntentChange(updatedIntent);
      res.json(updatedIntent);
    },
  );

  // ── GET /api/staged-intents/group/:groupId ────────────────────────────────
  // Diagnostic surface: every intent ever staged for this group, regardless
  // of state — including needs_revision, which /staged-intents (ACTIVE_STATES
  // only) never surfaces. `wedged` flags the exact failure mode this route
  // exists for: a non-empty group whose every member sits in needs_revision,
  // reachable by no commit (commitGroupIntents' ACTIVE_STATES filter finds
  // nothing live) and no per-item apply/reject (getActiveStagedIntent finds
  // nothing live either).
  router.get(
    '/staged-intents/group/:groupId',
    (req: Request, res: Response) => {
      const groupId = String(req.params.groupId);
      const members = listStagedIntentsByGroup(groupId);
      const wedged =
        members.length > 0 &&
        members.every((r) => r.state === 'needs_revision');
      res.json({ groupId, intents: members.map(rowToApi), wedged });
    },
  );

  // ── POST /api/staged-intents/group/:groupId/recover ───────────────────────
  // Wedged-group recovery: re-surfaces every needs_revision member of the
  // group onto the normal staged/approved surface (ACTIVE_STATES), so the
  // usual commit or per-item disposition (approve/reject) routes can act on
  // it again — the state machine (STAGED_INTENT_TRANSITIONS in
  // db/queries.ts) permits needs_revision -> staged only via this
  // operator-initiated route, never implicitly. Also strips group_id: a
  // session.requestCapability must never carry one (see
  // validateCapabilityRequestDoesNotCarryGroup), so a recovered instance of
  // the exact bug this guards against is freed to its individual
  // approve/reject surface instead of being re-wedged by the next group
  // commit. A non-capability-request member keeps its group_id — recovery
  // only clears what stage-time validation would have refused.
  router.post(
    '/staged-intents/group/:groupId/recover',
    (req: Request, res: Response) => {
      const groupId = String(req.params.groupId);
      const blocked = listStagedIntentsByGroup(groupId).filter(
        (r) => r.state === 'needs_revision',
      );
      if (blocked.length === 0) {
        res.status(404).json({
          error: `no needs_revision intents found for group "${groupId}"`,
        });
        return;
      }

      const recovered = blocked.map((row) => {
        const staged = transitionStagedIntent(row.id, 'staged', {
          annotation: null,
        });
        const cleared =
          staged.kind === 'session.requestCapability' && staged.group_id
            ? clearStagedIntentGroup(staged.id)
            : staged;
        const recoveredIntent = rowToApi(cleared);
        broadcastIntentChange(recoveredIntent);
        recordEvent({
          event_type: 'staged_intent_disposition',
          actor_type: 'human',
          actor_id: null,
          project_id: recoveredIntent.projectId,
          task_id: row.task_id,
          payload: { intentId: row.id, disposition: 'recover' },
        });
        return recoveredIntent;
      });

      res.json({ ok: true, recovered });
    },
  );

  // ── POST /api/staged-intents/group/:groupId/commit ───────────────────────
  // Atomic, dependency-ordered group commit: requires every live (staged |
  // approved) intent in the group to be approved, then applies them
  // all-or-nothing — updateBody / setDependsOn / setProperties (and other
  // non-arming kinds) first, task.setStatus -> Ready LAST. A failure halts
  // immediately, before the Ready flip, leaving the failed and not-yet-run
  // intents in `approved` state so the group can be retried; intents applied
  // before the failure stay `committed` (the task store is not
  // transactional, so their writes cannot be rolled back — halting before
  // Ready is what keeps a partial commit safe, since Ready is the only write
  // that arms auto-dispatch).
  router.post(
    '/staged-intents/group/:groupId/commit',
    async (req: Request, res: Response) => {
      const groupId = String(req.params.groupId);
      const body = req.body as {
        override?: unknown;
        reason?: unknown;
        actorType?: unknown;
      };
      const override = body?.override === true;
      const reason = typeof body?.reason === 'string' ? body.reason : '';
      if (override && !reason.trim()) {
        res
          .status(400)
          .json({ error: 'reason is required when override is true' });
        return;
      }
      const actorType: ApplyActorType =
        body?.actorType === 'session' ? 'session' : 'human';

      const result = await commitGroupIntents(
        groupId,
        { override, reason, actorType },
        planningOrchestrator,
      );
      res.status(result.status).json(result.body);
    },
  );

  // ── POST /api/staged-intents/group/:groupId/approve ──────────────────────
  // The single atomic-approval-unit surface: approves and commits every live
  // intent in the group in one operator action, without requiring each
  // member to be individually approved first (autoApprove skips that
  // precondition — the group itself, not its members, is what the operator
  // disposes). Goes through the exact same `commitGroupIntents` path as
  // `/group/:groupId/commit` — including the whole-group precheck — so
  // "approve the groom" can never partially commit.
  router.post(
    '/staged-intents/group/:groupId/approve',
    async (req: Request, res: Response) => {
      const groupId = String(req.params.groupId);
      const body = req.body as {
        override?: unknown;
        reason?: unknown;
        actorType?: unknown;
      };
      const override = body?.override === true;
      const reason = typeof body?.reason === 'string' ? body.reason : '';
      if (override && !reason.trim()) {
        res
          .status(400)
          .json({ error: 'reason is required when override is true' });
        return;
      }
      const actorType: ApplyActorType =
        body?.actorType === 'session' ? 'session' : 'human';

      const result = await commitGroupIntents(
        groupId,
        { override, reason, actorType, autoApprove: true },
        planningOrchestrator,
      );
      res.status(result.status).json(result.body);
    },
  );

  // ── POST /api/staged-intents/group/:groupId/reject ───────────────────────
  // The group-level twin of `/group/:groupId/approve`: pushback | decline the
  // whole grooming decision as one unit — every live intent in the group is
  // rejected with the same outcome + reason, none of them committed. This is
  // the group-disposition layer above the unchanged per-item reject-form
  // surface (`/:id/reject`), which stays available for standalone intents
  // (e.g. a decision.pickOne) that were never grouped in the first place.
  router.post(
    '/staged-intents/group/:groupId/reject',
    async (req: Request, res: Response) => {
      const groupId = String(req.params.groupId);
      const body = req.body as { outcome?: unknown; reason?: unknown };
      const outcome: StagedIntentRejectOutcome | null =
        body?.outcome === 'pushback' || body?.outcome === 'decline'
          ? body.outcome
          : null;
      const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
      if (!outcome) {
        res
          .status(400)
          .json({ error: 'outcome must be "pushback" or "decline"' });
        return;
      }
      if (!reason) {
        res.status(400).json({ error: 'reason is required' });
        return;
      }

      const live = listStagedIntentsByGroup(groupId).filter((r) =>
        ACTIVE_STATES.includes(r.state),
      );
      if (live.length === 0) {
        res.status(404).json({
          error: `no live staged intents found for group "${groupId}"`,
        });
        return;
      }

      const rejected: string[] = [];
      const forGroupDisposition: StagedIntentRow[] = [];
      for (const row of live) {
        const { intent: rejectedIntent, row: rejectedRow } =
          transitionRejectedIntent(row, outcome, reason);
        rejected.push(rejectedIntent.id);

        if (rejectedIntent.kind === 'session.requestCapability') {
          await resumeCapabilityRequester(
            sessionManager,
            rejectedIntent,
            outcome,
            reason,
          );
        } else {
          forGroupDisposition.push(rejectedRow);
        }
      }
      if (forGroupDisposition.length > 0) {
        await planningOrchestrator?.handleGroupDisposition({
          intents: forGroupDisposition,
          disposition: outcome,
          reason,
          groupId,
        });
      }
      res.json({ ok: true, rejected });
    },
  );

  // ── POST /api/staged-intents/batch/commit ─────────────────────────────────
  // The approve-by-standard decision surface (planning/triage.ts): commits a
  // default-approved clean set spanning MULTIPLE task groups from one
  // triaged interactive-type batch, on a single operator disposition. Each
  // named group is a whole task's group (setDependsOn/updateBody/setStatus),
  // so every Ready-flip still applies individually via commitGroupIntents'
  // ordinary per-group path — its own per-task readiness_override + audit
  // event, its own re-derived server-side gate (arch 383: the per-task
  // records and audited applies are never skipped or stood in for by a
  // batched apply). `autoApprove` skips the "every live intent already
  // approved" precondition — approve-by-standard is precisely the removal
  // of that per-item human approval step for a clean interactive-type row.
  // A group whose apply fails its gate is recorded as an exception and the
  // loop continues — one failing task never aborts the rest of the batch.
  // A vetoed row is simply never included in `groupIds` by the caller.
  router.post(
    '/staged-intents/batch/commit',
    async (req: Request, res: Response) => {
      const body = req.body as {
        groupIds?: unknown;
        milestoneLabel?: unknown;
        actorType?: unknown;
      };
      const groupIds = Array.isArray(body?.groupIds)
        ? body.groupIds.filter((id): id is string => typeof id === 'string')
        : [];
      if (groupIds.length === 0) {
        res.status(400).json({ error: 'groupIds must be a non-empty array' });
        return;
      }
      const milestoneLabel =
        typeof body?.milestoneLabel === 'string'
          ? body.milestoneLabel
          : undefined;
      const actorType: ApplyActorType =
        body?.actorType === 'session' ? 'session' : 'human';

      const committed: string[] = [];
      const exceptions: Array<{
        groupId: string;
        status: number;
        error: string;
        committedIntentIds: string[];
      }> = [];

      for (const groupId of groupIds) {
        const result = await commitGroupIntents(
          groupId,
          {
            override: false,
            reason: '',
            actorType,
            autoApprove: true,
            triageMilestoneLabel: milestoneLabel,
          },
          planningOrchestrator,
        );
        if (result.status === 200) {
          committed.push(groupId);
        } else {
          exceptions.push({
            groupId,
            status: result.status,
            error:
              typeof result.body.error === 'string'
                ? result.body.error
                : 'commit failed',
            committedIntentIds: Array.isArray(result.body.committed)
              ? (result.body.committed as string[])
              : [],
          });
        }
      }

      res.json({ ok: true, committed, exceptions });
    },
  );

  // ── POST /api/staged-intents/:id/reject ──────────────────────────────────
  // The reject disposition requires an explicit operator-chosen outcome and
  // a non-blank reason — no more empty-textbox inference of plain-reject vs
  // pushback. `pushback` re-turns the originating session to revise and
  // re-emit; `decline` is terminal — the session, when present, is informed
  // with the reason but not asked to re-emit. The reason is persisted on the
  // intent (disposition_reason) and recorded in audit_log regardless of
  // whether the originating session still exists — a disposition on an
  // intent whose session has already ended is still durably recorded.
  router.post(
    '/staged-intents/:id/reject',
    async (req: Request, res: Response) => {
      const row = getActiveStagedIntent(String(req.params.id));
      if (!row) {
        res.status(404).json({ error: 'staged intent not found' });
        return;
      }
      const body = req.body as { outcome?: unknown; reason?: unknown };
      const outcome: StagedIntentRejectOutcome | null =
        body?.outcome === 'pushback' || body?.outcome === 'decline'
          ? body.outcome
          : null;
      const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
      if (!outcome) {
        res
          .status(400)
          .json({ error: 'outcome must be "pushback" or "decline"' });
        return;
      }
      if (!reason) {
        res.status(400).json({ error: 'reason is required' });
        return;
      }

      await rejectStagedIntentRow(
        row,
        outcome,
        reason,
        sessionManager,
        planningOrchestrator,
      );
      res.json({ ok: true });
    },
  );

  // ── POST /api/staged-intents/:id/answer ──────────────────────────────────
  // Resolves a decision.pickOne question-intent: records the operator's
  // chosen option + free-form text, transitions the intent straight to the
  // terminal `committed` state (a second answer 404s — getActiveStagedIntent
  // only surfaces staged/approved rows), and re-turns the originating
  // session with the choice via PlanningOrchestrator. Never calls
  // TaskWriteCommands / writes the task store — the re-turned session is
  // responsible for staging the concrete writes for the chosen path as
  // ordinary intents.
  router.post(
    '/staged-intents/:id/answer',
    async (req: Request, res: Response) => {
      const row = getActiveStagedIntent(String(req.params.id));
      if (!row) {
        res.status(404).json({ error: 'staged intent not found' });
        return;
      }
      if (row.kind !== 'decision.pickOne') {
        res.status(409).json({
          error: `staged intent "${row.id}" is not a decision.pickOne question`,
        });
        return;
      }

      const payload = JSON.parse(row.payload) as DecisionPickOnePayload;
      const body = req.body as { chosenLabel?: unknown; freeForm?: unknown };
      const chosenLabel =
        typeof body?.chosenLabel === 'string' ? body.chosenLabel : null;
      const freeForm =
        typeof body?.freeForm === 'string' && body.freeForm.trim()
          ? body.freeForm
          : null;

      if (
        chosenLabel &&
        !payload.options.some((o) => o.label === chosenLabel)
      ) {
        res
          .status(400)
          .json({ error: 'chosenLabel must match one of the staged options' });
        return;
      }
      if (!chosenLabel && !payload.allowFreeForm) {
        res
          .status(400)
          .json({ error: 'chosenLabel must match one of the staged options' });
        return;
      }
      if (!chosenLabel && !freeForm) {
        res
          .status(400)
          .json({ error: 'either chosenLabel or freeForm is required' });
        return;
      }

      const answer: StagedIntentAnswer = { chosenLabel, freeForm };
      const resolved = transitionStagedIntent(row.id, 'committed', {
        annotation: null,
        answer: JSON.stringify(answer),
      });
      const resolvedIntent = rowToApi(resolved);
      broadcastIntentChange(resolvedIntent);

      recordEvent({
        event_type: 'staged_intent_disposition',
        actor_type: 'human',
        actor_id: null,
        project_id: resolvedIntent.projectId,
        task_id: row.task_id,
        payload: {
          intentId: row.id,
          disposition: 'answer',
          chosenLabel,
          freeForm,
        },
      });

      await planningOrchestrator?.handleDisposition({
        intent: resolved,
        disposition: 'answer',
        answer,
      });

      res.json({ ok: true, intent: resolvedIntent });
    },
  );

  return router;
}
