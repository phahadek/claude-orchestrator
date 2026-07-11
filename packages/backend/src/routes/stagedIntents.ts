import { Router } from 'express';
import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { getTaskBackend } from '../tasks/TaskBackend';
import {
  BackendTaskWriteCommands,
  type TaskStatus,
} from '../tasks/TaskWriteCommands';
import type { NewTaskFields } from '../tasks/TaskBackend';

/**
 * The general staged-intent surface: a single chokepoint producers (Groom(N),
 * Ops(N), and future callers) stage generic { kind, payload } intents through,
 * and a human applies or rejects. Apply always dispatches through
 * TaskWriteCommands — never a bespoke per-producer write.
 */
export interface StagedIntent {
  id: string;
  kind: string;
  payload: unknown;
  projectId: string;
  createdAt: number;
}

const store = new Map<string, StagedIntent>();

interface CreateTaskPayload extends NewTaskFields {}
interface SetStatusPayload {
  taskId: string;
  status: TaskStatus;
}
interface SetDependsOnPayload {
  taskId: string;
  dependsOn: string[];
}

async function applyIntent(intent: StagedIntent): Promise<unknown> {
  const backend = getTaskBackend(intent.projectId);
  const commands = new BackendTaskWriteCommands(backend);

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
  router.post(
    '/staged-intents/:id/apply',
    async (req: Request, res: Response) => {
      const intent = store.get(String(req.params.id));
      if (!intent) {
        res.status(404).json({ error: 'staged intent not found' });
        return;
      }

      try {
        const result = await applyIntent(intent);
        store.delete(intent.id);
        res.json({ ok: true, result });
      } catch (err) {
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
