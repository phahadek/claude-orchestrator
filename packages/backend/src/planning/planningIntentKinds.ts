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
    'planning.noOp',
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

/**
 * Stage-proposal kinds a non-planning (standard/review, i.e. code) session
 * may stage — registered on its MCP connection in place of the full
 * stage-proposal vocabulary (see orchestratorMcpServer.ts's buildMcpServer
 * and stageProposalTools.ts's registerStageProposalTools). review.dispute is
 * a code session's route out of a needs_changes/incomplete PR review verdict
 * it concludes is wrong (see db/types.ts). test.request is how it runs a
 * test command blocked at the CLI permission layer. Consumed by config.ts to
 * derive ALLOWED_TOOLS's matching entries, same precedent as
 * PLANNING_INTENT_KINDS above. report.file is a dispatched code/review
 * session's route to file an inert investigation report about a defect it
 * must not fix itself — see mcp/tools/stageProposalTools.ts's report.file
 * registration and routes/stagedIntents.ts's report.file apply case.
 * planning.noOp is a code session's terminal declaration that a dispatched
 * task's work is already satisfied elsewhere (a re-dispatch of an
 * already-settled task) — see routes/stagedIntents.ts's
 * maybeAutoResolveCodeNoOp, which auto-commits it and closes the task on
 * stage rather than waiting on an operator Acknowledge the way a
 * groom/design no-op does.
 */
export const CODE_INTENT_KINDS: readonly string[] = [
  'review.dispute',
  'test.request',
  'report.file',
  'planning.noOp',
];

/**
 * Stage-proposal kinds an investigate-dispatched session (sessionType
 * 'ops', task_id `report-batch:<batchId>` — see
 * sessionPredicates.ts#isInvestigateSession) may stage. A sibling constant
 * to `PLANNING_INTENT_KINDS`, not an entry inside it: that record is keyed
 * by `SkillId`, which is `Extract<SessionType, 'groom'|'design'|'ops'|
 * 'split'|'docs'>` and structurally excludes 'investigate' (no such
 * SessionType literal exists — investigate reuses 'ops'). Deliberately
 * narrower than `PLANNING_INTENT_KINDS.ops`: no `journal.setState`
 * (investigate has no ops_journal analog), no `task.setStatus`/
 * `task.updateBody`/`task.patchBodySection` (an investigate session files
 * new Backlog tasks, it never edits an existing one — see the /investigate
 * skill's "Never edit a filed task. File a new one."), no `gate.verify`/
 * `ops.prIntent` (no gate item or PR to report against). `task.create`
 * files the grounded Backlog output; `decision.pickOne` resolves an
 * ambiguous input the skill's "resolve it before acting" rule requires;
 * `session.requestCapability` is the same mid-session escalation path every
 * planning workflow gets; `intent.withdraw` retracts a staged intent.
 * Consumed by config.ts to derive `INVESTIGATE_ALLOWED_TOOLS`'s staged-intent
 * MCP entries, same precedent as `PLANNING_INTENT_KINDS`/`CODE_INTENT_KINDS`
 * above.
 */
export const INVESTIGATE_INTENT_KINDS: readonly string[] = [
  'task.create',
  'decision.pickOne',
  'session.requestCapability',
  'intent.withdraw',
];
