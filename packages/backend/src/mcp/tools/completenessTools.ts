import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  buildCompletenessDispositionRow,
  insertCompletenessDisposition,
} from '../../db/queries';
import type { CompletenessDispositionQuestion } from '../../db/types';
import {
  computeTraceCoverage,
  type TraceCoverageInput,
} from '../../design/completenessSignal';
import type { PlanningWorkflow } from '../../planning/planningIntentKinds';
import { normalizeTaskId } from '../../tasks/taskId';
import {
  stageIntent,
  type CompletenessDispositionIntentPayload,
} from '../../routes/stagedIntents';

/** Per-connection context the completeness tool surface is scoped to. */
export interface CompletenessToolContext {
  sessionId: string;
  workflow: PlanningWorkflow | null;
  /** Undefined when the session resolves to no project — the intent-staging half is then skipped (nothing to stage against). */
  projectId?: string | null;
}

function ok(body: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(body) }] };
}

const dispositionQuestionSchema = z.object({
  question: z.string(),
  disposition: z.enum(['accepted', 'dismissed']),
  reason: z.string(),
  approvalStatus: z.enum(['proposed', 'approved', 'rejected']).optional(),
});

const lockedDecisionSchema = z.object({
  question: z.string(),
  decision: z.string(),
});

const followOnTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  filesSection: z.string(),
  rawMarkdown: z.string(),
});

const worklistOptionsSchema = z.object({
  sourceRoot: z.string().optional(),
  packages: z.array(z.string()).optional(),
  areaAliases: z.record(z.string(), z.string()).optional(),
  trackedFiles: z.array(z.string()),
});

/**
 * Registers the design completeness-safeguard MCP tool surface —
 * completeness.disposition and completeness.traceCoverage (the advisory read
 * mirroring POST /api/design/:taskId/trace-coverage, computed locally with
 * no store write). completeness.disposition durably writes the critic's
 * findings to the completeness_disposition store immediately (mirroring
 * POST /api/design/:taskId/completeness-disposition — disposition-don't-drop:
 * nothing is silently lost even before the operator has seen it), then
 * additionally stages a `completeness.disposition` StagedIntent carrying the
 * same findings for operator approval — the gate
 * routes/stagedIntents.ts enforces before a design session's
 * arch.createUnit/updateUnit/supersedeUnit and closing-synthesis
 * task.updateBody writes are allowed to stage. The durable write and the
 * staged intent are deliberately two separate steps: the write can never be
 * lost, and the intent is what the operator actually approves or rejects.
 */
export function registerCompletenessTools(
  server: McpServer,
  ctx: CompletenessToolContext,
): void {
  if (ctx.workflow !== 'design') return;

  server.registerTool(
    'completeness.disposition',
    {
      title: 'Record a completeness-critic disposition',
      description:
        'Durably records the /design completeness critic’s dispositions for one task — never body prose — and stages a completeness.disposition intent for operator approval. Call once per critic run, immediately, so nothing is silently lost before the operator has seen it. arch.createUnit/updateUnit/supersedeUnit and the closing-synthesis task.updateBody are blocked until the staged intent this returns is approved.',
      inputSchema: {
        taskId: z.string(),
        project: z.string().optional(),
        milestone: z.string().optional(),
        questions: z.array(dispositionQuestionSchema),
        runAt: z.string(),
      },
    },
    async (args) => {
      const taskId = normalizeTaskId(args.taskId);
      const newRow = buildCompletenessDispositionRow({
        taskId,
        project: args.project ?? null,
        milestone: args.milestone ?? null,
        questions: args.questions as CompletenessDispositionQuestion[],
        runAt: args.runAt,
      });
      const row = insertCompletenessDisposition(newRow);
      const questions = JSON.parse(
        row.questions,
      ) as CompletenessDispositionQuestion[];

      let intent = null;
      if (ctx.projectId) {
        const payload: CompletenessDispositionIntentPayload = {
          taskId,
          rowId: row.id,
          project: row.project,
          milestone: row.milestone,
          questions,
          runAt: row.run_at,
        };
        intent = stageIntent(
          'completeness.disposition',
          payload,
          ctx.projectId,
          null,
          ctx.sessionId,
        );
      }

      return ok({ ...row, questions, intent });
    },
  );

  server.registerTool(
    'completeness.traceCoverage',
    {
      title: 'Compute the advisory trace-coverage signal',
      description:
        'Advisory-only aid for the /design completeness critic: flags a filed follow-on task’s region or an acceptance criterion that traces to no locked decision. Never an error, never a gate — an empty flags result for a task with no coverage data is a valid outcome.',
      inputSchema: {
        taskId: z.string(),
        acceptanceCriteria: z.array(z.string()),
        lockedDecisions: z.array(lockedDecisionSchema),
        followOnTasks: z.array(followOnTaskSchema),
        worklistOptions: worklistOptionsSchema,
      },
    },
    async (args) => {
      const input: TraceCoverageInput = {
        designTaskId: args.taskId,
        acceptanceCriteria: args.acceptanceCriteria,
        lockedDecisions: args.lockedDecisions,
        followOnTasks: args.followOnTasks,
        worklistOptions: args.worklistOptions,
      };
      const result = computeTraceCoverage(input);
      return ok(result);
    },
  );
}
