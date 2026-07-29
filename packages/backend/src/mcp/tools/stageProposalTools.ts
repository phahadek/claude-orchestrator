import { z } from 'zod';
import type {
  McpServer,
  ToolCallback,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  stageIntent,
  routeStageTimeBlock,
  validateAndNormalizeTaskReferences,
  withdrawIntent,
  type StagedIntent,
} from '../../routes/stagedIntents';
import type { SessionManager } from '../../session/SessionManager';
import {
  taskTypeSchema,
  taskStatusSchema,
  gateContributionDecisionSchema,
  seedContributionDecisionSchema,
  opsStateSchema,
  taskBodySectionsSchema,
  patchBodySectionPayloadSchema,
  groomingGateEntrySchema,
  intentEnvelopeShape,
  gateContributionSourceTaskSchema,
  gateContributionItemInputSchema,
  seedContributionSourceTaskSchema,
  seedContributionItemInputSchema,
  archUnitMetadataSchema,
  archCreateUnitPayloadSchema,
  decisionPickOneOptionSchema,
} from './schemas';
import { GATE_ITEM_TIER_SELECTION_GUIDANCE } from '../../gate/gateItemClassificationGuidance';

/** Per-connection context a stage-proposal tool call is scoped to. */
export interface StageProposalToolContext {
  sessionId: string;
  projectId: string;
  /**
   * Restricts registration to this set of staged-intent kinds (e.g. a
   * planning workflow's PLANNING_INTENT_KINDS entry). Undefined registers
   * every kind — the code/review session behavior, unchanged.
   */
  kinds?: readonly string[];
  /** Used to route a stage-time validation block back to this session in-turn, via enqueueFeedback. */
  sessionManager?: SessionManager;
}

/** Shape of the { payload, groupId?, decisionProposal?, groomProposal? } envelope every tool accepts. */
function envelope<T extends z.ZodRawShape>(payloadShape: T) {
  return {
    payload: z.object(payloadShape),
    ...intentEnvelopeShape,
  };
}

async function stage(
  kind: string,
  payload: unknown,
  ctx: StageProposalToolContext,
  envelopeArgs: {
    groupId?: string;
    decisionProposal?: string;
    groomProposal?: z.infer<typeof intentEnvelopeShape.groomProposal>;
    supersedes?: string;
  },
): Promise<{ content: { type: 'text'; text: string }[] }> {
  const normalizedPayload = await validateAndNormalizeTaskReferences(
    kind,
    payload,
    ctx.projectId,
    envelopeArgs.groupId ?? null,
  );
  const intent: StagedIntent = stageIntent(
    kind,
    normalizedPayload,
    ctx.projectId,
    envelopeArgs.groupId ?? null,
    ctx.sessionId,
    envelopeArgs.decisionProposal ?? null,
    envelopeArgs.groomProposal ?? null,
    envelopeArgs.supersedes ?? null,
  );
  const checked = await routeStageTimeBlock(intent, ctx.sessionManager);
  return { content: [{ type: 'text', text: JSON.stringify(checked) }] };
}

/**
 * Registers one MCP tool per staged-intent kind in the dispatched-session
 * task-write vocabulary — a 1:1 mapping, no new kinds. Every tool delegates
 * to the exact same `stageIntent` chokepoint the human-facing POST
 * /staged-intents route and the loopback POST /task-intents route already
 * write through: this is a new transport onto the existing command layer,
 * never a parallel validation or apply path. Registered per-request, scoped
 * to the connecting session's id and project (see orchestratorMcpServer.ts).
 */
export function registerStageProposalTools(
  server: McpServer,
  ctx: StageProposalToolContext,
): void {
  function registerTool<Args extends z.ZodRawShape>(
    kind: string,
    meta: { title: string; description: string; inputSchema: Args },
    handler: ToolCallback<Args>,
  ): void {
    if (ctx.kinds && !ctx.kinds.includes(kind)) return;
    server.registerTool(kind, meta, handler);
  }

  registerTool(
    'task.create',
    {
      title: 'Stage a new task',
      description:
        'Stages a task.create intent — lands a new task at Backlog once a human applies it. Pass the full page body (raw markdown, the authoring-standard section format) via `body` — it is written verbatim at create time. task.updateBody is for revising a task that already exists, not for a task being staged now.',
      inputSchema: envelope({
        title: z.string(),
        type: taskTypeSchema.optional(),
        priority: z.string().optional(),
        dependsOn: z.array(z.string()).optional(),
        databaseId: z.string().optional(),
        milestone: z.string().optional(),
        body: z.string().optional(),
      }),
    },
    async (args) => stage('task.create', args.payload, ctx, args),
  );

  registerTool(
    'task.setStatus',
    {
      title: 'Stage a task status change',
      description:
        'Stages a task.setStatus intent. A Ready transition is checked against the grooming promotion gate and the readiness gate at stage time (advisory only — apply time remains the sole hard authority).',
      inputSchema: envelope({
        taskId: z.string(),
        status: taskStatusSchema,
        groomingGate: groomingGateEntrySchema,
      }),
    },
    async (args) => stage('task.setStatus', args.payload, ctx, args),
  );

  registerTool(
    'task.setDependsOn',
    {
      title: 'Stage a task Depends On change',
      description:
        'Stages a task.setDependsOn intent — an empty array is a valid "no deps" classification.',
      inputSchema: envelope({
        taskId: z.string(),
        dependsOn: z.array(z.string()),
      }),
    },
    async (args) => stage('task.setDependsOn', args.payload, ctx, args),
  );

  registerTool(
    'task.updateBody',
    {
      title: 'Stage a task body rewrite',
      description:
        'Stages a task.updateBody intent carrying the structured TaskBodySections map (Summary, Dependencies, Context, Acceptance criteria, Files/Notion pages affected) — never free markdown.',
      inputSchema: envelope({
        taskId: z.string(),
        sections: taskBodySectionsSchema,
      }),
    },
    async (args) => stage('task.updateBody', args.payload, ctx, args),
  );

  registerTool(
    'task.patchBodySection',
    {
      title: 'Stage a targeted task body-section patch',
      description:
        'Stages a task.patchBodySection intent — append/replace/remove against one heading-bounded section of a task body, without rewriting the rest of the page. append auto-creates the section; replace requires the section and the exact find text to already exist; remove on an absent section is a no-op.',
      inputSchema: {
        payload: patchBodySectionPayloadSchema,
        ...intentEnvelopeShape,
      },
    },
    async (args) => stage('task.patchBodySection', args.payload, ctx, args),
  );

  registerTool(
    'task.setProperties',
    {
      title: 'Stage a cosmetic task property change',
      description:
        'Stages a task.setProperties intent — Priority and Task Name only; Status/Type/Depends On have their own tools.',
      inputSchema: envelope({
        taskId: z.string(),
        patch: z.object({
          priority: z.string().optional(),
          title: z.string().optional(),
        }),
      }),
    },
    async (args) => stage('task.setProperties', args.payload, ctx, args),
  );

  registerTool(
    'gate.accrete',
    {
      title: 'Stage a runtime-item gate contribution',
      description:
        "Stages a gate.accrete intent — the source task's independently-assessed runtime-observable items to mint onto the milestone gate, or a bare 'none'/'n/a' classification. A bare classification requires a substantive `reason` — the groomer's judgement that the change's behaviour was assessed and found to have nothing runtime-observable, tied to the change rather than to the pre-groom body. " +
        `${GATE_ITEM_TIER_SELECTION_GUIDANCE} The top-level \`classification\` is the batch default; a heterogeneous batch overrides it per item via that item's own \`classification\` field instead of forcing every item in the batch to one tier.`,
      inputSchema: envelope({
        sourceTask: gateContributionSourceTaskSchema,
        items: z.array(gateContributionItemInputSchema),
        classification: gateContributionDecisionSchema,
        reason: z.string().optional(),
      }),
    },
    async (args) => stage('gate.accrete', args.payload, ctx, args),
  );

  registerTool(
    'seed.stage',
    {
      title: 'Stage a config-change seed contribution',
      description:
        "Stages a seed.stage intent — the source task's config-change seeds to mint onto the milestone seed store.",
      inputSchema: envelope({
        sourceTask: seedContributionSourceTaskSchema,
        seeds: z.array(seedContributionItemInputSchema),
        decision: seedContributionDecisionSchema,
      }),
    },
    async (args) => stage('seed.stage', args.payload, ctx, args),
  );

  registerTool(
    'arch.createUnit',
    {
      title: 'Stage a new architecture unit',
      description:
        'Stages an arch.createUnit intent — a new titled architecture statement (subsystem/invariant/decision/contract/reference).',
      inputSchema: envelope({
        title: z.string(),
        metadata: archUnitMetadataSchema,
        body: z.string(),
      }),
    },
    async (args) => stage('arch.createUnit', args.payload, ctx, args),
  );

  registerTool(
    'arch.updateUnit',
    {
      title: 'Stage an architecture unit edit',
      description:
        'Stages an arch.updateUnit intent against baseVersion (optimistic concurrency) — a stale base is rejected at apply time.',
      inputSchema: envelope({
        unitId: z.string(),
        baseVersion: z.number(),
        title: z.string().optional(),
        metadata: archUnitMetadataSchema.partial().optional(),
        body: z.string().optional(),
      }),
    },
    async (args) => stage('arch.updateUnit', args.payload, ctx, args),
  );

  registerTool(
    'arch.supersedeUnit',
    {
      title: 'Stage an architecture unit supersede',
      description:
        'Stages an arch.supersedeUnit intent — retires unitId at baseVersion and lands a replacement unit in its place.',
      inputSchema: envelope({
        unitId: z.string(),
        baseVersion: z.number(),
        replacement: archCreateUnitPayloadSchema,
      }),
    },
    async (args) => stage('arch.supersedeUnit', args.payload, ctx, args),
  );

  registerTool(
    'decision.pickOne',
    {
      title: 'Stage an operator decision question',
      description:
        'Stages a decision.pickOne question-intent — writes no task store, only a question the operator resolves via an answer. Requires a substantive decisionProposal and cannot belong to a group.',
      inputSchema: envelope({
        prompt: z.string(),
        options: z.array(decisionPickOneOptionSchema).min(1),
        allowFreeForm: z.boolean(),
      }),
    },
    async (args) => stage('decision.pickOne', args.payload, ctx, args),
  );

  registerTool(
    'journal.setState',
    {
      title: 'Stage an ops journal state change',
      description:
        'Stages a journal.setState intent — an in-place ops_journal entry transition (see ops/opsJournal.ts).',
      inputSchema: envelope({
        taskId: z.string(),
        state: opsStateSchema,
        fields: z.record(z.string(), z.unknown()).optional(),
      }),
    },
    async (args) => stage('journal.setState', args.payload, ctx, args),
  );

  registerTool(
    'session.requestCapability',
    {
      title: 'Request a capability grant for this session',
      description:
        "Stages a session.requestCapability intent — the exact tool/command or read this session wants (never a category), the plan it intends to use it for, and the evidence behind the request. The grant target is always this connection's own session.",
      inputSchema: envelope({
        capability: z.string(),
        plan: z.string(),
        evidence: z.string(),
      }),
    },
    async (args) => stage('session.requestCapability', args.payload, ctx, args),
  );

  registerTool(
    'planning.noOp',
    {
      title: 'Stage a deliberate no-op for this task',
      description:
        "Stages a planning.noOp intent — a deliberate declaration that this turn reached terminal with nothing to change, distinct from a silent park. Purely informational/auditable: no operator disposition is required or offered for it. Use only when there is genuinely no decision to make (e.g. a re-dispatch of an already-settled task) — if there is a real gap, name it instead (e.g. groom's Deferred path).",
      inputSchema: envelope({
        taskId: z.string(),
        reason: z.string(),
      }),
    },
    async (args) => stage('planning.noOp', args.payload, ctx, args),
  );

  // Not routed through `stage()`: unlike every other tool here, this acts
  // immediately on an existing staged intent rather than creating a new one
  // — see withdrawIntent's doc comment in stagedIntents.ts for why this is
  // not an operator disposition and requires no separate apply step.
  registerTool(
    'intent.withdraw',
    {
      title: 'Withdraw a staged intent this session staged',
      description:
        "Withdraws (terminally cancels) an intent this session previously staged, before an operator has disposed of it — for a mistake this session catches itself, instead of only being able to ask the operator in prose to discard it. Only reaches this session's own staged intents. Requires a substantive one-line reason, recorded on the withdrawn intent for the decision surface.",
      inputSchema: {
        payload: z.object({
          intentId: z.string(),
          reason: z.string(),
        }),
      },
    },
    async (args) => {
      const withdrawn = withdrawIntent(
        args.payload.intentId,
        args.payload.reason,
        ctx.sessionId,
      );
      return { content: [{ type: 'text', text: JSON.stringify(withdrawn) }] };
    },
  );
}
