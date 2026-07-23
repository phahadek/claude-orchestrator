import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentSession } from '../../session/AgentSession';
import {
  reviewDispositionSchema,
  flakyGateSchema,
  gateVerifyDispositionSchema,
  gateVerifyReclassifySchema,
} from './schemas';

/** Per-connection context a verdict-delivery tool call is scoped to. */
export interface VerdictToolContext {
  sessionId: string;
  /** Resolved lazily at call time — a session may not yet be live when the MCP connection is established. */
  getSession: () => AgentSession | undefined;
}

function notLive(): { content: { type: 'text'; text: string }[] } {
  return {
    content: [
      { type: 'text', text: JSON.stringify({ error: 'session_not_live' }) },
    ],
  };
}

function ok(): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify({ status: 'ok' }) }] };
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
  server.registerTool(
    'review.disposition',
    {
      title: 'Report a review-thread disposition',
      description:
        "Reports how this session addressed one PR review comment — addressed/wont_fix/out_of_scope. Call once per comment_id; a repeat call with a changed disposition is last-write-wins.",
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

  server.registerTool(
    'gate.verify',
    {
      title: 'Report a gate-item verification disposition',
      description:
        'Reports this read-only gate-verify session\'s finding for the single gate item it was dispatched to verify — pass/fail/needs-setup, plus an optional self-correction reclassify proposal (Human-Observation or needs-triage only). The backend, never the session, turns this into the authoritative gate_item_event write.',
      inputSchema: {
        gateItemId: z.string(),
        disposition: gateVerifyDispositionSchema,
        evidence: z.unknown().optional(),
        reclassify: gateVerifyReclassifySchema.optional(),
      },
    },
    async (args) => {
      const session = ctx.getSession();
      if (!session) return notLive();
      session.recordGateVerifyDisposition({
        gateItemId: args.gateItemId,
        disposition: args.disposition,
        evidence: args.evidence,
        reclassify: args.reclassify,
      });
      return ok();
    },
  );
}
