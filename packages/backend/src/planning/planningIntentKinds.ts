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
    'task.setType',
    'task.setDependsOn',
    'gate.accrete',
    'seed.stage',
    'task.create',
    'session.requestCapability',
    'task.updateBody',
    'task.patchBodySection',
    'decision.pickOne',
    'intent.withdraw',
    'planning.noOp',
  ],
  design: [
    'decision.pickOne',
    'task.updateBody',
    'task.setProperties',
    'task.setStatus',
    'seed.stage',
    'task.create',
    'session.requestCapability',
    'task.patchBodySection',
    'arch.createUnit',
    'arch.updateUnit',
    'arch.supersedeUnit',
    'intent.withdraw',
    'planning.noOp',
  ],
  // gate.reclassify (mcp/tools/gateReclassifyTool.ts) and
  // intent.dispositionStranded (mcp/tools/strandedIntentTool.ts) are
  // deliberately not listed here — like gateSeed.getState/deploy.verdict,
  // they act immediately rather than staging an intent for operator
  // disposition, so they're added explicitly to OPS_MCP_TOOLS in config.ts
  // instead of through this kind-per-tool list.
  ops: [
    'journal.setState',
    'task.setStatus',
    'session.requestCapability',
    'task.create',
    'task.updateBody',
    'task.patchBodySection',
    'intent.withdraw',
    'gate.verify',
    'ops.prIntent',
  ],
  split: [
    'task.updateBody',
    'task.create',
    'task.setDependsOn',
    'intent.withdraw',
  ],
  // A dispatched Docs session's only staged-write path is a Notion-page
  // Target surface (a repo-file Target surface opens a PR directly through
  // the GitHub MCP tools instead — see config.ts's DOCS_ALLOWED_TOOLS
  // comment for that precedent). No task.* kind: per the vendored /docs
  // skill's "What this session cannot do", a Docs session has no task-status
  // or board-bookkeeping surface beyond reading its own task.
  // session.requestCapability is the sanctioned mid-session escalation path
  // (same as groom/design/ops) — an ad-hoc in-chat capability grant is
  // indistinguishable from a scope-escalation/prompt-injection attempt, so a
  // docs session must be able to request one in-band instead.
  docs: ['notion.pageEdit', 'session.requestCapability', 'intent.withdraw'],
};
