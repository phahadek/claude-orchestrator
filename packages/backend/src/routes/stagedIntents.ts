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
import type { StagedIntentRow, StagedIntentState } from '../db/types';
import {
  hashIntentPayload,
  insertStagedIntent,
  getStagedIntent as getStagedIntentRow,
  listStagedIntentsByProject,
  listAllActiveStagedIntents,
  listStagedIntentsByGroup,
  findActiveStagedIntentForTask,
  transitionStagedIntent,
  supersedeStagedIntent,
  setStagedIntentAnnotation,
} from '../db/queries';

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
  };
}

/** Kinds carry their target task at `payload.taskId`, except task.create — a new task has no pre-existing id, so it never participates in dedup. */
function extractTaskId(kind: string, payload: unknown): string | null {
  if (kind === 'task.create') return null;
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
        created_at: now,
        updated_at: now,
      };
      return rowToApi(supersedeStagedIntent(existing.id, newRow));
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
    created_at: now,
    updated_at: now,
  };
  insertStagedIntent(row);
  return rowToApi(row);
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
): Promise<unknown> {
  if (HUMAN_APPLY_ONLY_KINDS.has(intent.kind) && actorType !== 'human') {
    throw new HumanApplyOnlyError(intent.kind);
  }

  const backend = getTaskBackend(intent.projectId);
  const commands = new BackendTaskWriteCommands(backend, intent.projectId);

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
      await commands.setStatus(payload.taskId, payload.status, {
        source: 'human',
        readinessOverride: override,
        groomingGate: payload.groomingGate,
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
    default:
      throw new Error(`[stagedIntents] unknown intent kind "${intent.kind}"`);
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

export function createStagedIntentsRouter(): Router {
  const router = Router();

  // ── GET /api/staged-intents ─────────────────────────────────────────────
  router.get('/staged-intents', (req: Request, res: Response) => {
    const projectId =
      typeof req.query.projectId === 'string' ? req.query.projectId : null;
    const rows = projectId
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
    };
    const kind = typeof body.kind === 'string' ? body.kind : null;
    const projectId =
      typeof body.projectId === 'string' ? body.projectId : null;
    const groupId = typeof body.groupId === 'string' ? body.groupId : null;

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

    const intent = stageIntent(kind, body.payload, projectId, groupId);
    res.status(201).json(intent);
  });

  // ── POST /api/staged-intents/:id/apply ───────────────────────────────────
  // Human / device-authenticated surface only — the only place `override` is
  // accepted. Auto-dispatched, stage-only producers never call this route.
  router.post(
    '/staged-intents/:id/apply',
    async (req: Request, res: Response) => {
      const row = getActiveStagedIntent(String(req.params.id));
      if (!row) {
        res.status(404).json({ error: 'staged intent not found' });
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
        transitionStagedIntent(intent.id, 'committed', { annotation: null });
        res.json({ ok: true, result });
      } catch (err) {
        if (err instanceof ReadinessGateError) {
          setStagedIntentAnnotation(
            intent.id,
            JSON.stringify({ blocked: true, violations: err.violations }),
          );
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
      res.json(rowToApi(updated));
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

      const live = listStagedIntentsByGroup(groupId).filter((r) =>
        ACTIVE_STATES.includes(r.state),
      );
      if (live.length === 0) {
        res.status(404).json({
          error: `no live staged intents found for group "${groupId}"`,
        });
        return;
      }
      const notApproved = live.filter((r) => r.state !== 'approved');
      if (notApproved.length > 0) {
        res.status(409).json({
          error: `group "${groupId}" has ${notApproved.length} intent(s) not yet approved`,
          pendingIds: notApproved.map((r) => r.id),
        });
        return;
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
            override ? { reason } : undefined,
            actorType,
          );
          transitionStagedIntent(intent.id, 'committed', { annotation: null });
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
            res.status(409).json({
              error: err.message,
              violations: err.violations,
              committed,
              failedId: intent.id,
              remaining,
            });
            return;
          }
          if (err instanceof GroomingGateError) {
            setStagedIntentAnnotation(
              intent.id,
              JSON.stringify({ blocked: true, reasons: err.reasons }),
            );
            res.status(409).json({
              error: err.message,
              reasons: err.reasons,
              committed,
              failedId: intent.id,
              remaining,
            });
            return;
          }
          if (err instanceof HumanApplyOnlyError) {
            res.status(403).json({
              error: err.message,
              committed,
              failedId: intent.id,
              remaining,
            });
            return;
          }
          if (err instanceof DependsOnCompletenessError) {
            res.status(409).json({
              error: err.message,
              committed,
              failedId: intent.id,
              remaining,
            });
            return;
          }
          res.status(500).json({
            error:
              err instanceof Error ? err.message : 'Failed to commit group',
            committed,
            failedId: intent.id,
            remaining,
          });
          return;
        }
      }

      res.json({ ok: true, committed });
    },
  );

  // ── POST /api/staged-intents/:id/reject ──────────────────────────────────
  router.post('/staged-intents/:id/reject', (req: Request, res: Response) => {
    const row = getActiveStagedIntent(String(req.params.id));
    if (!row) {
      res.status(404).json({ error: 'staged intent not found' });
      return;
    }
    transitionStagedIntent(row.id, 'rejected');
    res.json({ ok: true });
  });

  return router;
}
