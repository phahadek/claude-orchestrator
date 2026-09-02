import crypto from 'crypto';
import { logger } from '../logger';
import { getProjectById } from '../config';
import { setSessionMetadata } from '../db/queries';
import type { SessionManager } from '../session/SessionManager';
import { renderOpsCapabilities } from '../planning/procedureAssembler';
import { renderHardRulesMarkdown } from '../planning/procedureCore';
import { orchestratorMcpToolName } from '../mcp/toolNaming';
import {
  getReport,
  recordBatchDispatch,
  type InvestigationReportRow,
} from './reportStore';

/**
 * The investigate injected procedure: a bespoke, non-interactive rendering
 * of the `/investigate` skill's five-stage structure (live-health snapshot →
 * reconstruct by value → root-cause under an evidence law → frame → classify
 * → file), assembled independently of procedureCore.ts's `SkillId`-keyed
 * `ORDERED_STEPS`/`CORE_PRINCIPLES` system — `SkillId` structurally excludes
 * 'investigate' (see planning/planningIntentKinds.ts's INVESTIGATE_INTENT_KINDS
 * doc comment), so there is no step/principle entry to add there. It reuses
 * `renderHardRulesMarkdown` (the shared cross-cutting rules every
 * groom/design/ops/split/docs skill also gets) and `renderOpsCapabilities`
 * (the same request-a-capability preamble a dispatched ops session gets),
 * both skill-agnostic renderers already exported from procedureCore.ts/
 * procedureAssembler.ts. The vendored `/investigate` SKILL.md is not
 * retired by this — it stays the operator-interactive canon; this is the
 * separate injected-session canon (see config/procedures.md's two-canon
 * rule) for the narrow, batched, non-interactive dispatch case only.
 *
 * Passed as `injectedProcedureContent` — never routed through
 * `OpsSessionLauncher.buildInjectedProcedure`'s generic `sessionType ===
 * 'ops'` branch, which requires an `ops_journal` `opsContext` an
 * investigate batch has no analog of (there is no ops_journal entry for a
 * `report-batch:<batchId>` task id). Mirrors
 * `gateItemVerifier.ts#buildGateVerifyProcedure`'s own bespoke, launcher-
 * independent assembly for the same reason.
 */
export function buildInvestigateProcedure(
  reports: readonly InvestigationReportRow[],
  projectId: string,
): string {
  return [
    '## Session Lifecycle',
    '',
    'This is an injected, non-interactive, one-shot investigate session ' +
      `dispatched to investigate a batch of ${reports.length} committed ` +
      'investigation report(s) and turn them into grounded `🔲 Backlog` ' +
      "task(s) — the `/investigate` skill's upstream-of-`/groom` mandate, " +
      'run headlessly. It is not auto-dispatched onto anything else. There ' +
      "is no PR to open and no filed task to edit — this session's only " +
      'write surface is staging new intents an operator reviews; it never ' +
      'ends the turn on a chat write-up describing what it plans to file.',
    '',
    '### Reports in this batch',
    '',
    ...reports.flatMap((r) => [
      `- id: ${r.id}`,
      `  - project: ${r.project_id}`,
      `  - milestone: ${r.milestone_id}`,
      `  - title: ${r.title}`,
      `  - symptom: ${r.symptom_text}`,
      ...(r.evidence_text ? [`  - evidence: ${r.evidence_text}`] : []),
      ...(r.image_path ? [`  - image: ${r.image_path}`] : []),
    ]),
    '',
    ...renderOpsCapabilities(projectId),
    renderHardRulesMarkdown(),
    '## The investigate procedure — five stages',
    '',
    'Read-only diagnosis is the default posture: observe the operational ' +
      "record, root-cause it, file. Never mutate another session's git, " +
      'worktree, or PR to learn what you can read — those two lines are ' +
      'forbidden under any grant. Escalate to a write only through ' +
      `\`${orchestratorMcpToolName('session.requestCapability')}\`, exactly ` +
      'as described in "Capabilities" above.',
    '',
    '### 1. Live-health snapshot',
    '',
    'Ground every claim in this run against what is actually deployed and ' +
      'failing right now, not the checkout HEAD and not memory. Read the ' +
      "operational record directly through this session's granted tools — " +
      'the always-on `architecture.getUnit`/`architecture.queryUnits`, ' +
      '`task.getById`, and `pullRequest.getByTaskId` reads, plus the ' +
      'capability-gated `session.getRecord`/`auditLog.query`/' +
      '`sessionEvents.query` reads once requested and granted (see ' +
      '"Capabilities"). Deployed SHA is never the checkout HEAD, and is ' +
      'never the target of the most recent deploy attempt, which may have ' +
      'failed mid-step — re-verify deployed state before framing anything ' +
      'as still-broken.',
    '',
    '### 2. Reconstruct the symptom, by value',
    '',
    "Do not take a report's `symptom_text` at face value, and do not " +
      "reason from what the code's intent looks like — reconstruct what " +
      'actually happened from the record, with provenance: a dispatched ' +
      "session's injected prompt and its `session_events` transcript, the " +
      "system's own audit trail. Every registered number, status, and " +
      'stated cause in a report is a claim to re-derive, not a fact.',
    '',
    '### 3. Root-cause under an evidence law',
    '',
    'Dig to the exact `file:line`, config row, or state that causes the ' +
      'symptom, demonstrated by value — never stop at "the source code ' +
      'looks like it does X". Match every claim\'s shape to its admissible ' +
      'evidence before stating it: a negative ("X is not wired") needs a ' +
      'scoped repo-wide search, not a single expected-file grep; "session S ' +
      "did/didn't do Y\" needs S's `session_events` transcript, never its " +
      'merged PR\'s file list alone; "X is already fixed" needs the ' +
      "mechanism's runtime input checked by value, never just its presence " +
      'at the deployed SHA. A cheap substitute that merely looks consistent ' +
      "with the hypothesis is not the admissible evidence for that claim's " +
      'shape.',
    '',
    '### 4. Frame',
    '',
    'Caused vs exposed — did a recent change cause this, or expose ' +
      'something latent? Transient vs systemic — a one-off worth a note, or ' +
      'a reproducible class worth a task? Cascade / blast-radius — what ' +
      'else assumes the thing this finding touches? Re-verify deployed ' +
      'state one more time before committing to a fix: fixes land fast, and ' +
      'the finding may have already shifted from "file a fix" to "already ' +
      'fixed; verify".',
    '',
    '### 5. Classify',
    '',
    'Decide the Type, and whether a task is the right output at all: ' +
      '`💻 Code` when the approach is clear and a headless worktree session ' +
      '(no browser, no prod access, no live dashboard) can execute it; ' +
      "`🔎 Investigation` when the finding's first step needs an " +
      'instrument this session does not have; `📐 Design` only when ' +
      'resolving the open questions mints a durable architectural decision ' +
      'or the space is genuinely open — check for an already-`✅ Done` ' +
      'design first, and fold evidence into an existing task rather than ' +
      'filing a duplicate when one already owns the finding (ownership is ' +
      'decided by the body, never the title).',
    '',
    '### File',
    '',
    'Stage each finding as its own `task.create` intent — the body carries ' +
      'Summary · Dependencies · Context (the proven mechanism, anchored to ' +
      '`file:line`) · Acceptance criteria (🤖 Automated + 👁️ Manual) · ' +
      'Files/paths affected · empty Implementation notes. Never edit an ' +
      'already-filed task from this session — file a new one and wire the ' +
      'dependency instead. If the input is genuinely ambiguous, stage a ' +
      `\`${orchestratorMcpToolName('decision.pickOne')}\` intent naming the ` +
      'options rather than acting on your own reading of it. Staging the ' +
      'intent(s) is the terminal action for this turn — end the turn once ' +
      'every finding in this batch has been staged (as a task or a ' +
      'decision), not on a chat summary of what you found. If a report ' +
      'genuinely has no actionable finding, do not stage anything for it — ' +
      'there is no staged-intent tool for "no finding"; simply end the ' +
      'turn having called no tool for that report. A clean batch that ' +
      'stages nothing at all is itself the correct, terminal outcome.',
  ].join('\n');
}

/**
 * Dispatches one investigate batch: mints a batch id, creates the session
 * with task_id `report-batch:<batchId>` (sessionType 'ops' — see
 * sessionPredicates.ts#isInvestigateSession; no dedicated SessionType
 * literal exists for investigate) with `buildInvestigateProcedure`'s
 * content injected verbatim, and records every report's
 * `investigation_report_dispatch` row. Mirrors
 * `SessionGateItemVerifier#verify`'s own bespoke-dispatch shape (never
 * `OpsSessionLauncher`) — this is the `dispatchFn` callers of
 * `reportStore.ts#dispatchReportBatchesUpTo` are expected to supply.
 *
 * The dispatch-rows write happens immediately after the session id is
 * known, batched in one transaction across every report in this call
 * (`recordBatchDispatch`, with a no-op `insertSession` thunk — the session
 * row is already durably committed by `sessionManager.start()`'s own
 * synchronous insert before this call runs, so re-inserting it here would
 * race that bookkeeping). The reportIds are also captured onto the
 * session's `metadata` column so `reportStore.ts#reconcileOrphanedDispatches`
 * can backfill the dispatch rows in the rare case a crash lands between
 * session creation and this write.
 */
export async function launchInvestigateBatch(
  sessionManager: SessionManager,
  reportIds: readonly string[],
): Promise<string> {
  if (reportIds.length === 0) {
    throw new Error('launchInvestigateBatch: reportIds must be non-empty');
  }

  const reports: InvestigationReportRow[] = [];
  for (const reportId of reportIds) {
    const report = getReport(reportId);
    if (!report) {
      throw new Error(`launchInvestigateBatch: unknown report ${reportId}`);
    }
    reports.push(report);
  }

  const batchProjectIds = new Set(reports.map((r) => r.project_id));
  if (batchProjectIds.size > 1) {
    throw new Error(
      `launchInvestigateBatch: batch spans multiple projects (${Array.from(
        batchProjectIds,
      ).join(', ')}) — a batch must resolve to a single project`,
    );
  }
  const projectId = reports[0].project_id;
  const milestoneId = reports[0].milestone_id;
  const project = getProjectById(projectId);
  if (!project) {
    throw new Error(`launchInvestigateBatch: unknown project ${projectId}`);
  }

  const batchId = crypto.randomUUID();
  const taskId = `report-batch:${batchId}`;
  const taskName =
    reports.length === 1
      ? `Investigate: ${reports[0].title}`
      : `Investigate: ${reports.length} reports`;

  const sessionId = await sessionManager.start(taskId, project.contextUrl, {
    projectId,
    taskName,
    milestoneId,
    taskKind: 'non_milestone',
    taskId,
    sessionType: 'ops',
    injectedProcedureContent: buildInvestigateProcedure(reports, projectId),
  });

  setSessionMetadata(sessionId, { reportIds: [...reportIds] });

  const dispatchedAt = new Date().toISOString();
  recordBatchDispatch(() => {}, [...reportIds], sessionId, dispatchedAt);

  logger.info(
    `[investigateDispatcher] launched batch ${batchId.slice(0, 8)} ` +
      `(${reportIds.length} report(s)) as session ${sessionId.slice(0, 8)}`,
  );

  return sessionId;
}
