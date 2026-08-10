import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getPRByNotionTaskId, getPRAsOf } from '../../db/queries';

/**
 * Registers `pullRequest.getByTaskId` — the read-only pull_requests lookup a
 * verify/investigation session (session_type standard/review, workflow=null)
 * dereferences for the PR tied to a task it's examining. Always-on for any
 * session resolving to a project — not gated to groom/design/ops the way
 * `task.getById`/`architecture.getUnit` are — since these Tier-A read tools
 * exist specifically for the non-planning session types that surface here.
 * Returns null (not a thrown error) when no PR row exists for the task,
 * matching `task.getById`'s not-found convention.
 */
export function registerPullRequestReadTools(server: McpServer): void {
  server.registerTool(
    'pullRequest.getByTaskId',
    {
      title: 'Fetch the pull request for a task id',
      description:
        'Read-only: returns the most recent pull_requests row for the given task id, or null if no PR exists for that task. Optional `asOf` (ISO timestamp) reconstructs the PR as of that time instead of reading current state — static identity fields (pr_number, pr_url, task_id, session_id, repo, branches, created_at, node_id) come back with real values, every mutable field (state, review/merge/CI status, etc.) comes back as an { __unreconstructable: true, reason } marker instead of the live value.',
      inputSchema: { taskId: z.string(), asOf: z.string().optional() },
    },
    async (args) => {
      const pr = args.asOf
        ? (getPRAsOf(args.taskId, args.asOf) ?? null)
        : (getPRByNotionTaskId(args.taskId) ?? null);
      return {
        content: [{ type: 'text', text: JSON.stringify(pr) }],
      };
    },
  );
}
