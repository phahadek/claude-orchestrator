import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getTaskBackend } from '../../tasks/TaskBackend';
import type { PlanningWorkflow } from '../../planning/planningIntentKinds';

/** Per-connection context the task read tools are scoped to. */
export interface TaskReadToolContext {
  projectId: string;
  workflow: PlanningWorkflow | null;
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
}
