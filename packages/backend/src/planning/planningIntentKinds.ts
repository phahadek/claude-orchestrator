/**
 * Single source of truth for which staged-intent kinds each planning
 * workflow (groom/design/ops/split) is allowed to stage. Consumed by
 * procedureAssembler.ts (to render the allowed kinds + examples in the
 * injected prompt) and by config.ts (to derive that workflow's
 * --allowed-tools MCP entries) — kept in its own module, rather than
 * living in procedureAssembler.ts, so config.ts can import it without a
 * config.ts → procedureAssembler.ts → config.ts import cycle (procedureAssembler.ts
 * imports getProjectById from ../config).
 */

import type { SkillId } from './procedureCore';

export type PlanningWorkflow = SkillId;

export const PLANNING_INTENT_KINDS: Record<
  PlanningWorkflow,
  readonly string[]
> = {
  groom: [
    'task.setStatus',
    'task.setProperties',
    'task.setDependsOn',
    'gate.accrete',
    'seed.stage',
    'task.create',
    'session.requestCapability',
  ],
  design: [
    'decision.pickOne',
    'task.updateBody',
    'task.setProperties',
    'task.setStatus',
    'seed.stage',
    'task.create',
    'session.requestCapability',
  ],
  ops: [
    'journal.setState',
    'task.setStatus',
    'session.requestCapability',
    'task.create',
  ],
  split: ['task.updateBody', 'task.create', 'task.setDependsOn'],
};
