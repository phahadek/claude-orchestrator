import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlanningWorkflow } from '../../planning/planningIntentKinds';
import { reclassifyGateItem } from '../../gate/gateService';
import { gateReclassifyClassificationSchema } from './schemas';

/** Per-connection context the gate-item reclassification tool call is scoped to. */
export interface GateReclassifyToolContext {
  sessionId: string;
  /** Scoped to 'ops' sessions as a whole, mirroring gate.verify (see verdictTools.ts) and OPS_MCP_TOOLS in config.ts. */
  workflow: PlanningWorkflow | null;
}

/**
 * Registers gate.reclassify — the direct-write counterpart to
 * gate-state-client.mjs's `reclassify` command (POST
 * /api/gate/items/:id/classification), reachable by an ops session over its
 * authenticated per-session MCP bearer instead of the device-authed client,
 * which a dispatched session's environment never carries (see
 * ORCHESTRATOR_DEVICE_TOKEN's absence from CliSessionRunner's child env).
 * Unlike gate.verify, this is not a staged intent an operator later disposes
 * — reclassifyGateItem() is called directly and durably, exactly as the
 * human /gate skill's own triage step already does through the REST route.
 */
export function registerGateReclassifyTool(
  server: McpServer,
  ctx: GateReclassifyToolContext,
): void {
  if (ctx.workflow !== 'ops') return;

  server.registerTool(
    'gate.reclassify',
    {
      title: 'Reclassify a gate item',
      description:
        'Moves a gate item to a resolved classification (Read-Only, Prod-Mutating, or Human-Observation) — the same triage step the /gate skill\'s human operator performs, and the same state change gate-state-client.mjs\'s reclassify command makes, but reachable directly by this session over its own authenticated MCP connection. gateItemId must be the full gate item uuid, never a truncated short form. Applies immediately; there is no operator disposition step afterward.',
      inputSchema: {
        gateItemId: z.string(),
        classification: gateReclassifyClassificationSchema,
      },
    },
    async (args) => {
      try {
        const updated = reclassifyGateItem(
          args.gateItemId,
          args.classification,
          ctx.sessionId,
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ status: 'ok', item: updated }),
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
