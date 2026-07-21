import { Router } from 'express';
import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { getTaskBackend } from '../tasks/TaskBackend';
import {
  BackendTaskWriteCommands,
  type TaskStatus,
  type TaskType,
  type MoveTaskContent,
  type MoveTaskMilestoneRef,
  type MoveTaskTargetMilestone,
} from '../tasks/TaskWriteCommands';
import type { NewTaskFields, TaskPropertiesPatch } from '../tasks/TaskBackend';
import type { TaskBodySections } from '../tasks/bodyRender';
import {
  checkReadiness,
  composeProposedBody,
  ReadinessGateError,
  type ReadinessViolation,
} from '../tasks/readinessGate';
import { GroomingGateError, type GroomingGateEntry } from '../groom/groomGate';
import type {
  StagedIntentRow,
  StagedIntentState,
  StagedIntentRejectOutcome,
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
  transitionStagedIntent,
  supersedeStagedIntent,
  setStagedIntentAnnotation,
} from '../db/queries';
import { recordEvent } from '../audit/AuditLog';
import type {
  GateContributionSourceTask,
  GateContributionItemInput,
  GateContributionDecision,
  SeedContributionSourceTask,
  SeedContributionItemInput,
  SeedContributionDecision,
} from '../tasks/TaskWriteCommands';
import { setEntryState, type OpsState } from '../ops/opsJournal';
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
    advisory: row.advisory
      ? (JSON.parse(row.advisory) as StagedIntent['advisory'])
      : null,
    dispositionReason: row.disposition_reason,
  };
}

/**
 * Kinds carry their target task at `payload.taskId`, except task.create — a
 * new task has no pre-existing id, so it never participates in dedup — and
 * gate.accrete/seed.stage, whose source task lives at `payload.sourceTask.id`.
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
  const taskId = (payload as { taskId?: unknown } | null)?.taskId;
  return typeof taskId === 'string' ? taskId : null;
}

type CreateTaskPayload = NewTaskFields;
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
 * How a dispatched session expresses a write-capability request: the exact
 * tool/command it wants (a Bash command prefix or a named MCP write verb —
 * never a category), the plan it intends to use it for, and the evidence
 * behind the request. The target session is always this intent's own
 * session_id (set by the staging auth context), never a payload field — a
 * session cannot request a grant onto another session.
 */
interface CapabilityRequestPayload {
  capability: string;
  plan: string;
  evidence: string;
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

/** Intent kinds accepted by POST /staged-intents. */
export const KNOWN_INTENT_KINDS: ReadonlySet<string> = new Set([
  'task.create',
  'task.setStatus',
  'task.setDependsOn',
  'task.updateBody',
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
  'session.requestCapability',
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
 * the existing row (and its approval, if any) is returned untouched. A
 * re-emission that differs supersedes the standing intent (tombstoning it)
 * and re-enters `staged`, requiring fresh approval.
 */
export function stageIntent(
  kind: string,
  payload: unknown,
  projectId: string,
  groupId?: string | null,
  sessionId?: string | null,
  decisionProposal?: string | null,
): StagedIntent {
  const taskId = extractTaskId(kind, payload);
  const payloadHash = hashIntentPayload(payload);
  const now = Date.now();

  if (taskId) {
    const existing = findActiveStagedIntentForTask(projectId, kind, taskId);
    if (existing) {
      if (existing.payload_hash === payloadHash) {
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
        advisory: null,
        disposition_reason: null,
        created_at: now,
        updated_at: now,
      };
      const superseded = rowToApi(supersedeStagedIntent(existing.id, newRow));
      broadcastIntentChange(superseded);
      return superseded;
    }
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
    advisory: null,
    disposition_reason: null,
    created_at: now,
    updated_at: now,
  };
  insertStagedIntent(row);
  const staged = rowToApi(row);
  broadcastIntentChange(staged);
  return staged;
}

/**
 * Archive and the structural intents (body/property rewrites) are
 * human-apply-only — applied through the device-auth apply path, never a
 * session credential. See Technical Architecture § Authority-vs-drift.
 */
const HUMAN_APPLY_ONLY_KINDS: ReadonlySet<string> = new Set([
  'task.updateBody',
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
async function resumeCapabilityRequester(
  sessionManager: SessionManager | undefined,
  intent: StagedIntent,
  outcome: 'approved' | StagedIntentRejectOutcome,
  reason?: string | null,
): Promise<void> {
  if (!sessionManager || !intent.sessionId) return;
  const payload = intent.payload as CapabilityRequestPayload;

  if (outcome === 'approved') {
    sessionManager.grantCapability(intent.sessionId, payload.capability);
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
 * Composes the proposed body a Ready readiness check should see: the stored
 * page body with any live (staged/approved) task.updateBody for this task in
 * the same group applied over it — used by both the eager approve-time check
 * and (implicitly, via commit ordering) authoritative at commit time.
 */
async function computeProposedBody(
  backend: ReturnType<typeof getTaskBackend>,
  groupId: string | null | undefined,
  taskId: string,
): Promise<string> {
  const stored = (await backend.fetchTaskPage(taskId)) ?? '';
  if (!groupId) return stored;
  const updateBodyRow = listStagedIntentsByGroup(groupId).find(
    (row) =>
      row.kind === 'task.updateBody' &&
      ACTIVE_STATES.includes(row.state) &&
      (JSON.parse(row.payload) as UpdateBodyPayload).taskId === taskId,
  );
  if (!updateBodyRow) return stored;
  const payload = JSON.parse(updateBodyRow.payload) as UpdateBodyPayload;
  return composeProposedBody(stored, payload.sections);
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

  const committed: string[] = [];
  for (const row of ordered) {
    const intent = rowToApi(row);
    try {
      await applyIntent(
        intent,
        opts.override ? { reason: opts.reason } : undefined,
        opts.actorType,
        opts.triageMilestoneLabel,
      );
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
      if (err instanceof DependsOnCompletenessError) {
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
      return {
        status: 500,
        body: {
          error: err instanceof Error ? err.message : 'Failed to commit group',
          committed,
          failedId: intent.id,
          remaining,
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
  router.post('/staged-intents', (req: Request, res: Response) => {
    const body = req.body as {
      kind?: unknown;
      payload?: unknown;
      projectId?: unknown;
      groupId?: unknown;
      decisionProposal?: unknown;
    };
    const kind = typeof body.kind === 'string' ? body.kind : null;
    const projectId =
      typeof body.projectId === 'string' ? body.projectId : null;
    const groupId = typeof body.groupId === 'string' ? body.groupId : null;
    const decisionProposal =
      typeof body.decisionProposal === 'string' ? body.decisionProposal : null;

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

    const intent = stageIntent(
      kind,
      body.payload,
      projectId,
      groupId,
      null,
      decisionProposal,
    );
    res.status(201).json(intent);
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
        if (err instanceof DependsOnCompletenessError) {
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
        res.status(500).json({
          error: err instanceof Error ? err.message : 'Failed to apply intent',
        });
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
          const violations = checkReadiness(body);
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

      const rejected = transitionStagedIntent(row.id, 'rejected', {
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
      res.json({ ok: true });
    },
  );

  return router;
}
