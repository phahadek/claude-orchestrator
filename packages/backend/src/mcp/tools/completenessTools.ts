import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { insertCompletenessDisposition } from '../../db/queries';
import type { CompletenessDispositionQuestion } from '../../db/types';
import {
  computeTraceCoverage,
  type TraceCoverageInput,
} from '../../design/completenessSignal';
import type { PlanningWorkflow } from '../../planning/planningIntentKinds';

/** Per-connection context the completeness tool surface is scoped to. */
export interface CompletenessToolContext {
  sessionId: string;
  workflow: PlanningWorkflow | null;
}

function ok(body: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(body) }] };
}

const dispositionQuestionSchema = z.object({
  question: z.string(),
  disposition: z.enum(['accepted', 'dismissed']),
  reason: z.string(),
  approvalStatus: z.enum(['proposed', 'approved']).optional(),
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
 * completeness.disposition (a direct write to the completeness_disposition
 * store, mirroring the device-authed POST /api/design/:taskId/completeness-
 * disposition route) and completeness.traceCoverage (the advisory read
 * mirroring POST /api/design/:taskId/trace-coverage). Both delegate to the
 * exact same store helper / computation the HTTP route uses — no
 * StagedIntent row, no apply step, following the gate.verify direct-write
 * precedent (verdictTools.ts) rather than the stage-proposal pattern
 * (stageProposalTools.ts), because a dispatched design session holds only
 * the loopback session-stage credential and can never reach the device-
 * authed HTTP route these mirror (see design.ts, mounted behind
 * requireDeviceAuth).
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
        'Durably records the /design completeness critic’s dispositions for one task — never body prose. Call once per critic run, immediately, so nothing is silently lost before the operator has seen it.',
      inputSchema: {
        taskId: z.string(),
        project: z.string().optional(),
        milestone: z.string().optional(),
        questions: z.array(dispositionQuestionSchema),
        runAt: z.string(),
      },
    },
    async (args) => {
      const questions = args.questions.map((q) => ({
        approvalStatus: 'proposed' as const,
        ...q,
      })) as CompletenessDispositionQuestion[];
      const row = insertCompletenessDisposition({
        source_task_id: args.taskId,
        project: args.project ?? null,
        milestone: args.milestone ?? null,
        questions: JSON.stringify(questions),
        run_at: args.runAt,
      });
      return ok({
        ...row,
        questions: JSON.parse(
          row.questions,
        ) as CompletenessDispositionQuestion[],
      });
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
