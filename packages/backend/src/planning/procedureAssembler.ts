/**
 * Injected planning-procedure assembler — the single composable builder
 * behind a dispatched planning session's appended-prompt file, mirroring
 * buildOrchestratorClaudeMd's single-builder-with-branches pattern (see
 * `session/orchestrator-claudemd.ts`) but for the stage-then-human-apply
 * (groom/design) / drive-to-applied (ops) execution modes instead of the
 * code-dispatch one.
 *
 * Composition (three slots, always in this order):
 *
 *   1. Skeleton (written once, shared by every workflow): session lifecycle
 *      (stage-only for groom/design, write-capable drive-to-applied for ops),
 *      the transport, and the structured output contract (staged intents +
 *      the decision-proposal annotation).
 *   2. Per-kind procedure core: `procedureCore.ts`'s principles + ordered
 *      steps for the workflow — the same canonical module the interactive
 *      SKILL.md files compose, so an injected session and an interactive one
 *      never drift on the underlying procedure.
 *   3. Per-type digest: a constrained section set drawn from that workflow's
 *      loader (groomLoad / designLoad / opsLoad) — never the full loader
 *      result. Milestone-wide or rare context (the arch store, the ops
 *      master context pages, neighbour boards) is deliberately left out —
 *      a dispatched session fetches it on demand through the loader's GET
 *      route instead of carrying it in the initial prompt.
 *
 * Delivery: the caller (the /api/planning/launch dispatch route) resolves
 * the digest via `deriveGroomDigestSlice` / `deriveDesignDigestSlice` /
 * `deriveOpsDigestSlice`, calls `assemblePlanningProcedure`, and writes the
 * result to the session's appended-prompt file (`writeSystemPromptFile` in
 * `session/SessionManager.ts`) — the same `--append-system-prompt-file`
 * delivery a code-dispatch session uses for `buildOrchestratorClaudeMd`, but
 * carrying this module's output instead. Planning sessions never receive
 * `buildOrchestratorClaudeMd` content (see `SessionManager.completeStart`'s
 * `injectedProcedureContent` branch).
 *
 * Style: every load-bearing directive rendered here follows
 * `packages/backend/src/planning/INJECTED_PROCEDURE_STYLE.md` — terse,
 * imperative DO / DO NOT bullets, IS / IS-NOT lists for load-bearing
 * definitions, and the concrete invocation (not just the grant model) for
 * anything a session must call. Read that file before editing this one.
 */

import {
  SKILL_LABELS,
  principlesFor,
  renderPrinciple,
  stepsFor,
  stepSummaryFor,
  stepTitleFor,
} from './procedureCore';
import { existsSync, readFileSync } from 'fs';
import { basename, join } from 'path';
import { getProjectById } from '../config';
import { orchestratorMcpToolName } from '../mcp/toolNaming';
import { logger } from '../logger';
import { recordEvent } from '../audit/AuditLog';
import { resolveConfigDir } from '../groom/groomLoad';
import type { GroomLoadResult } from '../groom/groomLoad';
import type { TaskRegions } from '../groom/codeWorklist';
import type { TaskDependencyCandidates } from '../orchestration/milestoneDependencyGraph';
import type { ReadinessViolation } from '../tasks/readinessGate';
import { normalizeBoardId } from '../tasks/taskId';
import type { TypeCheckResult } from '../groom/typeCheck';
import type { DesignLoadResult } from '../design/designLoad';
import type { OpsLoadResult, OpsTaskEntry } from '../ops/opsLoad';
import type { OpsJournalEntry } from '../ops/opsJournal';
import {
  PLANNING_INTENT_KINDS,
  type PlanningWorkflow,
} from './planningIntentKinds';

export type { PlanningWorkflow };

/**
 * Maps workflow → the loader that produces its digest, for reference by
 * the dispatch route (which loader to call before assembling). Kept as
 * plain data (not function references) so this module never has to import
 * three loaders' worth of Notion/DB dependencies just to describe them.
 */
export const WORKFLOW_LOADERS: Record<PlanningWorkflow, string> = {
  groom: 'groom/groomLoad.ts#loadGroomContext',
  design: 'design/designLoad.ts#loadDesignContext',
  ops: 'ops/opsLoad.ts#loadOpsContext',
  split: 'groom/groomLoad.ts#loadGroomContext',
};

// ─── per-type digest slices (Q3: a constrained section set, not the loader's
// full milestone-wide result) ───────────────────────────────────────────────

/**
 * Orientation grafted into the digest when a task's own declared scope
 * resolves empty — the milestone-wide code-worklist packages and sibling
 * target tasks' resolved regions, already computed/cached in the bundle
 * (`GroomLoadResult`), so a session with nothing of its own still gets a
 * starting point for its one bounded exploration pass instead of a bare
 * `(none)`. Empty on a fresh milestone with no other resolved regions
 * either — callers must degrade gracefully, not treat it as an error.
 */
interface GroomOrientation {
  /** Every package the milestone's target tasks collectively declare. */
  milestonePackages: string[];
  /** Other target tasks' own resolved regions, for "what does a sibling task touch" context. */
  siblingRegions: {
    taskId: string;
    title: string;
    packages: string[];
    files: string[];
  }[];
}

export interface GroomDigestSlice {
  task: {
    id: string;
    title: string;
    status: string;
    type: string;
    url: string;
  };
  sizeCheckSeed: { files: number; loc_method: 'estimated' };
  typeCheck: TypeCheckResult;
  readinessViolations: ReadinessViolation[];
  bindingConstraints: string[];
  /** Which dual-read branch `archUnits` was resolved from — see `groomLoad.ts`'s `TaskDoc.archSource`. */
  archSource: GroomLoadResult['archSource'];
  /** Region-intersected arch_unit store units (+ active invariants) once adopted, else the fixed Notion context pages. */
  archUnits: { id: string; title: string }[];
  dependencyCandidates: TaskDependencyCandidates | null;
  /** This task's declared scope, resolved into package/file regions — the code it touches. */
  regions: TaskRegions;
  /** The task's full markdown body, verbatim. */
  body: string;
  /** Milestone-wide orientation, consulted by the digest only when `regions` resolves empty. */
  orientation: GroomOrientation;
}

export interface DesignDigestSlice {
  task: {
    id: string;
    title: string;
    status: string;
    type: string;
    url: string;
  };
  markdown: string;
  openQuestions: DesignLoadResult['openQuestions'];
  archSource: DesignLoadResult['archSource'];
  archUnits: DesignLoadResult['archUnits'];
  unresolvedPageRefs: DesignLoadResult['unresolvedPageRefs'];
  /** Whether milestone-wide code-map grounding is cached — the grounding
   *  itself is rare/large context, fetched on demand rather than carried here. */
  hasCodeMapGrounding: boolean;
}

export interface OpsDigestSlice {
  task: OpsTaskEntry;
  journalEntry: OpsJournalEntry | null;
}

/**
 * A dedicated split session needs exactly the same slice a grooming session
 * does (the task's resolved regions + verbatim body) to decide the cut — see
 * `split/splitSession.ts`'s ComposeSplitInput, which is built from that same
 * information. Reuses `GroomDigestSlice`'s shape rather than re-deriving an
 * identical one. Not exported: nothing outside this module needs the name —
 * `OpsSessionLauncher` assembles a split digest via `deriveGroomDigestSlice`
 * directly and wraps it as `{ workflow: 'split', data }`.
 */
type SplitDigestSlice = GroomDigestSlice;

export type PlanningDigest =
  | { workflow: 'groom'; data: GroomDigestSlice }
  | { workflow: 'design'; data: DesignDigestSlice }
  | { workflow: 'ops'; data: OpsDigestSlice }
  | { workflow: 'split'; data: SplitDigestSlice };

const normId = normalizeBoardId;

/**
 * Thrown by `deriveGroomDigestSlice` when the dispatched task isn't in the
 * loaded worklist. Distinct from a generic Error so `OpsSessionLauncher` can
 * tell "worklist reconciliation still didn't find it" apart from any other
 * assembly failure, and surface a specific reason instead of the session
 * launching and later hitting SessionManager's generic no-procedure fail-loud.
 */
export class GroomWorklistTaskNotFoundError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly reason: string,
    milestone?: string,
  ) {
    super(
      `task ${taskId} not present in the ${milestone ? `${milestone} ` : ''}groom worklist — ${reason}`,
    );
    this.name = 'GroomWorklistTaskNotFoundError';
  }
}

/** Narrow a full `loadGroomContext` result to the one target task's validation slice. */
export function deriveGroomDigestSlice(
  result: GroomLoadResult,
  taskId: string,
  milestone?: string,
): GroomDigestSlice {
  const doc = result.targetTasks.find((t) => normId(t.id) === normId(taskId));
  if (!doc) {
    const boardRow = result.board.find((r) => normId(r.id) === normId(taskId));
    const reason = boardRow
      ? `task status is "${boardRow.status}" — excluded as Done/Deferred, not groomable`
      : 'task is not present on the milestone board — worklist may be stale or the task is on a different milestone/board';
    throw new GroomWorklistTaskNotFoundError(taskId, reason, milestone);
  }
  const dependencyCandidates =
    result.dependencyCandidates.find(
      (c) => normId(c.taskId) === normId(taskId),
    ) ?? null;
  const orientation: GroomOrientation = {
    milestonePackages: [...result.codeWorklist.keys()].sort(),
    siblingRegions: result.targetTasks
      .filter((t) => normId(t.id) !== normId(taskId))
      .filter((t) => t.regions.packages.length || t.regions.files.length)
      .map((t) => ({
        taskId: t.id,
        title: t.title,
        packages: t.regions.packages,
        files: t.regions.files,
      })),
  };
  return {
    task: {
      id: doc.id,
      title: doc.title,
      status: doc.status,
      type: doc.type,
      url: doc.url,
    },
    sizeCheckSeed: doc.sizeCheckSeed,
    typeCheck: doc.typeCheck,
    readinessViolations: doc.readinessViolations,
    bindingConstraints: doc.bindingConstraints,
    archSource: doc.archSource,
    archUnits: doc.archUnits,
    dependencyCandidates,
    regions: doc.regions,
    body: doc.rawMarkdown,
    orientation,
  };
}

/** `loadDesignContext` already resolves a single target task — just narrow the fields carried forward. */
export function deriveDesignDigestSlice(
  result: DesignLoadResult,
): DesignDigestSlice {
  return {
    task: result.task,
    markdown: result.markdown,
    openQuestions: result.openQuestions,
    archSource: result.archSource,
    archUnits: result.archUnits,
    unresolvedPageRefs: result.unresolvedPageRefs,
    hasCodeMapGrounding: Object.keys(result.codeMapGrounding).length > 0,
  };
}

/** Narrow a full `loadOpsContext` result to the one target task's journal slice. */
export function deriveOpsDigestSlice(
  result: OpsLoadResult,
  taskId: string,
  journalEntry: OpsJournalEntry | null,
): OpsDigestSlice {
  const allTasks = [
    ...result.worklist.executable,
    ...result.worklist.dep_blocked,
    ...result.worklist.needs_grooming,
    ...result.worklist.closed_not_done,
  ];
  const task = allTasks.find((t) => normId(t.id) === normId(taskId));
  if (!task) {
    throw new Error(
      `procedureAssembler: task ${taskId} not found in ops worklist`,
    );
  }
  return { task, journalEntry };
}

// ─── skeleton (written once) ───────────────────────────────────────────────

/**
 * One concrete example payload per known intent kind — placeholders
 * (`<task-id>`, `<milestone-id>`, ...) stand in for real values. Rendered
 * next to each allowed kind in the Transport section so a dispatched
 * session has the exact tool-call shape in hand instead of grepping
 * `KNOWN_INTENT_KINDS` / `staged-intents-client.mjs` usage comments to
 * reconstruct a payload shape by trial and error.
 */
const INTENT_KIND_EXAMPLE_PAYLOADS: Record<string, string> = {
  'task.setStatus': '{"taskId":"<task-id>","status":"Ready"}',
  'task.setProperties': '{"taskId":"<task-id>","properties":{"priority":"P1"}}',
  'task.setDependsOn': '{"taskId":"<task-id>","dependsOn":["<other-task-id>"]}',
  'gate.accrete':
    '{"project":"<project-id>","taskId":"<task-id>","title":"<title>",' +
    '"milestone":"<milestone-id>","classification":"Read-Only",' +
    '"items":[{"text":"<gate item text>"}]}',
  'seed.stage':
    '{"project":"<project-id>","taskId":"<task-id>","title":"<title>",' +
    '"milestone":"<milestone-id>","decision":"seeds",' +
    '"seeds":[{"spec":"<config-seed spec>"}]}',
  'task.create':
    '{"title":"<title>","type":"💻 Code","milestone":"<milestone-id>",' +
    '"body":"<task body markdown>"}',
  'task.updateBody': '{"taskId":"<task-id>","body":"<full markdown>"}',
  'task.patchBodySection':
    '{"taskId":"<task-id>","section":"<section heading text>",' +
    '"operation":"remove"}',
  'arch.updateUnit':
    '{"unitId":"<arch-unit-id>","baseVersion":<current-version-number>,' +
    '"title":"<updated title>","body":"<updated markdown body>"}',
  'decision.pickOne':
    '{"prompt":"<the Open Question, verbatim>","options":[' +
    '{"label":"<candidate answer A>","description":"<pros/cons>"},' +
    '{"label":"<candidate answer B>","description":"<pros/cons>"}],' +
    '"allowFreeForm":true}',
  'journal.setState':
    '{"taskId":"<task-id>","state":"staged-proposal",' +
    '"fields":{"findingOrProposal":"<finding or proposal>"}}',
  'session.requestCapability':
    '{"capability":"<one Bash command prefix, one named MCP write verb, or ' +
    "read:session-record:<target-session-id> for the orchestrator's own " +
    'session_events/audit_log>","plan":"<what this session will do with it>",' +
    '"evidence":"<why this session needs it>"}',
  'intent.withdraw':
    '{"intentId":"<staged-intent-id this session staged>",' +
    '"reason":"<one-line reason this intent should not be applied>"}',
};

/** Render one `mcp__orchestrator__<kind>` (CLI-sanitized) tool-call example per allowed kind. */
function renderIntentKindInvocations(kinds: readonly string[]): string[] {
  return kinds.map((kind) => {
    const toolName = orchestratorMcpToolName(kind);
    const payload = INTENT_KIND_EXAMPLE_PAYLOADS[kind];
    return payload
      ? `- \`${toolName}\` with \`{"payload": ${payload}}\``
      : `- \`${toolName}\` with \`{"payload": <json-payload>}\``;
  });
}

/**
 * Up-front capability inventory for a dispatched ops session — what it can do
 * out of the box, how it earns more, and what no grant can ever unlock. Stated
 * before the session does anything, so it stops probing tools by trial-and-
 * error and hitting denials. Mirrors the real allowlist wiring in
 * `session/orchestrator-config.ts` (`OPS_ALLOWED_TOOLS`, `getSessionAllowedTools`)
 * and the grant mechanism in `routes/stagedIntents.ts` (`session.requestCapability`
 * → `SessionManager.grantCapability`) and `GRANT_DENYLIST_PATTERNS` — kept in
 * prose here rather than imported, since this composer has no business
 * depending on the Express/DB wiring those modules pull in.
 *
 * Exported so the gate-verify dispatch path (`gate/gateItemVerifier.ts`),
 * which builds its own injected context outside this assembler, can compose
 * the same ask-permission guidance instead of restating it — a dispatched
 * gate-verify session is an `ops`-typed session and gets the same base
 * profile and the same `session.requestCapability` path.
 */
export function renderOpsCapabilities(): string[] {
  return [
    '## Capabilities',
    '',
    'This session starts with a fixed base tool set and nothing more: read-only ' +
      'Bash (ls, cat, grep, find, git log/diff/show/status/blame/ls-files/rev-parse, ' +
      "etc.), read-only Notion MCP tools, and this project's audited live-data read " +
      'surface (analyst/alarm/read-only-DB MCP tools, where configured). No write, no ' +
      'Write/Edit tool, and no prod-mutating command is granted by default — do not ' +
      'probe for one.',
    '',
    'DO stage a `session.requestCapability` intent naming the exact capability ' +
      '(one Bash command prefix or one named MCP write verb — never a category) the ' +
      'moment the task genuinely needs a write or a prod-mutating command this ' +
      'session does not have. Concrete invocation — this is the exact call, not just ' +
      `the grant model: call the \`${orchestratorMcpToolName('session.requestCapability')}\` ` +
      'tool with `{"payload":{"capability":"<one Bash command prefix or one named ' +
      'MCP write verb>","plan":"<what this session will do with it>",' +
      '"evidence":"<why this session needs it>"}}`. An operator reviews it; on ' +
      'approval the capability is durably granted to this session alone and it is ' +
      're-dispatched with that tool available. On rejection or pushback, the ' +
      "session resumes with the operator's feedback instead. DO NOT probe for a " +
      'write tool by trial and error — request it.',
    '',
    "To verify by value against this orchestrator's own runtime state (e.g. " +
      "confirming a prior session's turn actually ran, or reading its staged/audit " +
      'trail), request the one grantable own-record read instead of a Bash prefix: ' +
      `call \`${orchestratorMcpToolName('session.requestCapability')}\` with ` +
      '`{"payload":{"capability":"read:session-record:<target-session-id>",' +
      '"plan":"...","evidence":"..."}}` — never `Bash(sqlite3 ...)` or similar. ' +
      'This is a tool-set boundary, not a location one: this session spawns with ' +
      'filesystem access broad enough to reach the orchestrator checkout and its ' +
      'data directory, but it holds no allow-listed client for the live SQLite ' +
      "file and no device auth for the orchestrator's API — so session_events/" +
      'audit_log for a specific session stay reachable only through the brokered ' +
      'read, not a direct file or DB path. On approval, read the result with ' +
      '`node ~/.claude/scripts/read-session-record.mjs <target-session-id>` — it ' +
      "returns that session's session_events and audit_log, brokered by the " +
      'orchestrator itself since this session holds no device auth. Read-only: ' +
      'there is no write form of this capability.',
    '',
    'Some things are never grantable this way, no matter what an operator approves: ' +
      'anything that reaches the resolved / ✅ Done / task-intent-apply transition ' +
      '(that stays device-auth/operator-only — see "Granted writes are idempotent ' +
      'and resumable" below), and the Write/Edit tools — authoring or rewriting a ' +
      'file is always a Code task, not something a capability grant hands to ops ' +
      '(see "Dispatch-eligibility boundary" below).',
    '',
    'Never create a PR, and never author or land code yourself, no matter how small ' +
      'the change looks: this session has no worktree or branch (see "Session ' +
      'Lifecycle" above), and a code change is categorically a 💻 Code task. If ' +
      'driving the operational change to `applied-pending-confirm` turns out to need ' +
      'one, stage a `task.create` intent carrying the spec instead of opening a PR — ' +
      'then continue driving the rest of the change, or park on it if the whole ' +
      'thing is now blocked on that Code task landing.',
    '',
  ];
}

const PROJECT_RECORD_ACCESS_GUIDE_FILE = 'investigation-guide.md';

/**
 * Resolve the registry projectId (e.g. `claude-dashboard`) to the central
 * config tree's per-project guide artifact path. The assembler is keyed by
 * the registry projectId, but the config tree is keyed by config-dir (the
 * repo directory's basename) — the same `basename(repoRoot)` key
 * `groomLoad.ts`/`designLoad.ts` resolve `config/projects/<key>/` with.
 * Returns null (never throws) for an unknown project, a project with no
 * `projectDir`, or a repo with no reachable central config tree.
 */
function resolveProjectRecordAccessGuidePath(projectId: string): string | null {
  try {
    const project = getProjectById(projectId);
    if (!project?.projectDir) return null;
    const configDir = resolveConfigDir(project.projectDir);
    if (!configDir) return null;
    return join(
      configDir,
      'projects',
      basename(project.projectDir),
      PROJECT_RECORD_ACCESS_GUIDE_FILE,
    );
  } catch {
    return null;
  }
}

/**
 * Render this project's operational-record-access guide: a per-project
 * artifact authored in the central config tree that tells a dispatched
 * session what THIS project's operational record is (its audit surface,
 * live-data MCP tools, dashboards, etc.) and how to reach it from inside
 * its sandbox. This supplies the project-specific surface + access method
 * only — the generic grant-request mechanics (`renderOpsCapabilities`,
 * e.g. `session.requestCapability` / `read:session-record:*`) stay as-is
 * and this section should reference them rather than restate them.
 *
 * Rendered only for investigation-bearing session kinds — `ops` (including
 * gate-verify, which dispatches as an `ops`-typed session, see
 * `gate/gateItemVerifier.ts`) and `design`. Never for `groom`.
 *
 * Guidance, not enforcement: the guide is prose read from the config tree.
 * It never changes which read tools/MCP servers/capabilities this session
 * actually holds — that stays orchestrator-owned (`OrchestratorConfig`'s
 * `mcp_servers`/`allowed_tools` plus the grant system).
 *
 * A project with no guide artifact (or an unresolvable config tree/project)
 * renders no section at all — the caller's existing `renderOpsCapabilities`
 * fallback (generic own-record `read:session-record` mechanics) still
 * applies. Never throws.
 *
 * A resolvable path with no file at it is otherwise silent — the fallback
 * above is indistinguishable from "this project legitimately has no guide".
 * To make that visible, this logs a warning and records a
 * `project_record_access_guide_missing` audit event naming the project and
 * the resolved path it looked for. This is a signal only: the fallback
 * itself (returning `[]`, never throwing) is unchanged.
 */
export function renderProjectRecordAccess(
  workflow: PlanningWorkflow,
  projectId: string,
): string[] {
  if (workflow !== 'ops' && workflow !== 'design') return [];
  const guidePath = resolveProjectRecordAccessGuidePath(projectId);
  if (!guidePath) return [];
  if (!existsSync(guidePath)) {
    reportMissingProjectRecordAccessGuide(workflow, projectId, guidePath);
    return [];
  }
  let guide: string;
  try {
    guide = readFileSync(guidePath, 'utf8').trim();
  } catch {
    return [];
  }
  if (!guide) return [];
  return ["## This Project's Operational Record", '', guide, ''];
}

function reportMissingProjectRecordAccessGuide(
  workflow: PlanningWorkflow,
  projectId: string,
  resolvedPath: string,
): void {
  logger.warn(
    `[procedureAssembler] no operational-record-access guide found for ` +
      `project=${projectId} workflow=${workflow} at ${resolvedPath} — ` +
      'this project is indistinguishable from one with no guide; author ' +
      `${PROJECT_RECORD_ACCESS_GUIDE_FILE} for it if one is needed`,
  );
  try {
    recordEvent({
      event_type: 'project_record_access_guide_missing',
      actor_type: 'system',
      project_id: projectId,
      payload: { workflow, resolvedPath },
    });
  } catch (err) {
    logger.warn(
      `[procedureAssembler] failed to record project_record_access_guide_missing: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function renderSkeleton(
  workflow: PlanningWorkflow,
  taskName: string,
  taskUrl: string,
  milestoneId: string,
  projectId: string,
): string {
  const label = SKILL_LABELS[workflow];
  const kinds = PLANNING_INTENT_KINDS[workflow];
  const lifecycle =
    workflow === 'ops'
      ? `This is an injected, non-interactive ${label} session for a single target task ` +
        `(${taskName} — ${taskUrl}). There is no worktree and no feature branch, and this ` +
        'session never creates a PR — the worktree-branch-PR invariant holds for ops too ' +
        '(see "Capabilities" below for what a code change routes through instead). Unlike ' +
        'groom/design, this session is write-capable, earning capabilities on request, and ' +
        'its job is to drive the operational change itself to completion, not to stage a ' +
        'proposal and hand execution back. The terminal state is the ops_journal ' +
        'reaching `applied-pending-confirm` — the change actually applied, reconciled, and ' +
        'its evidence captured — not a staged proposal parked for someone else to execute. ' +
        'End the turn only when genuinely blocked on an operator decision (a pending ' +
        'capability request, or a step only a human can perform, like secret provisioning) ' +
        '— never at a "proposal staged" point when there is more of the change left to ' +
        'drive; the only operator/device-auth-only step is the final ' +
        '`applied-pending-confirm` → `resolved` confirmation, not anything before it.'
      : `This is an injected, non-interactive ${label} session for a single target task ` +
        `(${taskName} — ${taskUrl}). There is no worktree and no feature branch — this ` +
        'session runs read-only/stage-only against the project checkout. When the ' +
        'procedure below reaches a natural stopping point (every open item presented ' +
        'and either staged or explicitly deferred), end the turn instead of waiting — ' +
        'the session parks into idle rather than scraping for a PR.';
  return [
    '## Session Lifecycle',
    '',
    lifecycle,
    '',
    ...renderProjectRecordAccess(workflow, projectId),
    ...(workflow === 'ops' ? renderOpsCapabilities() : []),
    '## Transport',
    '',
    'Do not call the task backend, Notion, or any raw HTTP client directly. Every ' +
      'write is a staged intent submitted by calling the matching tool on the ' +
      "`orchestrator` MCP server injected into this session's MCP config, each " +
      `tool named \`mcp__orchestrator__<kind>\` (e.g. \`${orchestratorMcpToolName('task.create')}\`), ` +
      "authenticated transparently by this session's scoped stage credential — " +
      'never presented or re-derived by hand. Every tool only ever stages — ' +
      'applying a staged intent is a separate human/device-authenticated action ' +
      'this session cannot reach.',
    '',
    `- Milestone: \`${milestoneId}\``,
    `- Project: \`${projectId}\``,
    '- Credential: the scoped stage-only token in the `ORCHESTRATOR_STAGE_TOKEN` ' +
      'env var authenticates the MCP connection itself (already wired into this ' +
      "session's MCP config at spawn — never printed, never re-derived); this is " +
      'the only credential this session holds.',
    `- Allowed intent kinds for this session: ${kinds.join(', ')}. Only the ` +
      'matching `mcp__orchestrator__<kind>` tools for this list are present on ' +
      "this session's MCP connection — any other kind's tool is not resolvable, " +
      'so do not grep `KNOWN_INTENT_KINDS` looking for one.',
    '- Tool call, one example per allowed kind:',
    ...renderIntentKindInvocations(kinds),
    '',
    '## Structured Output Contract',
    '',
    `Stage findings as one of: ${kinds.join(', ')}. Every staged intent that ` +
      'proposes resolving an explicit open question, decision, or gate item must ' +
      'carry a `decisionProposal` annotation — a short human-readable string naming ' +
      'the question it resolves and the recommended answer — so the reviewing human ' +
      'sees the proposal instead of a bare payload diff. Batch multiple independent ' +
      'findings under a shared `groupId` when they were derived together; never ' +
      "silently apply — staging is the full extent of this session's authority." +
      (workflow === 'groom'
        ? ' Promoting to Ready is not the only outcome available. `Deferred` and ' +
          '`Backlog` are NOT interchangeable "not now" outcomes — they differ in ' +
          'what happens next, and picking the wrong one is a real failure mode:\n' +
          "- `Deferred` IS: this task's scope is fully covered by another task, or " +
          'it should not be done at all — propose a discard/defer by staging ' +
          '`task.setStatus` → `Deferred`, with a `decisionProposal` naming the ' +
          'superseding task or why the work should never happen. This is a first-class alternative outcome, ' +
          'not a fallback for a session that got stuck. It is terminal: future ' +
          'grooming passes skip a Deferred task entirely, and a Deferred task in ' +
          "another task's Depends On blocks that task forever — only Done " +
          'satisfies a dependency.\n' +
          '- `Deferred` IS NOT the disposition for a task whose premise needs ' +
          're-investigation or whose body needs rewriting before it can be groomed. ' +
          'Leave the task at `Backlog` instead (optionally with a `decisionProposal` ' +
          'explaining what is blocking it): it stays in the grooming queue and ' +
          'future passes will reconsider it.\n' +
          '- A Depends On dependency is NOT, by itself, grounds for `Backlog` or ' +
          '`Deferred` — readiness (is the spec settled) and dispatch (when the work ' +
          'runs) are different gates, and the Depends On edge already queues the ' +
          'task behind its blocker for free. The one exception: a non-Done ' +
          '📐 Design or 📋 Planning Depends On task IS grounds for `Backlog`, ' +
          "because its outcome can still reshape this task's own scope — leave the " +
          'task at `Backlog` with a `decisionProposal` naming the blocking design/' +
          'planning task, same as the premise/body cases above. A non-Done ' +
          'dependency of any other type (most commonly 💻 Code) changes only when ' +
          'the work runs, never what it says: groom the task normally and stage ' +
          '`task.setStatus` → `Ready` if it clears the readiness bar on its own ' +
          'merits. Being blocked on a Code dependency is not a readiness defect.\n' +
          '- Never stage `task.setStatus` to the status the task already holds — a ' +
          "no-op write gives the operator nothing to disposition. When a pass's " +
          'conclusion is "stay at `Backlog`" and the task is already `Backlog`, ' +
          'report the conclusion (and what it is blocked on, if anything) in chat ' +
          'and end the turn instead of staging anything.\n\n' +
          'A `task.setStatus` → `Ready` proposal is structured, not free prose: carry ' +
          "the `/groom` skill's defined proposal format (`skills/groom/reference/" +
          'presentation.md` § "The 4-point summary") as a `groomProposal` object — ' +
          '`{achieves, openQuestions, automatedTests, manualVerification, ' +
          'operationalSeed}`, every field a string (write `"None."` for a genuinely ' +
          'clean field, never omit it) — instead of packing the same judgment into a ' +
          'single `decisionProposal` paragraph. This is the same contract the ' +
          'interactive `/groom` skill presents for human sign-off; a dispatched ' +
          'session emits it as data so the reviewing human sees fields, not a prose ' +
          'summary to re-parse. Pass it as the `groomProposal` field alongside ' +
          `\`payload\`: call the \`${orchestratorMcpToolName('task.setStatus')}\` tool with ` +
          '`{"payload":{"taskId":"<task-id>","status":"Ready"},"groupId":"<groupId>",' +
          '"groomProposal":{"achieves":"...","openQuestions":"None.",' +
          '"automatedTests":"...","manualVerification":"None.",' +
          '"operationalSeed":"None."}}` ' +
          '(`decisionProposal` is omitted here — `groomProposal` ' +
          'replaces it for this kind; `decisionProposal` still applies to a ' +
          '`Deferred` proposal, which has no achieves/tests to report).\n\n' +
          'A `task.setStatus` → `Ready` proposal also carries a `groomingGate` object ' +
          'on the same payload, alongside `taskId`/`status` — every field below is ' +
          'required (checkGroomingPromotionGate in `groomGate.ts` blocks the Ready ' +
          'flip at commit time on anything missing, and the block is surfaced back to ' +
          'you at stage time, not silently dropped): `size_check` ' +
          '(`{"decision": "no_split"|"split_now"|"unsplittable"|"n/a"}` — Code/Tooling ' +
          'tasks default to "no_split" under the 500-LoC-estimated threshold, "n/a" is ' +
          'for Design/Planning types only), `type_check` (`{"decision": "none"|' +
          '"flagged"|"n/a"}`, plus `signals` naming the matched phrases when ' +
          '"flagged"), `type` (the task\'s display-format Type, e.g. `"💻 Code"`), ' +
          '`regions` (`{"packages": [...], "files": [...]}` — this task\'s resolved ' +
          "code regions, the same shape as the digest's Code regions section), " +
          '`constraintsDispositioned` (a map of binding-constraint id → ' +
          '`{"disposition": "complies"}` | `{"disposition": "n/a", "why": "..."}` | ' +
          '`{"disposition": "conflict_route", "routedTaskId": "<design-task-id>"}` — ' +
          "one entry per id in the digest's Binding constraints list), " +
          '`filesPathsEntries` (one `{"raw": "<list item text>", "isNew": false, ' +
          '"existsInRepo": true}` per `## Files / paths affected` line — `isNew: ' +
          'true` for a `*(new)*`-marked not-yet-created path), and `dependsOnTasks` ' +
          '(one `{"id": "<task-id>", "type": "<type>", "status": "<status>"}` per ' +
          'declared Depends On edge — `[]` when there are none). A worked, ' +
          'field-complete example for a 💻 Code task with one binding constraint, ' +
          'one Files/paths entry, and no dependencies: call the ' +
          `\`${orchestratorMcpToolName('task.setStatus')}\` tool with \`{"payload":` +
          '{"taskId":"<task-id>","status":"Ready","groomingGate":{' +
          '"size_check":{"decision":"no_split"},' +
          '"type_check":{"decision":"none"},' +
          '"type":"💻 Code",' +
          '"regions":{"packages":["packages/backend"],"files":["packages/backend/src/foo.ts"]},' +
          '"constraintsDispositioned":{"constraint-a":{"disposition":"complies"}},' +
          '"filesPathsEntries":[{"raw":"packages/backend/src/foo.ts","isNew":false,"existsInRepo":true}],' +
          '"dependsOnTasks":[]}}}` — omitting any one of these six `groomingGate` ' +
          'fields (even as an empty array/object where genuinely empty) is what ' +
          'blocks the Ready flip; fill every field from the digest above rather ' +
          'than carrying only `type`.\n\n' +
          'When the pre-groom body carries a "### 👁️ Manual verification" ' +
          'section, its accreted/relocated content is stripped from the body as ' +
          'a `task.patchBodySection` (`operation: "remove"`) — never a ' +
          '`task.updateBody` full-body replace — staged under the SAME ' +
          '`groupId` as this `task.setStatus`, so the strip commits atomically ' +
          'with the rest of the grooming decision instead of landing as a ' +
          'standalone, ungrouped write the operator dispositions on its own. A ' +
          'worked example: call the ' +
          `\`${orchestratorMcpToolName('task.patchBodySection')}\` tool with ` +
          '`{"payload":{"taskId":"<task-id>","section":"👁️ Manual verification",' +
          '"operation":"remove"},"groupId":"<groupId>"}` — the same `groupId` ' +
          'value passed to `task.setStatus` / `task.setDependsOn` / ' +
          '`gate.accrete` / `seed.stage` above. When the pre-groom body carries ' +
          'no such section, stage no strip intent at all — there is nothing to ' +
          'remove.\n\n' +
          'A finding that turns on an operator judgment this session cannot ' +
          "make on its own authority — the task's scope is wrong, a " +
          'dependency cannot be confirmed, the spec contradicts the code — ' +
          'is raised as its own `decision.pickOne` question-intent, never ' +
          'smuggled through a `task.setStatus` staged to the status the task ' +
          'already holds: `task.setStatus` is staged only when the status is ' +
          'actually changing. A worked example: call the ' +
          `\`${orchestratorMcpToolName('decision.pickOne')}\` tool with ` +
          '`{"payload":{"prompt":"The task\'s Scope section only covers X and ' +
          'Y, but the code also has a live Z path — widen scope, file a ' +
          'sibling task for Z, or proceed as specified?","options":[' +
          '{"label":"Widen scope","description":"..."},' +
          '{"label":"File a sibling task for Z","description":"..."},' +
          '{"label":"Proceed as specified","description":"..."}],' +
          '"allowFreeForm":true},"decisionProposal":"<the finding and its ' +
          'evidence>"}` — the task stays at its current status (typically ' +
          '`Backlog`) while the question is outstanding; no `task.setStatus` ' +
          'accompanies it. This is not a punt channel: a readiness judgment ' +
          'this session is equipped to resolve is still resolved now (see ' +
          '"Investigate before resolving" above) — `decision.pickOne` is only ' +
          "for a decision genuinely outside a groomer's authority, changing " +
          'what the task is. A scope gap is not automatically a body edit ' +
          'either: ask via `decision.pickOne` first when the resolution is ' +
          "the operator's to make, and patch the body only once the answer " +
          'is known.'
        : '') +
      (workflow === 'ops'
        ? ' Stage the next step, then keep driving: once investigation reaches a ' +
          'decision, stage it (a `journal.setState` transition, or a ' +
          '`session.requestCapability` naming the exact write you need) — never ask ' +
          'in chat whether to stage or request first. On a capability grant or an ' +
          'approved staged-proposal, apply the write, reconcile + capture, and ' +
          'advance the ops_journal again; keep looping until it reaches ' +
          '`applied-pending-confirm` or you are genuinely blocked on the next ' +
          'operator decision. Staging/requesting is what puts each decision in ' +
          'front of the operator; asking first inverts the flow and leaves them ' +
          'with nothing to act on.'
        : '') +
      (workflow === 'design'
        ? ' An Open Question’s `decision.pickOne` follows that same field mapping: ' +
          '`prompt` is the question alone, `options` has one entry per candidate ' +
          'solution considered — including one recommended against — each ' +
          '`description` self-contained and architecture-level (no other option’s ' +
          'rationale inside it), and `decisionProposal` names the pick plus carries ' +
          'the investigation summary (the evidence, since the payload has no ' +
          'separate Investigation field). A worked example for a two-candidate ' +
          `question: call the \`${orchestratorMcpToolName('decision.pickOne')}\` tool with ` +
          '`{"payload":{"prompt":"Should the retry queue be per-worker or shared?",' +
          '"options":[{"label":"Per-worker queue","description":"Each worker owns its ' +
          'own retry queue, so a stuck worker never blocks another worker’s throughput; ' +
          'trade-off: no global retry ordering."},{"label":"Shared queue","description":' +
          '"One retry queue serves every worker, preserving a single global retry order; ' +
          'trade-off: one slow worker starves the others’ retries."}],' +
          '"allowFreeForm":true},"decisionProposal":"Per-worker queue: worker.ts:140 ' +
          "already partitions state per-worker, and the arch page 'Retry Semantics' " +
          'says throughput isolation outweighs global ordering for this queue."}` — ' +
          "note the rejected 'Shared queue' candidate gets its own option, never a " +
          "clause folded into 'Per-worker queue'’s description.\n\n" +
          'The `task.updateBody` intent (Implementation notes) is staged exactly ' +
          'once, the last of the decision-recording steps, after every Open ' +
          'Question is locked and the completeness critic has run, and it carries ' +
          'the exact five-part closing synthesis as its `decisionProposal` — the ' +
          'operator approves that synthesis; the body write is its consequence, ' +
          'never a separate diff to validate. Staging it is not the end of the ' +
          'design pass: the architecture-page updates and follow-on Code tasks a ' +
          'locked design implies are two more required deliverables of the same ' +
          'pass (see below), reported — not just promised — in this synthesis. ' +
          'All five parts are required every time:\n' +
          '1. **Decision summary** — one paragraph stating what was decided and why.\n' +
          '2. **Open questions resolved** — a table, one row per listed Open ' +
          'Question (include only if there are ≥2 questions):\n\n' +
          '   | Question          | Locked answer   |\n' +
          '   | ----------------- | --------------- |\n' +
          '   | <1-line question> | <1-line answer> |\n\n' +
          '3. **Completeness-critic dispositions** — every gap the pass raised, ' +
          'its disposition, and the run date; "none — pass run, no gaps" when ' +
          'clean.\n' +
          '4. **Architecture pages updated** — each architecture unit and the ' +
          'section changed, staged as `arch.createUnit`/`arch.updateUnit`/' +
          '`arch.supersedeUnit` intents in this same pass (or "none — these ' +
          'decisions change no architecture page" when genuinely nothing ' +
          'applies).\n' +
          '5. **Follow-on Code tasks filed** — each staged as a `task.create` ' +
          'intent in this same pass, with Type and one-line scope (or "none — no ' +
          'implementation work beyond the locked decisions" when nothing further ' +
          'is implied).\n\n' +
          'Every completeness-critic gap and its proposed disposition (from the ' +
          `\`${orchestratorMcpToolName('completeness.disposition')}\` store, written ` +
          '`approvalStatus: "proposed"` at critic time) must appear in part 3 for ' +
          'operator sign-off — the store call records it durably so nothing is ' +
          'silently dropped, but recorded is not approved, and presenting it here ' +
          'is what asks for that approval. Parts 4 and 5 are never reported as ' +
          '"pending" or "see next messages" — the architecture-unit and ' +
          '`task.create` intents they describe are staged before or alongside ' +
          'this write, in the same pass, or the "none" disposition applies. A ' +
          'worked example (a pass that touches no architecture page and spawns no ' +
          'follow-on task): call the ' +
          `\`${orchestratorMcpToolName('task.updateBody')}\` tool with ` +
          '`{"payload":{"taskId":"<task-id>","body":"<full markdown with the ' +
          'Implementation notes section updated>"},"decisionProposal":"1. ' +
          'Decision summary: ...\\n\\n2. Open questions resolved: |Question|Locked ' +
          'answer|\\n|-|-|\\n|...|...|\\n\\n3. Completeness-critic dispositions: ' +
          'none — pass run, no gaps.\\n\\n4. Architecture pages updated: none — ' +
          'these decisions change no architecture page.\\n\\n5. Follow-on Code ' +
          'tasks filed: none — no implementation work beyond the locked ' +
          'decisions."}` — never omit a part, and never fold the decision summary ' +
          'straight into the write without the other four.'
        : '') +
      (workflow === 'split'
        ? ' A split decision stages exactly the `composeSplitIntents` shape under ' +
          'one shared `groupId`: one `task.updateBody` narrowing the original task ' +
          'to the ONE subset it keeps (its id is never changed — never archive or ' +
          'defer it), one `task.create` per sibling subset (the N-1 subsets the ' +
          'original does not keep, landing at 🔲 Backlog), and a `task.setDependsOn` ' +
          'for any sibling that hard-blocks on another sibling or on the original. ' +
          'Reference a not-yet-created sibling by its local ref as `$ref:<ref>` in ' +
          "a `dependsOn` array; it resolves to that sibling's real task id once its " +
          '`task.create` is applied. Every sibling (and the narrowed original) must ' +
          'be independently gradeable against its own acceptance criteria — never ' +
          'stage a cut that leaves an ambiguous or incomplete subset on either side.'
        : ''),
  ].join('\n');
}

// ─── per-kind procedure core ────────────────────────────────────────────────

function renderProcedureCore(workflow: PlanningWorkflow): string {
  const label = SKILL_LABELS[workflow];
  const lines: string[] = [`## ${label} Procedure`, ''];
  for (const step of stepsFor(workflow, { dispatched: true })) {
    lines.push(
      `### ${stepTitleFor(step, 'dispatched')}`,
      '',
      stepSummaryFor(step, workflow),
      '',
    );
  }
  lines.push('### Hard rules', '');
  for (const principle of principlesFor(workflow, { dispatched: true })) {
    lines.push(
      `- **${principle.title}**: ${renderPrinciple(principle, workflow)}`,
    );
  }
  return lines.join('\n').replace(/\n+$/, '');
}

// ─── per-type digest ────────────────────────────────────────────────────────

/** Renders the bounded-exploration directive that replaces a bare `(none)` when regions resolve fully empty. */
function renderExplorationDirective(orientation: GroomOrientation): string[] {
  const lines: string[] = [
    '- Code regions: (none resolved — this task declares no path that matched a tracked file)',
    '',
    '### No resolvable code regions — bounded exploration required',
    '',
  ];
  if (
    orientation.milestonePackages.length ||
    orientation.siblingRegions.length
  ) {
    lines.push(
      'No paths declared on this task resolved to tracked files. Below is milestone-wide ' +
        "orientation (not this task's own scope) to seed your search for the actual reference code:",
      '',
      `- Milestone packages touched by other tasks: ${orientation.milestonePackages.length ? orientation.milestonePackages.join(', ') : '(none)'}`,
    );
    if (orientation.siblingRegions.length) {
      lines.push('- Sibling task regions:');
      for (const s of orientation.siblingRegions) {
        lines.push(
          `  - ${s.title} (${s.taskId}): packages: ${s.packages.length ? s.packages.join(', ') : '(none)'}; files: ${s.files.length ? s.files.join(', ') : '(none)'}`,
        );
      }
    }
  } else {
    lines.push(
      'No paths declared on this task resolved to tracked files, and no milestone-wide ' +
        'orientation is available either (this looks like a fresh milestone with no other ' +
        'resolved regions yet).',
    );
  }
  lines.push(
    '',
    'Directive: run one bounded exploration pass (e.g. an Explore agent, or targeted Grep/Read) ' +
      'to bind the reference code this task actually touches, using the orientation above as a ' +
      'starting point. If that pass finds nothing, proceed anyway and note the gap in your ' +
      'findings — do not loop on further exploration.',
  );
  return lines;
}

function renderGroomDigest(
  data: GroomDigestSlice,
  heading = '## Grooming Validation Slice',
): string {
  const lines: string[] = [
    heading,
    '',
    `- Task: ${data.task.title} (${data.task.type}, ${data.task.status}) — ${data.task.url}`,
    `- size_check seed: ${data.sizeCheckSeed.files} files affected (${data.sizeCheckSeed.loc_method})`,
    `- type_check: ${data.typeCheck.decision}${data.typeCheck.signals?.length ? ` — ${data.typeCheck.signals.join('; ')}` : ''}`,
    `- Binding constraints: ${data.bindingConstraints.length ? data.bindingConstraints.join(', ') : '(none)'}`,
  ];
  // Store-sourced architecture is task-scoped (region-intersected + active
  // invariants) — small enough to inline. The Notion branch's archUnits
  // mirror the milestone's whole fixed context-page set, which is exactly
  // the milestone-wide dump this digest is constrained to exclude (see
  // `deriveGroomDigestSlice`'s doc comment) — pre-migration behaviour never
  // inlined it here either, so leave the digest unchanged on that branch.
  if (data.archSource === 'store') {
    lines.push(
      `- Arch-store-selected units (${data.archUnits.length}): ${data.archUnits.length ? data.archUnits.map((u) => u.title).join(', ') : '(none)'}`,
    );
  }
  const hasResolvedRegions =
    data.regions.packages.length > 0 || data.regions.files.length > 0;
  const hasPlanned = data.regions.planned.length > 0;
  if (hasResolvedRegions) {
    lines.push(
      `- Code regions: packages: ${data.regions.packages.length ? data.regions.packages.join(', ') : '(none)'}; files: ${data.regions.files.length ? data.regions.files.join(', ') : '(none)'}`,
    );
    if (hasPlanned) {
      lines.push(
        `- Planned (declared, not yet created): ${data.regions.planned.map((p) => `${p.path}${p.package ? ` → nearest ${p.package}` : ''}`).join(', ')}`,
      );
    }
  } else if (hasPlanned) {
    lines.push(
      `- Code regions: (none resolved) — planned (declared, not yet created): ${data.regions.planned.map((p) => `${p.path}${p.package ? ` → nearest ${p.package}` : ''}`).join(', ')}`,
    );
  } else {
    lines.push(...renderExplorationDirective(data.orientation));
  }
  if (data.readinessViolations.length) {
    lines.push('', '### Readiness violations', '');
    for (const v of data.readinessViolations) {
      lines.push(`- ${JSON.stringify(v)}`);
    }
  }
  if (data.dependencyCandidates) {
    lines.push(
      '',
      '### Dependency candidates',
      '',
      `- Declared: ${data.dependencyCandidates.declaredDeps.length ? data.dependencyCandidates.declaredDeps.join(', ') : '(none)'}`,
      `- Candidate blockers: ${data.dependencyCandidates.candidateBlockers.length ? JSON.stringify(data.dependencyCandidates.candidateBlockers) : '(none)'}`,
    );
  }
  lines.push('', '### Task body', '', data.body || '(empty)');
  return lines.join('\n');
}

function renderDesignDigest(data: DesignDigestSlice): string {
  const lines: string[] = [
    '## Design Investigation Slice',
    '',
    `- Task: ${data.task.title} (${data.task.type}, ${data.task.status}) — ${data.task.url}`,
    `- Open questions (${data.openQuestions.source}): ${data.openQuestions.items.length ? data.openQuestions.items.length : 0}`,
  ];
  for (const q of data.openQuestions.items) {
    lines.push(`  - ${q}`);
  }
  lines.push(
    '',
    data.archSource === 'store'
      ? `### Arch-store-selected units (${data.archUnits.length})`
      : `### Notion architecture pages referenced (${data.archUnits.length})`,
    '',
    ...data.archUnits.map((u) => `- ${u.title} (${u.id})`),
  );
  if (data.unresolvedPageRefs.length) {
    lines.push(
      '',
      '### Unresolved page references',
      '',
      ...data.unresolvedPageRefs.map((p) => `- ${p.title}`),
    );
  }
  lines.push(
    '',
    data.hasCodeMapGrounding
      ? '_Code-map grounding is cached for this milestone — fetch it via GET /api/design-context on demand._'
      : '_No code-map grounding cached yet for this milestone._',
  );
  return lines.join('\n');
}

function renderOpsDigest(data: OpsDigestSlice): string {
  const lines: string[] = [
    '## Ops Journal Slice',
    '',
    `- Task: ${data.task.title} (${data.task.type}, ${data.task.mode}) — ${data.task.url}`,
    `- Depends On: ${data.task.dependsOn.length ? data.task.dependsOn.join(', ') : '(none)'}`,
    `- Dep status: ${data.task.depStatus}`,
  ];
  lines.push(
    '',
    '### Existing ops_journal entry',
    '',
    data.journalEntry
      ? `\`\`\`json\n${JSON.stringify(data.journalEntry, null, 2)}\n\`\`\``
      : '_No prior entry — this is a fresh pass._',
  );
  return lines.join('\n');
}

/** Same slice/renderer as grooming's, under a heading that names it as the split candidate's slice. */
function renderSplitDigest(data: SplitDigestSlice): string {
  return renderGroomDigest(data, '## Split Candidate Slice');
}

function renderDigest(digest: PlanningDigest): string {
  switch (digest.workflow) {
    case 'groom':
      return renderGroomDigest(digest.data);
    case 'design':
      return renderDesignDigest(digest.data);
    case 'ops':
      return renderOpsDigest(digest.data);
    case 'split':
      return renderSplitDigest(digest.data);
  }
}

// ─── composer ───────────────────────────────────────────────────────────────

export interface AssemblePlanningProcedureParams {
  taskName: string;
  taskUrl: string;
  digest: PlanningDigest;
  /** The milestone this dispatched session operates under, surfaced verbatim
   *  in the Transport section so the session never greps its own prompt file
   *  for it. */
  milestoneId: string;
  /** The project this dispatched session operates under, surfaced verbatim
   *  in the Transport section for the same reason. */
  projectId: string;
}

/**
 * Compose the full injected planning-procedure prompt: skeleton + per-kind
 * procedure core + per-type digest, in that order. This is the string
 * written to the dispatched session's appended-prompt file.
 */
export function assemblePlanningProcedure(
  params: AssemblePlanningProcedureParams,
): string {
  const { taskName, taskUrl, digest, milestoneId, projectId } = params;
  const sections = [
    renderSkeleton(digest.workflow, taskName, taskUrl, milestoneId, projectId),
    renderProcedureCore(digest.workflow),
    renderDigest(digest),
  ];
  return sections.join('\n\n---\n\n');
}
