import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlanningWorkflow } from '../../planning/planningIntentKinds';
import { dispositionStrandedIntent } from '../../routes/stagedIntents';

/** Per-connection context the stranded-intent disposition tool call is scoped to. */
export interface StrandedIntentToolContext {
  sessionId: string;
  /** Scoped to 'ops' sessions as a whole, mirroring gate.verify (see verdictTools.ts) and OPS_MCP_TOOLS in config.ts. */
  workflow: PlanningWorkflow | null;
}

/**
 * Registers intent.dispositionStranded — clears a single staged intent left
 * behind by a *different* session that has since terminated. Unlike
 * intent.withdraw (own-session-only, see stageProposalTools.ts), this reaches
 * another session's intent; the authorization it relies on is that the
 * owning session is terminal, never that it matches the caller — see
 * dispositionStrandedIntent's doc comment in stagedIntents.ts for why that
 * predicate cannot be a copy of intent.withdraw's. Dispositions exactly one
 * intent id per call — a caller clearing several stranded intents loops over
 * this tool itself, matching intent.withdraw's own per-item granularity
 * (a batch verb was rejected at grooming: it makes partial failure in a
 * mixed-result batch ambiguous).
 */
export function registerStrandedIntentTool(
  server: McpServer,
  ctx: StrandedIntentToolContext,
): void {
  if (ctx.workflow !== 'ops') return;

  server.registerTool(
    'intent.dispositionStranded',
    {
      title: 'Disposition a stranded staged intent',
      description:
        'Terminally dispositions (supersedes) a staged intent left behind by a different session that has since reached a terminal status (done/error/killed) — for a staged/approved/pending_verification/needs_revision intent an operator can no longer meaningfully act on because the session that would revise or explain it is gone. Refuses an intent whose owning session is still live. Call once per intent id; loop over this tool to clear more than one. Requires a substantive one-line reason, recorded on the intent for the decision surface.',
      inputSchema: {
        intentId: z.string(),
        reason: z.string(),
      },
    },
    async (args) => {
      try {
        const dispositioned = dispositionStrandedIntent(
          args.intentId,
          args.reason,
          ctx.sessionId,
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(dispositioned),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: err instanceof Error ? err.message : String(err),
              }),
            },
          ],
          isError: true as const,
        };
      }
    },
  );
}
