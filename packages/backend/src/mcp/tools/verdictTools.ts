import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentSession } from '../../session/AgentSession';
import type { PlanningWorkflow } from '../../planning/planningIntentKinds';
import {
  reviewDispositionSchema,
  flakyGateSchema,
  gateVerifyDispositionSchema,
  gateVerifyEvidenceSchema,
  gateVerifyReclassifySchema,
  gateVerifyPayloadSchema,
  gateVerifyResultSchema,
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
 * / parseVerifiedFlakyDisposition / parseGateVerifyDisposition, see
 * AgentSession.ts) used to extract from assistant text. Each tool delegates
 * to the matching AgentSession.recordXDisposition method, which emits the
 * exact same internal event (dispositions_parsed / verified_flaky_disposition
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
      'flaky.confirm',
      {
        title: 'Confirm a verified-flaky CI/gate failure',
        description:
          'Reports that this session cleared the flake-verification bar (ran the failing test in isolation, re-ran the full suite, confirmed the failure is unrelated to its diff) instead of pushing an empty commit. gate is "ci" for a failing GitHub check or "f2" for the orchestrator-run test gate.',
        inputSchema: {
          gate: flakyGateSchema,
          reason: z.string(),
        },
      },
      async (args) => {
        const session = ctx.getSession();
        if (!session) return notLive();
        session.recordVerifiedFlakyDisposition({
          gate: args.gate,
          reason: args.reason,
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
          'Stages this read-only gate-verify session\'s finding for the single gate item it was dispatched to verify — pass/fail/needs-setup, plus an optional self-correction reclassify proposal (Human-Observation or needs-triage only) — as a normal gate.verify intent for an operator to dispose on the decision surface, exactly like any other staged intent. gateItemId must be the FULL gate item uuid (e.g. "3b022f91-52f3-8173-b9b2-ada4fdb54c82"), never an 8-character short form — this project\'s ids share long structured prefixes, so a truncated id is rejected at stage time rather than resolved. The operator, never the session or the backend automatically, turns this into the gate_item_event write; a rejection resumes this session for a normal turn to revise and report again, with no limit on revisions.',
        inputSchema: {
          gateItemId: z.string(),
          disposition: gateVerifyDispositionSchema,
          evidence: gateVerifyEvidenceSchema.optional(),
          reclassify: gateVerifyReclassifySchema.optional(),
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
  }
}
