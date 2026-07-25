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
import type { TaskPropertiesPatch } from '../tasks/TaskBackend';
import type { TaskBodySections } from '../tasks/bodyRender';
import {
  checkReadiness,
  composeProposedBody,
  ReadinessGateError,
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
  findActiveDecisionPickOneForSession,
  transitionStagedIntent,
  supersedeStagedIntent,
  setStagedIntentAnnotation,
  setStagedIntentGroup,
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
 * True when the group already stages a live gate.accrete/seed.stage intent
 * for this task — group-commit ordering (`ordered` in commitGroupIntents)
 * always applies it, for real, before the arming task.setStatus -> Ready
 * intent, so its durable marker will exist by the time the real
 * TaskWriteCommands.setStatus gate check runs. Used only to skip the
 * corresponding accretion check ahead of that real application (in
 * runStageTimeReadyChecks / precheckGroupCommit) — the real check always
 * still runs, against the real marker, once the group's non-arming intents
 * have actually applied.
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
  'decision.pickOne',
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
 * the existing row (and its approval, if any) is returned untouched, except
 * that a groupId carried by the re-emission which the existing row lacks (or
 * differs from) is applied to the existing row in place — groupId is settable
 * grouping metadata, not part of the content-idempotent identity. A
 * re-emission that differs on payload supersedes the standing intent
 * (tombstoning it) and re-enters `staged`, requiring fresh approval. decision.pickOne carries
 * no taskId (it is a question, not a task write), so it dedups instead on
 * (sessionId, payload_hash) — see findActiveDecisionPickOneForSession.
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

export function stageIntent(
  kind: string,
  payload: unknown,
  projectId: string,
  groupId?: string | null,
  sessionId?: string | null,
  decisionProposal?: string | null,
  groomProposal?: GroomProposalFields | null,
): StagedIntent {
  if (kind === 'decision.pickOne') {
    validateDecisionPickOnePayload(payload, groupId, decisionProposal);
  }

  const taskId = extractTaskId(kind, payload);
  const payloadHash = hashIntentPayload(payload);
  const now = Date.now();
  const groomProposalJson = groomProposal
    ? JSON.stringify(groomProposal)
    : null;

  const existing = taskId
    ? findActiveStagedIntentForTask(projectId, kind, taskId)
    : kind === 'decision.pickOne' && sessionId
      ? findActiveDecisionPickOneForSession(sessionId)
      : undefined;

  if (existing) {
    if (existing.payload_hash === payloadHash) {
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
    intent.groupId
      ? {
          skipGateContributionCheck: hasGroupAccretionIntent(
            intent.groupId,
            payload.taskId,
            'gate.accrete',
          ),
          skipSeedContributionCheck: hasGroupAccretionIntent(
            intent.groupId,
            payload.taskId,
            'seed.stage',
          ),
        }
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
  router.post('/staged-intents', async (req: Request, res: Response) => {
    const body = req.body as {
      kind?: unknown;
      payload?: unknown;
      projectId?: unknown;
      groupId?: unknown;
      decisionProposal?: unknown;
      groomProposal?: unknown;
    };
    const kind = typeof body.kind === 'string' ? body.kind : null;
    const projectId =
      typeof body.projectId === 'string' ? body.projectId : null;
    const groupId = typeof body.groupId === 'string' ? body.groupId : null;
    const decisionProposal =
      typeof body.decisionProposal === 'string' ? body.decisionProposal : null;
    const groomProposal = parseGroomProposal(body.groomProposal);

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
      groomProposal,
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
        !chosenLabel ||
        !payload.options.some((o) => o.label === chosenLabel)
      ) {
        res
          .status(400)
          .json({ error: 'chosenLabel must match one of the staged options' });
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
