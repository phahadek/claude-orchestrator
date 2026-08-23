import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getTaskBackend } from '../../tasks/TaskBackend';
import type { TaskSummary } from '../../tasks/TaskBackend';
import type { PlanningWorkflow } from '../../planning/planningIntentKinds';
import { STATUS_DISPLAY } from '../../tasks/statusCanonical';

/** Per-connection context the task read tools are scoped to. */
export interface TaskReadToolContext {
  projectId: string;
  workflow: PlanningWorkflow | null;
}

/** Server-side result cap for task.queryTasks — never return an unbounded page. */
const MAX_QUERY_RESULTS = 25;

/** { id, title, type, status } — same field set as task.getById, plus the bare id. */
interface TaskQueryResult extends TaskSummary {
  id: string;
}

/**
 * Registers `task.getById` — the read-only board-metadata lookup a
 * groom/design/ops session dereferences on demand for a task id outside its
 * injected digest (e.g. a dependency candidate surfaced mid-grooming).
 * Returns only `{ title, type, status }` — no body, no URL — following the
 * same default-tool precedent as `architecture.getUnit`/`architecture.queryUnits`
 * (architectureReadTools.ts): the observed need is ordinary board metadata a
 * session already partly has, not a privileged escalation, so it's always-on
 * for the qualifying session types rather than gated behind
 * `session.requestCapability`.
 */
export function registerTaskReadTools(
  server: McpServer,
  ctx: TaskReadToolContext,
): void {
  if (
    ctx.workflow !== 'groom' &&
    ctx.workflow !== 'design' &&
    ctx.workflow !== 'ops'
  ) {
    return;
  }

  server.registerTool(
    'task.getById',
    {
      title: 'Fetch one task summary by id',
      description:
        'Read-only: returns { title, type, status } for the given task id, or null if no task exists with that id. No body, no URL.',
      inputSchema: { taskId: z.string() },
    },
    async (args) => {
      const backend = getTaskBackend(ctx.projectId);
      const summary = await backend.fetchTaskSummary(args.taskId);
      return {
        content: [{ type: 'text', text: JSON.stringify(summary) }],
      };
    },
  );

  server.registerTool(
    'task.queryTasks',
    {
      title: 'Search board tasks by status/title/type',
      description:
        'Read-only: lists tasks on the board matching the given filters, as ' +
        '{ id, title, type, status } — same field set as task.getById, no body, no URL. ' +
        'status is a board display status (e.g. "🔲 Backlog"); omitted, every status is searched. ' +
        'titleContains is a case-insensitive substring match. type is an exact Type filter. ' +
        `Results are capped at ${MAX_QUERY_RESULTS} server-side regardless of limit. ` +
        'Returned ids are in the bare form task.setDependsOn accepts and task.getById dereferences.',
      inputSchema: {
        status: z.string().optional(),
        titleContains: z.string().optional(),
        type: z.string().optional(),
        limit: z.number().optional(),
      },
    },
    async (args) => {
      const backend = getTaskBackend(ctx.projectId);
      const statuses = args.status
        ? [args.status]
        : Object.values(STATUS_DISPLAY);

      const byId = new Map<string, TaskQueryResult>();
      for (const status of statuses) {
        const resolved = await backend.listTasksByStatus(status);
        for (const { task } of resolved) {
          byId.set(task.id, {
            id: task.id,
            title: task.title,
            type: task.type,
            status: task.status,
          });
        }
      }

      let results = [...byId.values()];
      if (args.type !== undefined) {
        results = results.filter((r) => r.type === args.type);
      }
      if (args.titleContains !== undefined) {
        const needle = args.titleContains.toLowerCase();
        results = results.filter((r) => r.title.toLowerCase().includes(needle));
      }

      const limit =
        args.limit !== undefined
          ? Math.min(args.limit, MAX_QUERY_RESULTS)
          : MAX_QUERY_RESULTS;
      results = results.slice(0, Math.max(0, limit));

      return {
        content: [{ type: 'text', text: JSON.stringify(results) }],
      };
    },
  );
}
