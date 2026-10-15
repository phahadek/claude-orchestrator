import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentSession } from '../../session/AgentSession';
import type { PlanningWorkflow } from '../../planning/planningIntentKinds';
import {
  reviewDispositionSchema,
  reviewVerdictSchema,
  gateVerifyDispositionSchema,
  gateVerifyEvidenceSchema,
  gateVerifyReclassifySchema,
  gateVerifyProposedFixSchema,
  gateVerifyPayloadSchema,
  gateVerifyResultSchema,
  deployAgenticVerdictSchema,
} from './schemas';

/** Per-connection context a verdict-delivery tool call is scoped to. */
export interface VerdictToolContext {
  sessionId: string;
  /** Resolved lazily at call time — a session may not yet be live when the MCP connection is established. */
  getSession: () => AgentSession | undefined;
  /**
   * The connecting session's planning workflow, or null for a
   * non-planning (standard/review) session. review.disposition and
   * flaky.confirm are scoped to non-planning sessions; gate.verify is
   * scoped to 'ops' sessions as a whole, mirroring OPS_MCP_TOOLS in
   * config.ts.
   */
  workflow: PlanningWorkflow | null;
}

function notLive(): { content: { type: 'text'; text: string }[] } {
  return {
    content: [
      { type: 'text', text: JSON.stringify({ error: 'session_not_live' }) },
    ],
  };
}

function ok(): { content: { type: 'text'; text: string }[] } {
  return {
    content: [{ type: 'text', text: JSON.stringify({ status: 'ok' }) }],
  };
}

function invalid(message: string): {
  content: { type: 'text'; text: string }[];
  isError: true;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

/**
 * Registers the verdict-delivery MCP tool surface — one tool per
 * stdout-scraped disposition block the retired parsers (parseDispositionBlock
 * / parseGateVerifyDisposition, see
 * AgentSession.ts) used to extract from assistant text. Each tool delegates
 * to the matching AgentSession.recordXDisposition method, which emits the
 * exact same internal event (dispositions_parsed
 * / gate_verify_disposition) those parsers emitted, so ReviewOrchestrator,
 * PRMergeWatcher, and GateItemVerifier are unaffected by this new transport.
 * Idempotency (per session, per item) is enforced inside those AgentSession
 * methods — a same-content repeat call is a dedup no-op.
 */
export function registerVerdictTools(
  server: McpServer,
  ctx: VerdictToolContext,
): void {
  if (ctx.workflow === null) {
    server.registerTool(
      'review.disposition',
      {
        title: 'Report a review-thread disposition',
        description:
          'Reports how this session addressed one PR review comment — addressed/wont_fix/out_of_scope. Call once per comment_id; a repeat call with a changed disposition is last-write-wins.',
        inputSchema: {
          comment_id: z.number(),
          disposition: reviewDispositionSchema,
          reason: z.string().optional(),
        },
      },
      async (args) => {
        const session = ctx.getSession();
        if (!session) return notLive();
        session.recordReviewDisposition({
          comment_id: args.comment_id,
          disposition: args.disposition,
          reason: args.reason,
        });
        return ok();
      },
    );

    server.registerTool(
      'review.verdict',
      {
        title: 'Report this PR conformance review verdict',
        description:
          "Reports this review session's PR conformance verdict — approved/needs_changes/incomplete/error, plus the per-dimension pass/fail breakdown and a summary — as the definitive, schema-validated replacement for outputting a JSON verdict block in chat text. Call once per review iteration, as your final action once you have finished evaluating the diff against the task spec. A repeat call in the same iteration is last-write-wins.",
        inputSchema: {
          verdict: reviewVerdictSchema,
          dimensions: z.array(
            z.object({
              name: z.string(),
              passed: z.boolean(),
              notes: z.string().optional(),
            }),
          ),
          summary: z.string(),
          manualItemsForHuman: z.array(z.string()).optional(),
          escalate: z.boolean().optional(),
          escalationReason: z.string().optional(),
        },
      },
      async (args) => {
        const session = ctx.getSession();
        if (!session) return notLive();
        session.recordReviewVerdict({
          verdict: args.verdict,
          dimensions: args.dimensions,
          summary: args.summary,
          manualItemsForHuman: args.manualItemsForHuman,
          escalate: args.escalate,
          escalationReason: args.escalationReason,
        });
        return ok();
      },
    );
  }

  if (ctx.workflow === 'ops') {
    server.registerTool(
      'gate.verify',
      {
        title: 'Stage a gate-item verification disposition',
        description:
          'Stages this read-only gate-verify session\'s finding for the single gate item it was dispatched to verify — pass/fail/needs-setup/not-yet-triggerable, plus an optional self-correction reclassify proposal (Human-Observation or needs-triage only) — as a normal gate.verify intent for an operator to dispose on the decision surface, exactly like any other staged intent. Use needs-setup only when a real setup step is missing that a human must perform; use not-yet-triggerable when the scenario simply has not occurred yet or the data does not exist yet — it parks the item for a scheduled retry instead of shelving it. gateItemId must be the FULL gate item uuid (e.g. "3b022f91-52f3-8173-b9b2-ada4fdb54c82"), never an 8-character short form — this project\'s ids share long structured prefixes, so a truncated id is rejected at stage time rather than resolved. A fail REQUIRES proposedFix carrying the located root cause — {title, cause:{file,line,condition}, input, fix, filesAffected[], automatedCriteria[]} — or {existingTaskId} of an open task on this milestone board that already names the cause; cause.file and non-"*(new)*" filesAffected entries must be tracked repo files. If you could not locate the cause, report needs-setup with evidence.found prefixed "cause not located:" instead. proposedFix is rejected on any disposition other than fail. The operator, never the session or the backend automatically, turns this into the gate_item_event write; a rejection resumes this session for a normal turn to revise and report again, with no limit on revisions.',
        inputSchema: {
          gateItemId: z.string(),
          disposition: gateVerifyDispositionSchema,
          evidence: gateVerifyEvidenceSchema.optional(),
          reclassify: gateVerifyReclassifySchema.optional(),
          proposedFix: gateVerifyProposedFixSchema.optional(),
        },
      },
      async (args) => {
        const session = ctx.getSession();
        if (!session) return notLive();
        const parsed = gateVerifyPayloadSchema.safeParse(args);
        if (!parsed.success) {
          return invalid(parsed.error.issues.map((i) => i.message).join('; '));
        }
        let staged;
        try {
          staged = session.recordGateVerifyDisposition({
            gateItemId: args.gateItemId,
            disposition: args.disposition,
            evidence: args.evidence,
            reclassify: args.reclassify,
            proposedFix: args.proposedFix,
          });
        } catch (err) {
          return invalid(err instanceof Error ? err.message : String(err));
        }
        const result: z.infer<typeof gateVerifyResultSchema> = {
          status: 'ok',
          id: staged.id,
          milestone: staged.milestone ?? null,
        };
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    );

    server.registerTool(
      'deploy.verdict',
      {
        title: 'Report a deploy agentic-step verdict',
        description:
          "Reports this dispatched deploy-agentic-step session's finding — approved/rejected/inconclusive — as your final action. Call exactly once, never as a chat block: the deploy engine gates the next playbook step directly on this report, with no operator disposition in between. The run/step this applies to is resolved from this session's own dispatch, not from any argument you pass — you cannot report for a step other than the one you were dispatched to validate.",
        inputSchema: {
          verdict: deployAgenticVerdictSchema,
          detail: z.string().optional(),
        },
      },
      async (args) => {
        const session = ctx.getSession();
        if (!session) return notLive();
        try {
          session.recordDeployAgenticVerdict({
            verdict: args.verdict,
            detail: args.detail,
          });
        } catch (err) {
          return invalid(err instanceof Error ? err.message : String(err));
        }
        return ok();
      },
    );
  }
}
