import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getUnit, queryUnits } from '../../architecture/ArchUnitStore';
import type { PlanningWorkflow } from '../../planning/planningIntentKinds';

/** Per-connection context the architecture read tools are scoped to. */
export interface ArchitectureReadToolContext {
  workflow: PlanningWorkflow | null;
}

const archUnitKindSchema = z.enum([
  'subsystem',
  'invariant',
  'decision',
  'contract',
  'reference',
]);

const archUnitStatusSchema = z.enum(['active', 'deferred', 'superseded']);

/**
 * Registers `architecture.getUnit` / `architecture.queryUnits` — the read
 * surface over the arch_unit store a groom/design/ops session dereferences
 * on demand. These are the store's only body-bearing read a session
 * genuinely holds: the digest carries titles/ids (groom inlines bodies for
 * its own small region-intersected selection, see
 * `planning/procedureAssembler.ts`'s `renderGroomDigest`, but design/ops
 * selections are too large to inline wholesale). Always-on for the
 * qualifying session types — not gated behind `session.requestCapability` —
 * because architecture-unit content is the non-negotiable, always-loaded
 * input the groom/design/ops procedures require (see skills/groom/SKILL.md),
 * the same precedent as the read-only `groom.precheck` tool
 * (groomPrecheckTool.ts). Read-only: no write/apply verb is ever exposed
 * here, same boundary the stage-proposal/verdict tool surfaces already hold.
 */
export function registerArchitectureReadTools(
  server: McpServer,
  ctx: ArchitectureReadToolContext,
): void {
  if (
    ctx.workflow !== 'groom' &&
    ctx.workflow !== 'design' &&
    ctx.workflow !== 'ops'
  ) {
    return;
  }

  server.registerTool(
    'architecture.getUnit',
    {
      title: 'Fetch one architecture unit by id',
      description:
        'Read-only: returns the full arch_unit store record (including body) for the given id, or null if no unit exists with that id.',
      inputSchema: { id: z.string() },
    },
    async (args) => {
      const unit = getUnit(args.id) ?? null;
      return {
        content: [{ type: 'text', text: JSON.stringify(unit) }],
      };
    },
  );

  server.registerTool(
    'architecture.queryUnits',
    {
      title: 'Query architecture units',
      description:
        'Read-only: lists arch_unit store records (including body) matching the given filters. Defaults to the active set; pass status to widen it.',
      inputSchema: {
        topic: z.string().optional(),
        kind: archUnitKindSchema.optional(),
        region: z.string().optional(),
        status: archUnitStatusSchema.optional(),
        includeSuperseded: z.boolean().optional(),
      },
    },
    async (args) => {
      const units = queryUnits({
        topic: args.topic,
        kind: args.kind,
        region: args.region,
        status: args.status,
        includeSuperseded: args.includeSuperseded,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(units) }],
      };
    },
  );
}
