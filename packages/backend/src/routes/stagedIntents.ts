import { Router } from 'express';
import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { getTaskBackend } from '../tasks/TaskBackend';
import {
  BackendTaskWriteCommands,
  type TaskStatus,
} from '../tasks/TaskWriteCommands';
import type { NewTaskFields, TaskPropertiesPatch } from '../tasks/TaskBackend';
import type { TaskBodySections } from '../tasks/bodyRender';
import {
  ReadinessGateError,
  type ReadinessViolation,
} from '../tasks/readinessGate';

/**
 * The general staged-intent surface: a single chokepoint producers (Groom(N),
 * Ops(N), and future callers) stage generic { kind, payload } intents through,
 * and a human applies or rejects. Apply always dispatches through
 * TaskWriteCommands — never a bespoke per-producer write.
 */
interface StagedIntent {
  id: string;
  kind: string;
  payload: unknown;
  projectId: string;
  createdAt: number;
  /** Set when the last apply attempt was hard-blocked by the readiness gate. */
  annotation?: { blocked: true; violations: ReadinessViolation[] } | null;
}

const store = new Map<string, StagedIntent>();

type CreateTaskPayload = NewTaskFields;
interface SetStatusPayload {
  taskId: string;
  status: TaskStatus;
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
interface ArchivePayload {
  taskId: string;
}

/** Intent kinds accepted by POST /staged-intents. */
const KNOWN_INTENT_KINDS: ReadonlySet<string> = new Set([
  'task.create',
  'task.setStatus',
  'task.setDependsOn',
  'task.updateBody',
  'task.setProperties',
  'task.archive',
]);

/**
 * Archive and the structural intents (body/property rewrites) are
 * human-apply-only — applied through the device-auth apply path, never a
 * session credential. See Technical Architecture § Authority-vs-drift.
 */
const HUMAN_APPLY_ONLY_KINDS: ReadonlySet<string> = new Set([
  'task.updateBody',
  'task.setProperties',
  'task.archive',
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
      await commands.setStatus(payload.taskId, payload.status, {
        source: 'human',
        readinessOverride: override,
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
    case 'task.archive': {
      const payload = intent.payload as ArchivePayload;
      await commands.archive(payload.taskId, { source: 'human' });
      return { ok: true };
    }
    default:
      throw new Error(`[stagedIntents] unknown intent kind "${intent.kind}"`);
  }
}

export function createStagedIntentsRouter(): Router {
  const router = Router();

  // ── GET /api/staged-intents ─────────────────────────────────────────────
  router.get('/staged-intents', (req: Request, res: Response) => {
    const projectId =
      typeof req.query.projectId === 'string' ? req.query.projectId : null;
    const intents = Array.from(store.values()).filter(
      (intent) => !projectId || intent.projectId === projectId,
    );
    res.json({ intents });
  });

  // ── POST /api/staged-intents ─────────────────────────────────────────────
  router.post('/staged-intents', (req: Request, res: Response) => {
    const body = req.body as {
      kind?: unknown;
      payload?: unknown;
      projectId?: unknown;
    };
    const kind = typeof body.kind === 'string' ? body.kind : null;
    const projectId =
      typeof body.projectId === 'string' ? body.projectId : null;

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

    const intent: StagedIntent = {
      id: randomUUID(),
      kind,
      payload: body.payload ?? null,
      projectId,
      createdAt: Date.now(),
    };
    store.set(intent.id, intent);
    res.status(201).json(intent);
  });

  // ── POST /api/staged-intents/:id/apply ───────────────────────────────────
  // Human / device-authenticated surface only — the only place `override` is
  // accepted. Auto-dispatched, stage-only producers never call this route.
  router.post(
    '/staged-intents/:id/apply',
    async (req: Request, res: Response) => {
      const intent = store.get(String(req.params.id));
      if (!intent) {
        res.status(404).json({ error: 'staged intent not found' });
        return;
      }

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
        intent.annotation = null;
        store.delete(intent.id);
        res.json({ ok: true, result });
      } catch (err) {
        if (err instanceof ReadinessGateError) {
          intent.annotation = { blocked: true, violations: err.violations };
          res.status(409).json({
            error: err.message,
            violations: err.violations,
          });
          return;
        }
        if (err instanceof HumanApplyOnlyError) {
          res.status(403).json({ error: err.message });
          return;
        }
        res.status(500).json({
          error: err instanceof Error ? err.message : 'Failed to apply intent',
        });
      }
    },
  );

  // ── POST /api/staged-intents/:id/reject ──────────────────────────────────
  router.post('/staged-intents/:id/reject', (req: Request, res: Response) => {
    const intent = store.get(String(req.params.id));
    if (!intent) {
      res.status(404).json({ error: 'staged intent not found' });
      return;
    }
    store.delete(intent.id);
    res.json({ ok: true });
  });

  return router;
}
