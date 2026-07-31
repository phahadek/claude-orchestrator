import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  listGateItemsByMilestone,
  listSeedItemsByMilestone,
} from '../../db/queries';

/** Per-connection context the gate/seed read tool is scoped to. */
export interface GateSeedReadToolContext {
  projectId: string;
}

/** State-only projection of a gate_item row — no gate_item_event/operator data. */
interface GateItemState {
  id: string;
  milestone: string;
  text: string;
  classification: string;
  state: string;
}

/** State-only projection of a seed_item row — no seed_item_event/operator data. */
interface SeedItemState {
  id: string;
  milestone: string;
  spec: string;
  state: string;
}

/**
 * Registers `gateSeed.getState` — the read-only gate_item/seed_item state
 * lookup a verify/investigation session dereferences for a milestone's
 * Manual Verification Gate / seed-item state, without the event-history or
 * `operator` data those tables carry (see gate_item_event/seed_item_event in
 * schema.ts). Those stay reachable only through the existing device-authed
 * gate/seed routes. Always-on for any session resolving to a project — same
 * Tier-A precedent as `pullRequest.getByTaskId`.
 */
export function registerGateSeedReadTools(
  server: McpServer,
  ctx: GateSeedReadToolContext,
): void {
  server.registerTool(
    'gateSeed.getState',
    {
      title: 'Fetch gate/seed item state for a milestone',
      description:
        'Read-only: returns { gateItems, seedItems } state for the given milestone — each item as { id, milestone, text/spec, classification (gate only), state }. No event history, no operator field.',
      inputSchema: { milestone: z.string() },
    },
    async (args) => {
      const gateItems: GateItemState[] = listGateItemsByMilestone(
        ctx.projectId,
        args.milestone,
      ).map((row) => ({
        id: row.id,
        milestone: row.milestone,
        text: row.text,
        classification: row.classification,
        state: row.state,
      }));
      const seedItems: SeedItemState[] = listSeedItemsByMilestone(
        ctx.projectId,
        args.milestone,
      ).map((row) => ({
        id: row.id,
        milestone: row.milestone,
        spec: row.spec,
        state: row.state,
      }));
      return {
        content: [
          { type: 'text', text: JSON.stringify({ gateItems, seedItems }) },
        ],
      };
    },
  );
}
