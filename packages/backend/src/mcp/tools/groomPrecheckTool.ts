import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { checkGroomingPromotionGate } from '../../groom/groomGate';
import type { GroomingGateEntry } from '../../groom/groomGate';
import { bindingConstraintIdsForRegions } from '../../groom/constraintCatalog';
import { checkReadiness } from '../../tasks/readinessGate';
import { getCachedType } from '../../tasks/TaskWriteCommands';
import { getTaskBackend } from '../../tasks/TaskBackend';
import type { PlanningWorkflow } from '../../planning/planningIntentKinds';
import { groomingGateEntrySchema } from './schemas';

/** Per-connection context the groom-precheck tool is scoped to. */
export interface GroomPrecheckToolContext {
  projectId: string;
  workflow: PlanningWorkflow | null;
}

/**
 * Registers `groom.precheck` — a read-only precheck that runs the exact same
 * checks a `task.setStatus` Ready flip faces at stage time
 * (`checkGroomingPromotionGate` in groomGate.ts + `checkReadiness` in
 * readinessGate.ts, the same two functions `runStageTimeReadyChecks` in
 * stagedIntents.ts calls) against a proposed `groomingGate` payload, without
 * staging anything: no staged_intent row, no accretion marker, no audit
 * event. Exists so a session can see the violations a stage attempt would
 * surface — including the binding-constraint set recomputed from whatever
 * `regions` it declares, which can differ from the digest's set once a
 * session has refined its regions during investigation — before committing
 * to a stage/reject/restage round trip. Advisory only: a session with a
 * clean payload pays no extra round trip, and this never substitutes for the
 * stage-time / commit-time checks, which remain the sole hard authority.
 */
export function registerGroomPrecheckTool(
  server: McpServer,
  ctx: GroomPrecheckToolContext,
): void {
  if (ctx.workflow !== 'groom') return;

  server.registerTool(
    'groom.precheck',
    {
      title: 'Precheck a proposed Ready-flip payload',
      description:
        'Read-only: runs the same grooming-promotion-gate and readiness-gate checks a `task.setStatus` (status: "Ready") stage attempt would face, against a proposed `groomingGate` payload for `taskId`, without staging anything. Returns the binding-constraint set recomputed from the submitted `regions`, which changes as declared regions widen. Advisory only — never a required pre-step.',
      inputSchema: {
        taskId: z.string(),
        groomingGate: groomingGateEntrySchema,
      },
    },
    async (args) => {
      const entry = (args.groomingGate ?? {}) as GroomingGateEntry;
      const authoritativeType = getCachedType(args.taskId) ?? entry.type;

      const gateResult = checkGroomingPromotionGate(
        entry,
        args.taskId,
        authoritativeType,
      );

      const backend = getTaskBackend(ctx.projectId);
      const body = (await backend.fetchTaskPage(args.taskId)) ?? '';
      const readinessViolations = checkReadiness(body, authoritativeType);

      const bindingConstraintIds = bindingConstraintIdsForRegions(
        entry.regions ?? { packages: [], files: [] },
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              allowed: gateResult.allowed && readinessViolations.length === 0,
              gateReasons: gateResult.reasons,
              readinessViolations,
              bindingConstraintIds,
            }),
          },
        ],
      };
    },
  );
}
